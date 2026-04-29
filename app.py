"""
Open SEO Crawler — a fast, concurrent SEO-focused web crawler.

Single-file Flask app. Run with:
    python3 app.py
Then open http://localhost:5002/

Features:
  - Concurrent threaded crawl with per-host politeness
  - CMS detection (Shopify, WordPress + Yoast/Rank Math, Webflow, Wix, Squarespace, etc.)
  - Retry on 429 / 5xx / connection errors with exponential backoff
  - Duplicate title / meta / H1 / body detection
  - Orphan page detection (sitemap vs crawled URLs)
  - Redirect chain detection
  - Severity-tagged issues (error / warning / info) with source citations
  - Optional JS rendering via Playwright (install separately)
"""
from flask import Flask, render_template, request, Response, stream_with_context, jsonify
import requests
import json
import os
import re as _re
import time
import logging
import threading
from collections import deque, defaultdict as _dd
from urllib.parse import urlparse, urljoin, urlunparse, parse_qs, urlencode
from bs4 import BeautifulSoup

app = Flask(__name__, static_folder='static', template_folder='templates')
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')

# crawl_id -> {'include': [patterns], 'exclude': [patterns]}. Workers read on
# every URL so the Apply button can mutate rules mid-crawl. Replace list refs
# atomically (do not mutate in place) so concurrent readers see a consistent
# snapshot. Cleared when the crawl ends.
ACTIVE_CRAWL_RULES = {}


def _robots_pattern_match(pattern, url):
    """robots.txt-style path pattern matcher (Google's spec).

    Wildcards: ``*`` matches any sequence, ``$`` at end anchors end of URL.
    Everything else is literal — including ``?``. Match is anchored at the
    start of the path; a leading ``*`` lets it match anywhere. Tests path+query
    first, then full URL so users can paste either form.
    """
    if not pattern:
        return False
    p = pattern.strip()
    if not p:
        return False
    end_anchor = p.endswith('$')
    if end_anchor:
        p = p[:-1]
    rx = '.*'.join(_re.escape(part) for part in p.split('*'))
    if end_anchor:
        rx += r'\Z'
    rx = '^' + rx
    try:
        prog = _re.compile(rx)
    except _re.error:
        return False
    parsed = urlparse(url)
    path_q = parsed.path + (('?' + parsed.query) if parsed.query else '')
    if prog.match(path_q):
        return True
    if prog.match(url):
        return True
    return False


_DUP_NOISE_PARAMS = frozenset({
    'add-to-cart', 'replytocom', 'fbclid', 'gclid', 'gad_source', 'gbraid',
    'wbraid', 'mc_cid', 'mc_eid', '_ga', 'msclkid', 'yclid', 'dclid',
    'igshid', 'srsltid', 'ref', 'ref_src', 'ref_url',
    # WooCommerce SWOOF / product filter plugins — ?swoof=1&pa_cube-size=28mm
    # &product_cat=drawer&really_curr_tax=63-product_cat etc. Each combination
    # is a separate URL but renders the same template; collapsing them stops
    # filter permutations from polluting duplicate-meta/title groups.
    'swoof', 'really_curr_tax', 'product_cat', 'product_tag',
    'orderby', 'min_price', 'max_price', 'rating_filter', 'filter_size',
    'filter_color',
})


def _normalize_url_for_dup(url):
    """Collapse pagination + tracking/ecommerce params so duplicate-meta
    grouping doesn't fragment a canonical page across its variants."""
    if not url:
        return url
    try:
        parsed = urlparse(url)
    except Exception:
        return url
    path = parsed.path or '/'
    path = _re.sub(r'/page/\d+/?$', '/', path)
    path = _re.sub(r'/comment-page-\d+/?$', '/', path)
    if parsed.query:
        kept = []
        for kv in parsed.query.split('&'):
            if not kv:
                continue
            k = kv.split('=', 1)[0].lower()
            if (k in _DUP_NOISE_PARAMS
                    or k.startswith('utm_')
                    or k.startswith('pa_')              # WC product attribute filters
                    or k.startswith('filter_')          # generic filter params
                    or k.startswith('swoof_')):         # SWOOF internal params
                continue
            kept.append(kv)
        new_q = '&'.join(kept)
    else:
        new_q = ''
    return urlunparse((parsed.scheme, parsed.netloc, path, parsed.params, new_q, ''))


STATIC_VERSION = str(int(time.time()))


@app.route('/')
def index():
    return render_template('index.html', v=STATIC_VERSION)


# =============================================================================
# CMS detection + per-CMS profiles
# =============================================================================
CMS_PROFILES = {
    'shopify': {
        'label': 'Shopify',
        'exclude_patterns': [
            '*?variant=*', '*&variant=*',
            '*/cart', '*/cart/*',
            '*/account*',
            '*/challenge',
            '*/policies/*',
            '*srsltid=*',
            '*/cdn/shop/*',
            '*/collections/*/products/*',  # duplicate products nested under collections
        ],
        'suggested_settings': {'render_js': False, 'max_workers': 5},
        'schema_warnings': [
            'OnlineStore schema without a visible physical address triggers Google validation warnings — prefer plain Organization.',
            'Shopify themes often auto-emit Organization + WebSite schema; check for duplication before adding custom blocks.',
        ],
        'tips': [
            'Shopify uses /search?q= — valid SearchAction target.',
            'Watch for ?variant= and ?srsltid= duplicate URLs.',
        ],
    },
    'wordpress': {
        'label': 'WordPress',
        'exclude_patterns': [
            '*/wp-admin/*', '*/wp-json/*', '*/wp-includes/*',
            '*/wp-content/uploads/*',
            '*/feed/*', '*/feed', '*/?feed=*',
            '*/author/*', '*/tag/*',
            '*/comments/feed*', '*/trackback*',
            '*?p=*', '*?replytocom=*', '*?unapproved=*',
            '*/xmlrpc.php',
        ],
        'suggested_settings': {'render_js': False, 'max_workers': 3},
        'schema_warnings': [],
        'tips': [
            'WordPress on shared hosting can throttle under load — reduce workers to 2-3 on fragile sites.',
            'Author, tag, and feed URLs rarely deserve indexing.',
        ],
    },
    'wordpress_yoast': {
        'label': 'WordPress + Yoast SEO',
        'exclude_patterns': [
            '*/wp-admin/*', '*/wp-json/*', '*/wp-includes/*',
            '*/wp-content/uploads/*',
            '*/feed/*', '*/feed', '*/?feed=*',
            '*/author/*', '*/tag/*',
            '*/comments/feed*', '*/trackback*',
            '*?p=*', '*?replytocom=*',
        ],
        'suggested_settings': {'render_js': False, 'max_workers': 3},
        'schema_warnings': [
            'Yoast auto-emits an @graph with Organization, WebSite, WebPage, Article, BreadcrumbList. Do NOT duplicate these in custom schema blocks.',
            'Yoast can also emit FAQPage if the FAQ block is used — audit before writing your own FAQPage.',
        ],
        'tips': [
            'If you\'re adding custom schema, put it in a new @graph node with distinct @id values.',
        ],
    },
    'wordpress_rankmath': {
        'label': 'WordPress + Rank Math',
        'exclude_patterns': [
            '*/wp-admin/*', '*/wp-json/*', '*/wp-includes/*',
            '*/wp-content/uploads/*',
            '*/feed/*', '*/feed', '*/?feed=*',
            '*/author/*', '*/tag/*',
            '*/comments/feed*', '*/trackback*',
            '*?p=*', '*?replytocom=*',
        ],
        'suggested_settings': {'render_js': False, 'max_workers': 3},
        'schema_warnings': [
            'Rank Math auto-emits Organization, WebSite, WebPage, BreadcrumbList. Check before adding custom blocks.',
        ],
        'tips': [],
    },
    'webflow': {
        'label': 'Webflow',
        'exclude_patterns': [],
        'suggested_settings': {'render_js': False, 'max_workers': 5},
        'schema_warnings': [],
        'tips': [
            'Webflow handles trailing slashes at the server — confirm redirect behaviour is consistent.',
        ],
    },
    'wix': {
        'label': 'Wix',
        'exclude_patterns': [],
        'suggested_settings': {'render_js': True, 'max_workers': 1},
        'schema_warnings': [],
        'tips': [
            'Wix is heavily client-side rendered — enable Render JS or the link graph will be incomplete.',
        ],
    },
    'squarespace': {
        'label': 'Squarespace',
        'exclude_patterns': [],
        'suggested_settings': {'render_js': True, 'max_workers': 3},
        'schema_warnings': [],
        'tips': [
            'Squarespace injects nav client-side — enable Render JS to discover all pages.',
            'Meta title template is "<page title> — <site title>" by default.',
        ],
    },
    'kajabi': {
        'label': 'Kajabi',
        'exclude_patterns': ['*/my-library*', '*/offers/*', '*/checkouts/*'],
        'suggested_settings': {'render_js': False, 'max_workers': 3},
        'schema_warnings': [],
        'tips': [
            'Kajabi lays out testimonials deep in the DOM — review word counts manually for sales pages.',
        ],
    },
    'ghost': {
        'label': 'Ghost',
        'exclude_patterns': ['*/ghost/*', '*/rss/*', '*/amp/*'],
        'suggested_settings': {'render_js': False, 'max_workers': 5},
        'schema_warnings': [],
        'tips': [],
    },
    'drupal': {
        'label': 'Drupal',
        'exclude_patterns': ['*/user/*', '*/node/add/*', '*/taxonomy/*', '*/admin/*'],
        'suggested_settings': {'render_js': False, 'max_workers': 3},
        'schema_warnings': [],
        'tips': [],
    },
    'hubspot': {
        'label': 'HubSpot CMS',
        'exclude_patterns': ['*/_hcms/*', '*/hs-fs/*'],
        'suggested_settings': {'render_js': False, 'max_workers': 5},
        'schema_warnings': [],
        'tips': [],
    },
    'joomla': {
        'label': 'Joomla',
        'exclude_patterns': ['*/administrator/*'],
        'suggested_settings': {'render_js': False, 'max_workers': 3},
        'schema_warnings': [],
        'tips': [],
    },
}


def detect_cms(url, html=None, headers=None):
    """Identify the CMS (and SEO plugin if any) from the HTML + response headers.

    Returns {'cms': key, 'label': str, 'confidence': 'high|medium|low', 'signals': [str]}
    or {'cms': None, ...} if nothing recognisable is found.
    """
    headers = {k.lower(): (v or '') for k, v in (headers or {}).items()}
    html_sample = (html or '')[:80000]  # cap scan to first 80kb — fingerprints live in <head>
    lower = html_sample.lower()
    signals = []
    confidence = 'low'

    def meta_generator():
        m = _re.search(r'<meta[^>]+name=["\']generator["\'][^>]+content=["\']([^"\']+)["\']', html_sample, _re.I)
        return m.group(1) if m else ''

    gen = meta_generator()
    gen_lower = gen.lower()

    # --- High-confidence header/meta matches ---
    if 'x-shopify-stage' in headers or 'x-shopid' in headers or 'cdn.shopify.com' in lower or '/cdn/shop/' in lower:
        signals.append('Shopify CDN / header fingerprint')
        return {'cms': 'shopify', 'label': CMS_PROFILES['shopify']['label'], 'confidence': 'high', 'signals': signals}
    if 'x-wix-request-id' in headers or 'wix.com' in headers.get('x-powered-by', '').lower() or 'wixsite.com' in lower or gen_lower.startswith('wix.com'):
        signals.append('Wix header / generator fingerprint')
        return {'cms': 'wix', 'label': CMS_PROFILES['wix']['label'], 'confidence': 'high', 'signals': signals}
    if 'squarespace' in headers.get('server', '').lower() or 'static1.squarespace.com' in lower or 'squarespace-cdn.com' in lower or gen_lower.startswith('squarespace'):
        signals.append('Squarespace CDN / server fingerprint')
        return {'cms': 'squarespace', 'label': CMS_PROFILES['squarespace']['label'], 'confidence': 'high', 'signals': signals}

    # Webflow
    if 'webflow.com' in lower or _re.search(r'<html[^>]+data-wf-', html_sample) or gen_lower.startswith('webflow'):
        signals.append('Webflow generator / data-wf-* attributes')
        return {'cms': 'webflow', 'label': CMS_PROFILES['webflow']['label'], 'confidence': 'high', 'signals': signals}

    # Kajabi
    if 'kajabi-storefronts-production' in lower or gen_lower.startswith('kajabi'):
        signals.append('Kajabi storefront assets')
        return {'cms': 'kajabi', 'label': CMS_PROFILES['kajabi']['label'], 'confidence': 'high', 'signals': signals}

    # Ghost
    if gen_lower.startswith('ghost') or '/ghost/' in lower or headers.get('x-powered-by', '').lower().startswith('ghost'):
        signals.append('Ghost generator / admin path')
        return {'cms': 'ghost', 'label': CMS_PROFILES['ghost']['label'], 'confidence': 'high', 'signals': signals}

    # HubSpot
    if 'hs-scripts.com' in lower or 'hubspot.net' in lower or 'hubspotusercontent' in lower or gen_lower.startswith('hubspot'):
        signals.append('HubSpot asset CDN')
        return {'cms': 'hubspot', 'label': CMS_PROFILES['hubspot']['label'], 'confidence': 'high', 'signals': signals}

    # Drupal
    if gen_lower.startswith('drupal') or 'x-generator' in headers and 'drupal' in headers['x-generator'].lower() or '/sites/default/files/' in lower:
        signals.append('Drupal generator / asset path')
        return {'cms': 'drupal', 'label': CMS_PROFILES['drupal']['label'], 'confidence': 'high', 'signals': signals}

    # Joomla
    if gen_lower.startswith('joomla'):
        signals.append('Joomla generator meta')
        return {'cms': 'joomla', 'label': CMS_PROFILES['joomla']['label'], 'confidence': 'high', 'signals': signals}

    # --- WordPress detection (+ SEO plugin) ---
    wp_signals = []
    if 'wp-content' in lower or '/wp-includes/' in lower: wp_signals.append('wp-content / wp-includes asset path')
    if '/wp-json/' in lower: wp_signals.append('WordPress REST API link')
    if gen_lower.startswith('wordpress'): wp_signals.append(f'generator: {gen}')
    if headers.get('x-powered-by', '').lower().startswith('wordpress'): wp_signals.append('X-Powered-By: WordPress')
    if wp_signals:
        signals.extend(wp_signals)
        # SEO plugin fingerprints
        if _re.search(r'yoast seo', lower) or 'yoast.com' in lower or _re.search(r'yoast-schema-graph', lower):
            signals.append('Yoast SEO detected')
            return {'cms': 'wordpress_yoast', 'label': CMS_PROFILES['wordpress_yoast']['label'], 'confidence': 'high', 'signals': signals}
        if _re.search(r'rank math', lower) or 'rankmath' in lower:
            signals.append('Rank Math detected')
            return {'cms': 'wordpress_rankmath', 'label': CMS_PROFILES['wordpress_rankmath']['label'], 'confidence': 'high', 'signals': signals}
        return {'cms': 'wordpress', 'label': CMS_PROFILES['wordpress']['label'], 'confidence': 'high', 'signals': signals}

    return {'cms': None, 'label': 'Unknown / custom', 'confidence': 'low', 'signals': []}


@app.route('/detect-cms', methods=['POST'])
def detect_cms_route():
    """Fetch a URL and identify the CMS. Used standalone and also at crawl start."""
    data = request.json or {}
    url = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'URL required'}), 400
    if not url.startswith('http'):
        url = 'https://' + url
    try:
        resp = requests.get(url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36'
        })
        result = detect_cms(url, resp.text, dict(resp.headers))
        if result.get('cms'):
            prof = CMS_PROFILES.get(result['cms'], {})
            result['profile'] = {
                'exclude_patterns': prof.get('exclude_patterns', []),
                'suggested_settings': prof.get('suggested_settings', {}),
                'schema_warnings': prof.get('schema_warnings', []),
                'tips': prof.get('tips', []),
            }
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': f'Detection failed: {str(e)[:100]}'}), 500

_CRAWL_NOISE_PARAMS = frozenset({
    # Tracking
    'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'gad_source', 'gbraid', 'wbraid',
    'msclkid', 'yclid', 'dclid', 'igshid', 'srsltid',
    'ref', 'ref_src', 'ref_url',
    # WooCommerce action endpoints — not real pages.
    'add-to-cart', 'remove_item', 'removed_item', 'undo_item',
    'wc-ajax', 'wc-api', 'wcml_currency', 'orderby', 'product-page',
    'min_price', 'max_price',
    # Other common ecommerce/forum noise
    'replytocom', 'unapproved', 'moderation-hash',
    'share', 'sharesource',
})


def _normalize_crawl_url(url):
    """Normalize URL for deduplication: strip fragments, utm/tracking/action
    params, lowercase host.

    Strips WooCommerce action endpoints (?add-to-cart=, ?wc-ajax= …) so
    every product page's "Add to cart" button doesn't surface as its own
    URL with no meta description.
    """
    from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
    parsed = urlparse(url)
    path = parsed.path or '/'
    if parsed.query:
        params = parse_qs(parsed.query, keep_blank_values=True)
        cleaned = {
            k: v for k, v in params.items()
            if not k.lower().startswith('utm_')
            and k.lower() not in _CRAWL_NOISE_PARAMS
        }
        query = urlencode(cleaned, doseq=True)
    else:
        query = ''
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), path, '', query, ''))


def _crawl_slash_alt(url):
    """Return the slash-toggled variant of a URL for dedup, or None if not applicable."""
    from urllib.parse import urlparse, urlunparse
    p = urlparse(url)
    path = p.path
    last_seg = path.rstrip('/').split('/')[-1]
    if '.' in last_seg:
        return None
    if path.endswith('/') and path != '/':
        alt_path = path.rstrip('/')
    else:
        alt_path = path + '/'
    return urlunparse((p.scheme, p.netloc, alt_path, p.params, p.query, p.fragment))


def _detect_js_platform(html):
    """Cheap signature check for JS-rendered platforms. Returns a human-
    readable platform name or None.

    Used to tell the user "this site needs Render JS" instead of firing a
    misleading "No analytics detected" issue when the crawler saw only the
    unhydrated HTML shell.
    """
    if not html:
        return None
    sample = html[:200_000]  # enough for <head> + top of <body>
    checks = [
        ('Wix',         [r'static\.parastorage\.com', r'wix\.com/thunderbolt', r'wixCIDX', r'<html[^>]*wix']),
        ('Shopify',     [r'cdn\.shopify\.com', r'Shopify\.shop', r'shopify-features']),
        ('Squarespace', [r'static1\.squarespace\.com', r'squarespace-cdn\.com', r'Squarespace\.Constants']),
        ('Webflow',     [r'uploads-ssl\.webflow\.com', r'data-wf-page', r'webflow\.js']),
        ('Next.js',     [r'id="__next"', r'__NEXT_DATA__']),
        ('Nuxt',        [r'id="__nuxt"', r'window\.__NUXT__']),
        ('Gatsby',      [r'id="___gatsby"']),
        ('React SPA',   [r'<div[^>]+id="root"[^>]*></div>\s*<script']),
        ('Vue SPA',     [r'<div[^>]+id="app"[^>]*></div>\s*<script']),
    ]
    import re as _re_local
    for name, patterns in checks:
        for pat in patterns:
            if _re_local.search(pat, sample, _re_local.I):
                return name
    return None


def _crawl_page(url, session, domain, pw_page=None, ignore_noindex=False):
    """Crawl a single page and return audit data dict.

    If ``pw_page`` (a live Playwright page) is provided, the HTML body will be
    re-fetched via a headless browser so JS-rendered content is captured. We
    still do the initial ``requests.get`` to get response headers / redirect
    history cheaply and reliably.
    """
    from urllib.parse import urlparse, urljoin
    result = {
        'url': url, 'status_code': 0, 'content_type': '', 'response_time': 0,
        'title': '', 'title_len': 0, 'meta_description': '', 'meta_len': 0,
        'h1': '', 'h1_list': [], 'h2_list': [], 'h2_count': 0,
        'canonical': '', 'canonical_match': False, 'canonical_kind': None,
        'word_count': 0, 'internal_links': 0, 'external_links': 0,
        'internal_link_urls': [], 'images_total': 0, 'images_no_alt': 0,
        'schema_types': [], 'indexable': True, 'is_pagination': False, 'issues': [], 'error': None,
        'depth': 0, 'redirect_url': None, 'redirect_kind': None,
        'redirect_hops': 0, 'redirect_chain': [],
        'body_hash': '', 'security': {}, 'mixed_content': [],
        'url_issues': [], 'hreflang': [], 'x_robots_tag': '',
        'og_tags': {}, 'twitter_tags': {}, 'analytics': [],
    }

    try:
        # Retry loop for transient failures (5xx, 429, connection errors).
        # 403 gets a UA-fallback instead of a delay-and-retry, because 403 is
        # usually bot-fingerprint detection rather than a rate limit.
        resp = None
        retries_done = 0
        last_exc = None
        for attempt in range(3):  # 1 primary + 2 retries
            try:
                resp = session.get(url, timeout=15, allow_redirects=True)
                last_exc = None
            except requests.exceptions.RequestException as e:
                last_exc = e
                resp = None
            # Decide whether to retry, fall back UA, or accept the response.
            if resp is not None:
                if resp.status_code == 429:
                    # Respect Retry-After header if present, else exponential wait.
                    ra = resp.headers.get('Retry-After', '').strip()
                    try: wait = float(ra) if ra else 2 * (2 ** attempt)
                    except ValueError: wait = 2 * (2 ** attempt)
                    wait = min(wait, 10)
                    if attempt < 2:
                        retries_done += 1
                        time.sleep(wait)
                        continue
                elif 500 <= resp.status_code < 600:
                    if attempt < 2:
                        retries_done += 1
                        time.sleep(0.5 * (2 ** attempt))  # 0.5s, 1s, 2s
                        continue
                elif resp.status_code == 403:
                    # One UA-swap attempt to dodge Cloudflare-style fingerprinting.
                    # Only swap UA on the first attempt so we don't keep cycling.
                    if attempt == 0:
                        for _alt_ua in (
                            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
                            'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
                        ):
                            try:
                                alt = session.get(url, timeout=15, allow_redirects=True,
                                                  headers={'User-Agent': _alt_ua})
                                if alt.status_code not in (403, 429):
                                    resp = alt
                                    result['ua_fallback'] = _alt_ua.split(')')[0] + ')'
                                    break
                            except Exception:
                                continue
                # Response is either final (2xx/3xx/4xx non-403/429) or exhausted retries.
                break
            # resp is None → transient connection error → retry with backoff
            if attempt < 2:
                retries_done += 1
                time.sleep(0.5 * (2 ** attempt))
                continue
        if resp is None:
            # All retries exhausted
            raise last_exc if last_exc else requests.exceptions.RequestException('Connection failed after retries')
        result['retries'] = retries_done
        result['status_code'] = resp.status_code
        result['response_time'] = round(resp.elapsed.total_seconds(), 2)
        result['content_type'] = resp.headers.get('Content-Type', '')[:50]

        # Track redirects — classify by type so trivial normalizations (trailing slash,
        # www, https) don't pollute the main Redirect bucket
        if resp.history:
            result['redirect_url'] = resp.url
            from urllib.parse import urlparse as _up
            orig = _up(url)
            final = _up(resp.url)
            hops = len(resp.history)
            hop_lbl = f'{hops} hop{"s" if hops > 1 else ""}'
            result['redirect_hops'] = hops
            result['redirect_chain'] = [
                {'url': h.url, 'status': h.status_code} for h in resp.history
            ] + [{'url': resp.url, 'status': resp.status_code}]

            same_host = orig.netloc.lstrip('www.') == final.netloc.lstrip('www.')
            same_path_stripped = orig.path.rstrip('/') == final.path.rstrip('/')
            same_qs = orig.query == final.query

            redirect_kind = 'other'
            if same_host and same_path_stripped and same_qs:
                if orig.scheme != final.scheme and orig.scheme == 'http':
                    redirect_kind = 'http_to_https'
                    result['issues'].append(f'HTTP→HTTPS redirect ({hop_lbl})')
                elif orig.netloc != final.netloc:
                    redirect_kind = 'www_normalize'
                    result['issues'].append(f'www normalization redirect ({hop_lbl})')
                elif orig.path != final.path:
                    # Pure trailing slash difference
                    if final.path == orig.path + '/' or orig.path == final.path + '/':
                        redirect_kind = 'trailing_slash'
                        result['issues'].append(f'Trailing slash redirect ({hop_lbl})')
                    else:
                        redirect_kind = 'other'
                        result['issues'].append(f'Redirect ({hop_lbl})')
                else:
                    redirect_kind = 'other'
                    result['issues'].append(f'Redirect ({hop_lbl})')
            else:
                result['issues'].append(f'Redirect ({hop_lbl})')

            result['redirect_kind'] = redirect_kind

        # --- URL issues (from the source URL, not redirect target) ---
        from urllib.parse import urlparse as _urlparse2
        _parsed_url = _urlparse2(url)
        _url_path_query = _parsed_url.path + (('?' + _parsed_url.query) if _parsed_url.query else '')
        _url_issues = []
        if any(c.isupper() for c in _parsed_url.path):
            _url_issues.append('uppercase')
        if '_' in _parsed_url.path:
            _url_issues.append('underscores')
        if ' ' in url or '%20' in _parsed_url.path:
            _url_issues.append('contains space')
        if len(url) > 115:
            _url_issues.append(f'over 115 chars ({len(url)})')
        if '//' in _parsed_url.path:
            _url_issues.append('multiple slashes')
        try:
            url.encode('ascii')
        except UnicodeEncodeError:
            _url_issues.append('non-ASCII characters')
        if _parsed_url.query:
            _url_issues.append('contains parameters')
            if any(p in _parsed_url.query for p in ('utm_', 'gclid=', 'fbclid=')):
                _url_issues.append('tracking parameters')
        result['url_issues'] = _url_issues

        # --- Pagination detection ---
        import re as _re_pag
        _pag_path = _re_pag.search(r'/page/\d+/?$', _parsed_url.path)
        _pag_query = _re_pag.search(r'\b(page|paged|pg)\s*=\s*[2-9]\d*', _parsed_url.query)
        result['is_pagination'] = bool(_pag_path or _pag_query)

        # --- Security headers (applies to every response, HTML or not) ---
        hdrs = {k.lower(): v for k, v in resp.headers.items()}
        sec = {
            'hsts': 'strict-transport-security' in hdrs,
            'csp': 'content-security-policy' in hdrs,
            'x_content_type_options': 'x-content-type-options' in hdrs,
            'x_frame_options': 'x-frame-options' in hdrs,
            'referrer_policy': 'referrer-policy' in hdrs,
            'is_https': _parsed_url.scheme == 'https',
        }
        result['security'] = sec
        result['x_robots_tag'] = hdrs.get('x-robots-tag', '')
        if result['x_robots_tag'] and 'noindex' in result['x_robots_tag'].lower():
            result['indexable'] = False

        if resp.status_code >= 400:
            result['error'] = f'HTTP {resp.status_code}'
            result['issues'].append(f'HTTP {resp.status_code} error')
            return result

        # Skip non-HTML
        ctype = result['content_type'].lower()
        if 'text/html' not in ctype and 'application/xhtml' not in ctype:
            result['issues'].append(f'Non-HTML ({ctype.split(";")[0]})')
            return result

        # Limit body size
        raw_html = resp.text[:5_000_000]
        result['js_rendered'] = False

        # Optional: re-render with Playwright to capture JS-inserted content.
        # Strategy: wait for `load` (fires after all initial subresources), then
        # try (but don't require) networkidle as a short grace window so late
        # analytics scripts (GA4, GTM, FB Pixel) can inject. Wix/Shopify/React
        # SPAs often ping telemetry continuously, so networkidle never settles —
        # we still read .content() regardless so we don't fall back to the
        # empty pre-JS HTML. That silent fallback was why "No analytics
        # detected" fired on JS-rendered sites like Wix.
        if pw_page is not None and ('text/html' in ctype or 'application/xhtml' in ctype):
            try:
                pw_page.goto(resp.url, wait_until='load', timeout=20000)
            except Exception as e:
                # Even if goto times out, the page may have loaded enough of
                # the DOM to be useful — keep going and let content() decide.
                result.setdefault('render_errors', []).append(f'goto: {str(e)[:160]}')
            # Best-effort settle window for late-injected trackers
            try:
                pw_page.wait_for_load_state('networkidle', timeout=4000)
            except Exception:
                pass
            try:
                rendered = pw_page.content()
                if rendered and len(rendered) > 100:
                    raw_html = rendered[:5_000_000]
                    result['js_rendered'] = True
            except Exception as e:
                result.setdefault('render_errors', []).append(f'content: {str(e)[:160]}')

        soup = BeautifulSoup(raw_html, 'html.parser')

        # Title
        title_tag = soup.find('title')
        result['title'] = title_tag.get_text(strip=True) if title_tag else ''
        result['title_len'] = len(result['title'])

        # Meta description
        meta_tag = soup.find('meta', attrs={'name': 'description'})
        result['meta_description'] = meta_tag.get('content', '') if meta_tag else ''
        result['meta_len'] = len(result['meta_description'])

        # H1s and H2s (full lists, not just first/count)
        h1_tags = soup.find_all('h1')
        result['h1_list'] = [t.get_text(strip=True)[:200] for t in h1_tags]
        result['h1'] = result['h1_list'][0] if result['h1_list'] else ''
        h2_tags = soup.find_all('h2')
        result['h2_list'] = [t.get_text(strip=True)[:200] for t in h2_tags][:20]
        result['h2_count'] = len(h2_tags)

        # Canonical — classify as self / canonicalised / mismatch
        can_tag = soup.find('link', attrs={'rel': 'canonical'})
        result['canonical'] = can_tag.get('href', '') if can_tag else ''
        if result['canonical']:
            can_abs = urljoin(url, result['canonical'])
            same = can_abs.rstrip('/') == url.rstrip('/') or can_abs.rstrip('/') == resp.url.rstrip('/')
            result['canonical_match'] = same
            if same:
                result['canonical_kind'] = 'self'
            else:
                # canonical points elsewhere — that's a canonicalised page
                result['canonical_kind'] = 'canonicalised'
        else:
            result['canonical_match'] = False
            result['canonical_kind'] = 'missing'

        # Hreflang annotations
        for ln in soup.find_all('link', attrs={'rel': 'alternate'}):
            hl = ln.get('hreflang')
            hf = ln.get('href')
            if hl and hf:
                result['hreflang'].append({'lang': hl, 'href': urljoin(url, hf)})

        # Schema types — schema.org @type can be a single string or a list
        # ("@type": ["Service", "LocalBusiness"]). Flatten to individual
        # strings so the client receives list[str] and rendering doesn't
        # choke on a nested array element.
        def _push_type(val):
            if isinstance(val, list):
                for v in val:
                    if isinstance(v, str):
                        result['schema_types'].append(v)
            elif isinstance(val, str):
                result['schema_types'].append(val)
        for script in soup.find_all('script', attrs={'type': 'application/ld+json'}):
            try:
                ld = json.loads(script.string or '')
                if isinstance(ld, dict):
                    if '@type' in ld:
                        _push_type(ld['@type'])
                    if '@graph' in ld:
                        for item in ld['@graph']:
                            if isinstance(item, dict) and '@type' in item:
                                _push_type(item['@type'])
                elif isinstance(ld, list):
                    for item in ld:
                        if isinstance(item, dict) and '@type' in item:
                            _push_type(item['@type'])
            except Exception:
                pass

        # Open Graph and Twitter Card tags
        for m in soup.find_all('meta'):
            prop = m.get('property', '') or ''
            nm = m.get('name', '') or ''
            content = m.get('content', '') or ''
            if prop.startswith('og:') and content:
                result['og_tags'][prop[3:]] = content[:500]
            elif nm.startswith('twitter:') and content:
                result['twitter_tags'][nm[8:]] = content[:500]

        # Analytics / tracking pixels — inspect script srcs + inline JS
        # Each entry: (label, list of regex patterns to search anywhere in the HTML)
        _TRACKERS = [
            ('GA4',               [r'gtag/js\?id=G-', r"gtag\(\s*'config'\s*,\s*'G-"]),
            ('Universal Analytics', [r'google-analytics\.com/analytics\.js', r"'UA-\d+", r'ua-\d+-\d+']),
            ('Google Tag Manager', [r'googletagmanager\.com/gtm\.js', r"'GTM-[A-Z0-9]+'"]),
            ('Google Ads',        [r'googleadservices\.com/pagead/conversion', r'AW-\d+']),
            ('Facebook Pixel',    [r'connect\.facebook\.net/[^"\']*/fbevents\.js', r"fbq\s*\(\s*['\"]init"]),
            ('TikTok Pixel',      [r'analytics\.tiktok\.com/i18n/pixel']),
            ('LinkedIn Insight',  [r'snap\.licdn\.com/li\.lms-analytics']),
            ('Hotjar',            [r'static\.hotjar\.com/c/hotjar', r'hjSiteSettings', r'\(h,o,t,j,a,r\)']),
            ('Microsoft Clarity', [r'clarity\.ms/tag']),
            ('Mixpanel',          [r'cdn\.mxpnl\.com', r'mixpanel\.init']),
            ('Segment',           [r'cdn\.segment\.com/analytics', r'analytics\.load']),
            ('HubSpot',           [r'js\.hs-scripts\.com', r'js\.hs-analytics\.net']),
            ('Plausible',         [r'plausible\.io/js']),
            ('Fathom',            [r'cdn\.usefathom\.com']),
            ('Matomo/Piwik',      [r'matomo\.php', r'_paq\.push']),
            ('Crazy Egg',         [r'script\.crazyegg\.com']),
            ('Microsoft Ads UET', [r'bat\.bing\.com/bat\.js']),
            ('Pinterest Tag',     [r'pintrk\s*\(\s*[\'"]load']),
            ('Snapchat Pixel',    [r'sc-static\.net/scevent']),
        ]
        # Only scan the raw HTML once; much cheaper than re-traversing soup per pattern
        for label, patterns in _TRACKERS:
            for pat in patterns:
                if _re.search(pat, raw_html, _re.I):
                    result['analytics'].append(label)
                    break

        # Indexability
        robots_tag = soup.find('meta', attrs={'name': _re.compile(r'^robots$', _re.I)})
        robots_content = robots_tag.get('content', '').lower() if robots_tag else ''
        if 'noindex' in robots_content:
            result['indexable'] = False
            result['issues'].append('noindex')

        # Word count — strip nav/footer/script/style + class-based nav for
        # non-semantic sites (Elementor/Divi/WP themes that render nav inside
        # <div class="elementor-nav-menu">). Also prefer <main>/<article>
        # content when present so the body word count reflects actual content,
        # not menu/footer boilerplate (otherwise thin-content detection misfires).
        soup_body = BeautifulSoup(raw_html, 'html.parser')
        for tag in soup_body(['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript', 'form', 'svg']):
            tag.decompose()
        try:
            nav_like_re = _re.compile(
                r'(main[-_]?menu|primary[-_]?menu|site[-_]?nav|header[-_]?nav|'
                r'mega[-_]?menu|nav[-_]?menu|top[-_]?menu|mobile[-_]?menu|sub[-_]?menu|'
                r'breadcrumb|footer[-_]?menu|site[-_]?header|site[-_]?footer|'
                r'menu[-_]?wrap|navbar|navigation|'
                r'elementor-nav-menu|elementor-menu|elementor-widget-nav-menu|'
                r'et_pb_menu|divi-menu|menu-item-has-children|\bmenu\b|'
                r'offcanvas|hamburger|dropdown-menu)',
                _re.I,
            )
            role_nav_re = _re.compile(r'^(navigation|menubar|menu)$', _re.I)
            for el in list(soup_body.find_all(['div', 'section', 'ul', 'aside'])):
                if not el.parent:
                    continue
                classes = ' '.join(el.get('class') or [])
                ident = el.get('id') or ''
                role = el.get('role') or ''
                aria = el.get('aria-label') or ''
                if (nav_like_re.search(classes) or nav_like_re.search(ident)
                        or role_nav_re.match(role) or nav_like_re.search(aria)):
                    el.decompose()
        except Exception:
            pass
        main_container = (
            soup_body.find('main')
            or soup_body.find(attrs={'role': 'main'})
            or soup_body.find('article')
            or soup_body.find(id=_re.compile(r'^(main|content|primary|page-content)$', _re.I))
            or soup_body.find(attrs={'class': _re.compile(r'(^|\s)(main-content|page-content|entry-content|post-content|article-content|site-main)(\s|$)', _re.I)})
        )
        text_root = main_container if main_container else soup_body
        body_text = text_root.get_text(separator=' ', strip=True)
        result['word_count'] = len(body_text.split()) if body_text else 0
        # Cap body text at 30k chars — sufficient for shingle-based near-dup
        # detection on any reasonable page; keeps the SSE payload bounded.
        result['body_text'] = (body_text[:30_000] if body_text else '')

        # Body hash for exact-duplicate detection — normalize whitespace first
        import hashlib as _hashlib
        _norm = ' '.join(body_text.lower().split())
        result['body_hash'] = _hashlib.md5(_norm.encode('utf-8', errors='ignore')).hexdigest() if _norm else ''

        # Mixed content: HTTPS page loading HTTP resources.
        # <link> is rel-dependent — most rels are pure metadata (rel="profile"
        # for XFN, rel="canonical", rel="alternate", rel="EditURI"/"pingback"/
        # "https://api.w.org/" for WP) and don't trigger any fetch. Browsers
        # only fire mixed-content warnings on the rels below.
        _MIXED_LINK_RELS = {
            'stylesheet',
            'preload', 'prefetch', 'modulepreload',
            'icon', 'shortcut icon', 'apple-touch-icon',
            'apple-touch-icon-precomposed', 'mask-icon', 'fluid-icon',
            'manifest',
        }
        if result.get('security', {}).get('is_https'):
            mixed = []
            for tag_name, attr in (('img', 'src'), ('script', 'src'),
                                    ('iframe', 'src'), ('video', 'src'),
                                    ('audio', 'src'), ('source', 'src')):
                for t in soup.find_all(tag_name, attrs={attr: True}):
                    v = (t.get(attr) or '').strip()
                    if v.startswith('http://'):
                        mixed.append(v)
            for t in soup.find_all('link', attrs={'href': True}):
                v = (t.get('href') or '').strip()
                if not v.startswith('http://'):
                    continue
                rels = [r.lower() for r in (t.get('rel') or [])]
                if any(r in _MIXED_LINK_RELS for r in rels):
                    mixed.append(v)
            result['mixed_content'] = mixed[:20]

        # Images — smarter than "any <img> without alt".
        # Matches what Google + WCAG actually care about:
        #   - Missing `alt` attribute entirely = real issue (flag)
        #   - `alt=""` explicitly = decorative, correct pattern (info, not issue)
        #   - 1x1 tracking pixels, aria-hidden / role=presentation, or images
        #     inside an <a>/<button> that already has accessible text → skipped
        #     (the image doesn't need its own alt for screen readers).
        imgs = soup.find_all('img')
        result['images_total'] = len(imgs)
        no_alt_imgs = []          # offending — no alt attr AND not decorative
        empty_alt_count = 0       # <img alt=""> — correct decorative pattern
        skipped_decorative = 0    # skipped via heuristics (tracking px, aria-hidden, labeled parent)

        def _has_accessible_name(node):
            """Whether a parent link/button carries its own accessible name —
            text, aria-label, or aria-labelledby — making a missing img alt fine."""
            if not node:
                return False
            if (node.get('aria-label') or '').strip():
                return True
            if (node.get('aria-labelledby') or '').strip():
                return True
            # Visible text content excluding the image itself
            clone = node
            txt = (clone.get_text(separator=' ', strip=True) or '')
            return len(txt) >= 2

        for img in imgs:
            alt_attr = img.get('alt')  # None if missing, '' if empty, str otherwise
            # Explicit empty alt — the correct decorative pattern. Count but don't flag.
            if alt_attr == '':
                empty_alt_count += 1
                continue
            if alt_attr is not None and alt_attr.strip():
                continue  # Has meaningful alt — good

            # alt is missing entirely. Apply filters before flagging.
            # Hidden / decorative hints
            aria_hidden = (img.get('aria-hidden') or '').lower() == 'true'
            role = (img.get('role') or '').lower()
            if aria_hidden or role in ('presentation', 'none'):
                skipped_decorative += 1
                continue
            # 1x1 tracking pixels
            w = (img.get('width') or '').strip()
            h = (img.get('height') or '').strip()
            if w in ('1', '0') or h in ('1', '0'):
                skipped_decorative += 1
                continue
            # Data URIs (usually inline SVG icons or tiny spacers)
            src = img.get('src', '') or img.get('data-src', '') or ''
            if src.startswith('data:'):
                skipped_decorative += 1
                continue
            # Image inside a link/button that already has accessible text
            parent_interactive = img.find_parent(['a', 'button'])
            if parent_interactive and _has_accessible_name(parent_interactive):
                skipped_decorative += 1
                continue

            if src:
                no_alt_imgs.append(urljoin(url, src))

        result['images_no_alt'] = len(no_alt_imgs)
        result['images_no_alt_urls'] = no_alt_imgs[:20]  # cap at 20 per page
        result['images_empty_alt'] = empty_alt_count
        result['images_decorative_skipped'] = skipped_decorative

        # Links - extract internal + external with anchor text + placement.
        # Placement = which site region the link sits in (nav / header / footer / main),
        # so users can tell boilerplate links from content links — like Screaming Frog.
        def _placement(a_tag):
            for ancestor in a_tag.parents:
                name = (getattr(ancestor, 'name', None) or '').lower()
                if not name: continue
                if name in ('nav',): return 'nav'
                if name in ('header',): return 'header'
                if name in ('footer',): return 'footer'
                if name in ('aside',): return 'sidebar'
                # Check role / class hints
                classes = ' '.join(ancestor.get('class', []) if hasattr(ancestor, 'get') else []).lower()
                role = (ancestor.get('role', '') if hasattr(ancestor, 'get') else '').lower()
                if 'nav' in classes or role == 'navigation': return 'nav'
                if 'footer' in classes: return 'footer'
                if 'header' in classes: return 'header'
                if name == 'main': return 'main'
            return 'body'

        int_links = {}      # normalized target -> {anchor, placement}
        ext_links_list = [] # external links captured with anchor + placement
        ext_count = 0
        for a in soup.find_all('a', href=True):
            href = a['href'].strip()
            if not href or href.startswith('#') or href.startswith('javascript:') or href.startswith('mailto:') or href.startswith('tel:'):
                continue
            resolved = urljoin(url, href)
            link_domain = urlparse(resolved).netloc.lower().replace('www.', '')
            # Anchor text: prefer visible text, fall back to aria-label / alt of child <img>
            anchor = (a.get_text(separator=' ', strip=True) or '')[:180]
            if not anchor:
                aria = a.get('aria-label') or a.get('title')
                if aria:
                    anchor = aria.strip()[:180]
                else:
                    img_child = a.find('img')
                    if img_child:
                        alt = (img_child.get('alt') or '').strip()[:140]
                        src = (img_child.get('src') or '').strip()
                        # Extract filename so two images with similar alts (e.g. header
                        # logo "Todd Devine Homes text logo" vs tile image "Todd Homes")
                        # can be disambiguated in the inlinks drawer.
                        fname = ''
                        if src:
                            fname = src.split('?', 1)[0].rstrip('/').split('/')[-1][:80]
                        if alt and fname:
                            anchor = f'[image: {alt} — {fname}]'
                        elif alt:
                            anchor = f'[image: {alt}]'
                        elif fname:
                            anchor = f'[image: {fname}]'
                        else:
                            anchor = '[image]'
            if not anchor:
                anchor = '(empty anchor)'
            placement = _placement(a)

            if link_domain == domain:
                normalized = _normalize_crawl_url(resolved)
                if normalized not in int_links:
                    int_links[normalized] = (anchor, placement)
            else:
                ext_count += 1
                if len(ext_links_list) < 300:  # cap payload
                    ext_links_list.append([resolved, anchor, placement])

        # Transport: [[target, anchor, placement], ...]
        result['internal_link_urls'] = [[t, a, p] for t, (a, p) in int_links.items()]
        result['internal_links'] = len(int_links)
        result['external_link_urls'] = ext_links_list
        result['external_links'] = ext_count

        # Issues detection — skip content/SEO checks for noindex or pagination pages
        # (noindex = Google won't rank it; pagination = archive duplicate, not a canonical page)
        # Also skip URLs that redirected: the resolved target is crawled separately and
        # any content issues belong on that row, not on the 301 source.
        # When ignore_noindex is set, treat noindex pages like indexable ones for
        # the audit so the user sees the full warning/info list, not just the flag.
        # ALSO skip canonicalised pages — they're declared duplicates so any
        # 'Missing meta' / 'Missing title' / 'Thin content' on them is noise;
        # those issues are real on the canonical page and would surface there.
        # The page itself still appears under the 'Canonicalised' report.
        is_canonicalised = result.get('canonical_kind') == 'canonicalised'
        if (result['indexable'] or ignore_noindex) and not result.get('is_pagination') and not result.get('redirect_url') and not is_canonicalised:
            if not result['title']:
                result['issues'].append('Missing title')
            elif result['title_len'] > 60:
                result['issues'].append(f'Title too long ({result["title_len"]})')
            elif result['title_len'] < 30:
                result['issues'].append(f'Title too short ({result["title_len"]})')

            if not result['meta_description']:
                result['issues'].append('Missing meta description')
            elif result['meta_len'] > 160:
                result['issues'].append(f'Meta desc too long ({result["meta_len"]})')
            elif result['meta_len'] < 70:
                result['issues'].append(f'Meta desc too short ({result["meta_len"]})')

            if not result['h1']:
                result['issues'].append('Missing H1')
            h1_count = len(result['h1_list'])
            if h1_count > 1:
                result['issues'].append(f'Multiple H1s ({h1_count})')
            if result['h1'] and result['title'] and result['h1'].strip().lower() == result['title'].strip().lower():
                result['issues'].append('H1 same as title')

            if result['canonical_kind'] == 'missing':
                result['issues'].append('Missing canonical')
            elif result['canonical_kind'] == 'canonicalised':
                result['issues'].append('Canonicalised (points elsewhere)')

            if result['word_count'] < 200:
                result['issues'].append(f'Thin content ({result["word_count"]} words)')

            if result['images_no_alt'] > 0:
                result['issues'].append(f'{result["images_no_alt"]} imgs missing alt')

            if not result['schema_types']:
                result['issues'].append('No schema')

            # Viewport
            if not soup.find('meta', attrs={'name': _re.compile(r'^viewport$', _re.I)}):
                result['issues'].append('Missing viewport')

            # Open Graph — any indexable page should have at least og:title + og:image for social sharing
            og = result['og_tags']
            if not og.get('title') and not og.get('image'):
                result['issues'].append('Missing Open Graph tags')
            elif not og.get('image'):
                result['issues'].append('Missing og:image')

            # Twitter Card — not critical but worth flagging
            if not result['twitter_tags']:
                result['issues'].append('Missing Twitter Card')

            # Analytics — flag pages with no tracking at all. But if the site
            # is clearly JS-rendered (Wix, Shopify, Squarespace, Webflow, or
            # client-side React/Vue/Next) and we crawled without JS rendering,
            # the HTML we scanned was the unhydrated shell — so "No analytics
            # detected" is a false negative. Emit a more actionable warning
            # instead so the user knows to re-run with Render JS enabled.
            if not result['analytics']:
                platform = _detect_js_platform(raw_html) if not result.get('js_rendered') else None
                if platform:
                    result['js_platform'] = platform
                    result['issues'].append(f'Analytics unknown — {platform} site needs Render JS')
                else:
                    result['issues'].append('No analytics detected')

        # --- Issues that apply regardless of indexability ---
        # Canonicalised flag — surfaced even when content checks are skipped
        # so the page still appears under the Canonicalised report.
        if is_canonicalised:
            result['issues'].append('Canonicalised (points elsewhere)')
        if result['response_time'] > 3:
            result['issues'].append(f'Slow ({result["response_time"]}s)')

        # URL hygiene (Screaming Frog URL tab)
        for ui in result.get('url_issues', []):
            result['issues'].append(f'URL: {ui}')

        # Mixed content
        if result['mixed_content']:
            result['issues'].append(f'Mixed content ({len(result["mixed_content"])} resources)')

        # Security headers — we still capture their presence in result['security']
        # for the page-detail panel, but we don't flag missing HSTS / X-Content-Type-Options
        # / X-Frame-Options / CSP / Referrer-Policy as issues (low signal-to-noise for SEO).
        sec = result.get('security', {})
        if not sec.get('is_https'):
            result['issues'].append('Served over HTTP (insecure)')

    except requests.exceptions.Timeout:
        result['error'] = 'Timeout'
        result['issues'].append('Timeout')
    except requests.exceptions.ConnectionError:
        result['error'] = 'Connection error'
        result['issues'].append('Connection error')
    except Exception as e:
        result['error'] = str(e)[:100]
        result['issues'].append(f'Error: {str(e)[:60]}')

    return result


def _teardown_pw(pw_page, pw_browser, pw_ctx):
    for name, obj, method in (('page', pw_page, 'close'), ('browser', pw_browser, 'close'), ('pw', pw_ctx, 'stop')):
        if obj is not None:
            try: getattr(obj, method)()
            except Exception: pass



# -------- Sitemap analysis ---------------------------------------------------
# Discovers a site's XML sitemap(s), parses every URL, and diffs them against a
# crawl. Mirrors the Screaming Frog Sitemaps tab. No external API or LLM —
# pure XML parsing + set diffs.
_SITEMAP_DEFAULT_PATHS = (
    '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
    '/wp-sitemap.xml',
    '/sitemap.xml.gz',
    '/sitemap1.xml', '/sitemap-1.xml',
    '/post-sitemap.xml', '/page-sitemap.xml',
)
_SITEMAP_NS = '{http://www.sitemaps.org/schemas/sitemap/0.9}'


def _discover_sitemaps(domain):
    """Find sitemap URLs for a domain. Tries robots.txt first, then common
    default paths. When robots.txt points at a sibling subdomain (multisite
    misconfiguration) we surface a warning AND also probe the analysed
    domain's own paths so the diff isn't comparing the crawl against the
    wrong site's URL set.
    """
    found = []
    seen = set()
    warnings = []

    def _add(u, src):
        u = u.strip()
        if u and u not in seen:
            seen.add(u)
            found.append({'url': u, 'source': src})

    analysed_host = (urlparse(domain).netloc or '').lower()

    try:
        r = requests.get(f"{domain.rstrip('/')}/robots.txt", timeout=10,
                         headers={'User-Agent': 'Mozilla/5.0'})
        if r.ok and r.text:
            for line in r.text.splitlines():
                line = line.strip()
                if line.lower().startswith('sitemap:'):
                    sm_url = line.split(':', 1)[1].strip()
                    sm_host = (urlparse(sm_url).netloc or '').lower()
                    src = 'robots.txt'
                    if sm_host and analysed_host and sm_host != analysed_host:
                        src = 'robots.txt (DIFFERENT DOMAIN)'
                        warnings.append(
                            f"robots.txt declares sitemap on a different host ({sm_host}) "
                            f"than the site being analysed ({analysed_host}). "
                            f"Likely multisite misconfiguration — also probing default paths."
                        )
                    _add(sm_url, src)
    except Exception:
        pass

    has_onsite = any((urlparse(s['url']).netloc or '').lower() == analysed_host for s in found)
    if not has_onsite:
        for path in _SITEMAP_DEFAULT_PATHS:
            url = f"{domain.rstrip('/')}{path}"
            try:
                resp = requests.head(url, timeout=8, allow_redirects=True,
                                     headers={'User-Agent': 'Mozilla/5.0'})
                if resp.status_code == 405:
                    resp = requests.get(url, timeout=10, allow_redirects=True,
                                        headers={'User-Agent': 'Mozilla/5.0'},
                                        stream=True)
                    resp.close()
                if resp.ok:
                    ct = (resp.headers.get('content-type') or '').lower()
                    if 'xml' in ct or path.endswith('.xml') or path.endswith('.gz'):
                        _add(url, 'default-path')
                        break
            except Exception:
                pass

    return found, warnings


def _fetch_sitemap_recursive(seed_urls, max_depth=5):
    """Walk a sitemap (handling sitemap-index recursion) and collect every URL."""
    import xml.etree.ElementTree as ET
    import gzip

    urls = []
    sitemaps_meta = []
    errors = []
    visited = set()

    def _walk(sm_url, depth):
        if depth > max_depth or sm_url in visited:
            return
        visited.add(sm_url)
        try:
            r = requests.get(sm_url, timeout=20,
                             headers={'User-Agent': 'Mozilla/5.0',
                                      'Accept': 'application/xml,text/xml,*/*'})
            if not r.ok:
                errors.append({'sitemap': sm_url, 'error': f'http_{r.status_code}'})
                sitemaps_meta.append({'url': sm_url, 'url_count': 0, 'error': f'http_{r.status_code}'})
                return
            content = r.content
            if sm_url.lower().endswith('.gz'):
                try:
                    content = gzip.decompress(content)
                except Exception:
                    pass
            try:
                root = ET.fromstring(content)
            except ET.ParseError as e:
                errors.append({'sitemap': sm_url, 'error': f'xml_parse: {str(e)[:120]}'})
                sitemaps_meta.append({'url': sm_url, 'url_count': 0, 'error': 'xml_parse'})
                return

            tag = root.tag.split('}', 1)[-1] if '}' in root.tag else root.tag
            count_here = 0
            if tag == 'sitemapindex':
                for sm_node in root.findall(f'{_SITEMAP_NS}sitemap'):
                    loc = sm_node.find(f'{_SITEMAP_NS}loc')
                    if loc is not None and loc.text:
                        _walk(loc.text.strip(), depth + 1)
                sitemaps_meta.append({'url': sm_url, 'url_count': 0, 'error': None,
                                      'is_index': True})
            else:
                for url_node in root.findall(f'{_SITEMAP_NS}url'):
                    loc = url_node.find(f'{_SITEMAP_NS}loc')
                    if loc is None or not loc.text:
                        continue
                    lastmod = url_node.find(f'{_SITEMAP_NS}lastmod')
                    urls.append({
                        'url': loc.text.strip(),
                        'lastmod': lastmod.text.strip() if lastmod is not None and lastmod.text else None,
                        'source_sitemap': sm_url,
                    })
                    count_here += 1
                sitemaps_meta.append({'url': sm_url, 'url_count': count_here, 'error': None,
                                      'is_index': False})
        except Exception as e:
            errors.append({'sitemap': sm_url, 'error': str(e)[:200]})
            sitemaps_meta.append({'url': sm_url, 'url_count': 0, 'error': str(e)[:120]})

    for u in seed_urls:
        _walk(u, 0)
    return urls, sitemaps_meta, errors


# File extensions that are NOT HTML pages — sitemaps shouldn't list them
# and the missing-from-sitemap report should skip them entirely.
_NON_HTML_EXTS = (
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.avif',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.rtf',
    '.zip', '.tar', '.gz', '.7z', '.rar',
    '.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv', '.mp3', '.wav', '.ogg', '.flac',
    '.css', '.js', '.json', '.xml', '.map',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
)


def _is_non_html_url(u):
    if not u:
        return False
    try:
        path = (urlparse(u).path or '').lower()
    except Exception:
        return False
    return path.endswith(_NON_HTML_EXTS)


def _norm_url(u):
    """Normalise a URL for set-comparison."""
    if not u:
        return ''
    u = u.strip()
    try:
        p = urlparse(u)
        host = (p.netloc or '').lower()
        path = (p.path or '').rstrip('/')
        return f"{p.scheme}://{host}{path}".lower()
    except Exception:
        return u.rstrip('/').lower()


@app.route('/fetch-robots-txt', methods=['GET'])
def fetch_robots_txt():
    """Fetch a site's robots.txt for the URL filters preview panel."""
    target = (request.args.get('url') or '').strip()
    if not target:
        return jsonify({'error': 'url required'}), 400
    if not target.startswith('http'):
        target = 'https://' + target.lstrip('/')
    try:
        parsed = urlparse(target)
        if not parsed.netloc:
            return jsonify({'error': 'invalid URL'}), 400
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        resp = requests.get(robots_url, timeout=10,
                            headers={'User-Agent': 'Mozilla/5.0 (compatible; OpenSEOCrawler-RobotsPreview)'},
                            allow_redirects=True)
        body = (resp.text or '')[:20000]
        return jsonify({
            'url': robots_url,
            'status': resp.status_code,
            'content': body,
            'length': len(resp.text or ''),
        })
    except Exception as e:
        return jsonify({'error': str(e)[:200]}), 200


@app.route('/sitemap-analyse', methods=['POST'])
def sitemap_analyse():
    """Discover the site's sitemap(s) and diff against a crawl.

    Body: {"domain": "https://example.com", "results": [...page rows...],
           "inlinks": {url: [source_urls...]}}
    """
    data = request.get_json() or {}
    domain = (data.get('domain') or '').rstrip('/')
    if domain and not domain.startswith('http'):
        domain = 'https://' + domain
    results = data.get('results') or []
    inlinks_map = data.get('inlinks') or {}
    manual_sm = (data.get('sitemap_url') or '').strip()

    if not domain:
        return jsonify({'error': 'domain required'}), 400

    if manual_sm:
        if not manual_sm.startswith('http'):
            manual_sm = 'https://' + manual_sm.lstrip('/')
        discovered = [{'url': manual_sm, 'source': 'manual'}]
        discovery_warnings = []
    else:
        discovered, discovery_warnings = _discover_sitemaps(domain)
        if not discovered:
            return jsonify({
                'sitemaps_found': [],
                'warnings': discovery_warnings + ['No sitemap could be discovered. Tried robots.txt and common default paths.'],
                'tried_paths': list(_SITEMAP_DEFAULT_PATHS),
            }), 200

    seed = [d['url'] for d in discovered]
    sm_urls, sitemaps_meta, sm_errors = _fetch_sitemap_recursive(seed)

    crawl_by_norm = {}
    for r in results:
        u = r.get('url')
        if not u:
            continue
        crawl_by_norm[_norm_url(u)] = r

    sitemap_by_norm = {}
    for entry in sm_urls:
        sitemap_by_norm.setdefault(_norm_url(entry['url']), entry)

    inlinks_by_norm = {}
    for k, v in inlinks_map.items():
        inlinks_by_norm[_norm_url(k)] = v or []

    pag_re = _re.compile(r'/page/\d+/?$|[?&](page|paged|pg)=\d+', _re.I)

    missing_from_sitemap = []
    orphan_in_sitemap = []
    sitemap_only = []
    non_indexable_in_sitemap = []
    non_200_in_sitemap = []
    redirects_in_sitemap = []
    pagination_in_sitemap = []

    for nrm, r in crawl_by_norm.items():
        if nrm in sitemap_by_norm:
            continue
        sc = r.get('status_code') or 0
        if not r.get('indexable', True):
            continue
        if sc and sc != 200:
            continue
        if r.get('redirect_url'):
            continue
        if r.get('is_pagination'):
            continue
        if _is_non_html_url(r.get('url')):
            continue
        missing_from_sitemap.append(r.get('url'))

    for nrm, entry in sitemap_by_norm.items():
        original_url = entry['url']
        if pag_re.search(urlparse(original_url).path) or pag_re.search('?' + (urlparse(original_url).query or '')):
            pagination_in_sitemap.append(original_url)
        crawled = crawl_by_norm.get(nrm)
        if crawled is None:
            sitemap_only.append({'url': original_url, 'lastmod': entry.get('lastmod')})
            continue
        sc = crawled.get('status_code') or 0
        if sc and sc != 200:
            non_200_in_sitemap.append({'url': original_url, 'status_code': sc})
        if crawled.get('redirect_url'):
            redirects_in_sitemap.append({
                'url': original_url,
                'redirects_to': crawled.get('redirect_url'),
            })
        if not crawled.get('indexable', True):
            non_indexable_in_sitemap.append({
                'url': original_url,
                'reason': 'noindex',
            })
        if (sc == 200 and not crawled.get('redirect_url')
                and crawled.get('indexable', True)
                and not inlinks_by_norm.get(nrm)):
            orphan_in_sitemap.append(original_url)

    warnings = list(discovery_warnings)
    if any(len(s.get('url', '')) and s['url'].startswith('http://') for s in sitemaps_meta):
        warnings.append('At least one sitemap is served over HTTP, not HTTPS.')
    for sm in sitemaps_meta:
        if (sm.get('url_count') or 0) > 50000:
            warnings.append(f"{sm['url']} contains {sm['url_count']} URLs — over the 50,000 sitemap limit.")
    no_lastmod = sum(1 for u in sm_urls if not u.get('lastmod'))
    if sm_urls and no_lastmod / len(sm_urls) > 0.5:
        warnings.append(f"{no_lastmod}/{len(sm_urls)} URLs in sitemap are missing <lastmod>.")

    return jsonify({
        'domain': domain,
        'sitemaps_found': discovered,
        'sitemaps_walked': sitemaps_meta,
        'sitemap_errors': sm_errors,
        'totals': {
            'urls_in_sitemap': len(sm_urls),
            'urls_in_crawl': len(crawl_by_norm),
            'sitemaps_walked': len(sitemaps_meta),
        },
        'reports': {
            'missing_from_sitemap': missing_from_sitemap,
            'orphan_in_sitemap': orphan_in_sitemap,
            'sitemap_only': sitemap_only,
            'non_indexable_in_sitemap': non_indexable_in_sitemap,
            'non_200_in_sitemap': non_200_in_sitemap,
            'redirects_in_sitemap': redirects_in_sitemap,
            'pagination_in_sitemap': pagination_in_sitemap,
        },
        'warnings': warnings,
    })


# =============================================================================
# Near-duplicate content detection (Shingle Jaccard 5-gram + df=1 filter).
# Mirrors the algorithm and API surface in internal-tool. Pure stdlib, no LLM.
# =============================================================================

_ND_STOP = {
    'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can',
    'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'through',
    'this', 'that', 'these', 'those', 'i', 'we', 'you', 'they', 'it', 'he', 'she',
    'our', 'your', 'their', 'its', 'his', 'her', 'my',
    'not', 'no', 'so', 'if', 'than', 'then', 'too', 'very', 'just',
    'over', 'under', 'before', 'after', 'between', 'from', 'up', 'down', 'out', 'off',
    'all', 'any', 'each', 'most', 'some', 'other', 'such', 'only', 'own', 'same',
    'us', 'me', 'them', 'who', 'what', 'where', 'when', 'why', 'how',
}

def _nd_tokenize(text):
    return _re.findall(r"[a-z][a-z'\-]{1,}", (text or '').lower())

def _nd_strip_selectors(html_or_text, selectors):
    if not selectors or not html_or_text:
        return html_or_text
    sel_list = [s.strip() for s in selectors.split(',') if s.strip()]
    if not sel_list or '<' not in html_or_text or '>' not in html_or_text:
        return html_or_text
    try:
        soup = BeautifulSoup(html_or_text, 'html.parser')
        for sel in sel_list:
            for node in soup.select(sel):
                node.decompose()
        return soup.get_text(separator=' ', strip=True)
    except Exception:
        return html_or_text

@app.route('/near-dup-content', methods=['POST'])
def near_dup_content():
    payload = request.get_json(silent=True) or {}
    pages = payload.get('pages') or []
    try:
        threshold = float(payload.get('threshold', 0.90))
    except (TypeError, ValueError):
        threshold = 0.90
    threshold = max(0.5, min(0.99, threshold))
    exclude_sel = (payload.get('exclude_selectors') or '').strip()

    t0 = time.perf_counter()

    docs = []
    skipped = 0
    for p in pages:
        url = (p.get('url') or '').strip()
        body = p.get('body_text') or ''
        if not url or not body:
            skipped += 1
            continue
        canonical = (p.get('canonical') or '').strip()
        if canonical and canonical != url:
            skipped += 1
            continue
        if p.get('indexable') is False:
            skipped += 1
            continue
        if exclude_sel:
            body = _nd_strip_selectors(body, exclude_sel)
        toks = [t for t in _nd_tokenize(body) if t not in _ND_STOP and len(t) > 1]
        if len(toks) < 20:
            skipped += 1
            continue
        docs.append({'url': url, 'tokens': toks})

    df = {}
    for d in docs:
        for t in set(d['tokens']):
            df[t] = df.get(t, 0) + 1
    common_terms = {t for t, c in df.items() if c >= 2}

    n = 5
    sets = []
    for d in docs:
        toks = [t for t in d['tokens'] if t in common_terms]
        if len(toks) < n:
            sets.append({'url': d['url'], 'shingles': set()})
            continue
        shingles = {' '.join(toks[i:i + n]) for i in range(len(toks) - n + 1)}
        sets.append({'url': d['url'], 'shingles': shingles})

    pairs = []
    M = len(sets)
    for i in range(M):
        sa = sets[i]['shingles']
        if not sa:
            continue
        for j in range(i + 1, M):
            sb = sets[j]['shingles']
            if not sb:
                continue
            inter = len(sa & sb)
            union = len(sa | sb)
            if not union:
                continue
            sim = inter / union
            if sim >= threshold:
                sample = next(iter(sa & sb), '') if inter else ''
                pairs.append({
                    'url_a': sets[i]['url'],
                    'url_b': sets[j]['url'],
                    'similarity': round(sim, 4),
                    'shared_phrase_sample': sample,
                })
    pairs.sort(key=lambda p: -p['similarity'])

    return jsonify({
        'pairs': pairs,
        'stats': {
            'docs_analysed': M,
            'docs_skipped': skipped,
            'threshold': threshold,
            'took_ms': int((time.perf_counter() - t0) * 1000),
        },
    })


@app.route('/recrawl-url', methods=['POST'])
def recrawl_url():
    """Re-crawl a single URL and return fresh page audit data."""
    import requests as _req
    from urllib.parse import urlparse
    data = request.get_json() or {}
    url = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'URL required'}), 400
    domain = urlparse(url).netloc
    try:
        with _req.Session() as session:
            session.headers.update({
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                'Accept-Language': 'en-US,en;q=0.9',
            })
            result = _crawl_page(url, session, domain)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/crawl', methods=['POST'])
def crawl_site():
    """BFS site crawl with SSE streaming of per-page results."""
    from collections import deque
    from urllib.parse import urlparse
    import urllib.robotparser

    data = request.json
    seed_url = (data.get('url', '') or '').strip()
    if not seed_url:
        return json.dumps({'error': 'URL is required'}), 400
    if not seed_url.startswith('http'):
        seed_url = 'https://' + seed_url

    max_pages = int(data.get('max_pages', 200) or 200)
    if max_pages >= 5000:
        max_pages = 999999  # unlimited
    max_depth = min(int(data.get('max_depth', 10) or 10), 20)
    crawl_delay = max(float(data.get('crawl_delay', 0.4) or 0.4), 0.0)
    render_js = bool(data.get('render_js', False))
    ignore_robots = bool(data.get('ignore_robots', False))
    ignore_noindex = bool(data.get('ignore_noindex', False))
    # Concurrent workers. Default 5 matches Screaming Frog. Clamped to [1, 20].
    # When render_js is on, Playwright can't share a single page across threads —
    # force single-worker mode so page state stays consistent.
    max_workers = int(data.get('max_workers', 5) or 5)
    max_workers = max(1, min(20, max_workers))
    if render_js:
        max_workers = 1

    # URL include/exclude patterns — robots.txt syntax (Google's spec):
    #   *       matches any sequence
    #   $       at end anchors end of URL
    #   ?, .    are LITERAL (no fnmatch single-char wildcard surprise)
    # Exclude beats include. If include is non-empty, URLs must match at least one.
    # Stored in ACTIVE_CRAWL_RULES so /crawl/update-rules can mutate them mid-crawl.
    import uuid as _uuid
    def _parse_patterns(raw):
        if not raw: return []
        return [p.strip() for p in raw.splitlines() if p.strip() and not p.strip().startswith('#')]
    crawl_id = _uuid.uuid4().hex[:12]
    ACTIVE_CRAWL_RULES[crawl_id] = {
        'include': _parse_patterns(data.get('include_patterns', '')),
        'exclude': _parse_patterns(data.get('exclude_patterns', '')),
    }

    _NON_PAGE_PATH_FRAGMENTS = (
        '/feed/', '/feed.atom', '/feed.rss', '/comments/feed/',
        '/wp-json/', '/wp-admin/', '/wp-login.php', '/xmlrpc.php',
        '/?wc-ajax=', '/cart/?', '/checkout/?',
        '/sitemap.xml', '/sitemap_index.xml',
    )

    def _url_allowed(u):
        # Drop media files + non-HTML endpoints so they never enter the
        # results table or pollute per-page reports (Schema by Page, etc.).
        if _is_non_html_url(u):
            return False
        try:
            path_lower = (urlparse(u).path or '').lower()
        except Exception:
            path_lower = ''
        if any(frag in path_lower for frag in _NON_PAGE_PATH_FRAGMENTS):
            return False
        rules = ACTIVE_CRAWL_RULES.get(crawl_id) or {}
        excl = rules.get('exclude') or []
        incl = rules.get('include') or []
        if excl and any(_robots_pattern_match(p, u) for p in excl):
            return False
        if incl and not any(_robots_pattern_match(p, u) for p in incl):
            return False
        return True

    parsed = urlparse(seed_url)
    domain = parsed.netloc.lower().replace('www.', '')

    app.logger.info(f"[crawler] Starting crawl of {seed_url} (max={max_pages}, depth={max_depth}, delay={crawl_delay}s, js={render_js}) from {request.remote_addr}")

    def generate():
        # Fetch robots.txt up-front so the user sees what we're following.
        # If ignore_robots is set, we still fetch (informational) but won't enforce.
        rp = urllib.robotparser.RobotFileParser()
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        robots_status = 'fetching'
        robots_rules = 0
        try:
            resp = requests.get(robots_url, timeout=8, headers={'User-Agent': 'SEO-Audit-Bot'})
            if resp.status_code == 200:
                rp.parse(resp.text.splitlines())
                robots_rules = resp.text.count('Disallow')
                robots_status = 'ignored' if ignore_robots else 'respecting'
                yield f"data: {json.dumps({'type':'info','msg':f'Downloaded robots.txt ({robots_rules} Disallow rules) — {robots_status}'})}\n\n"
            else:
                robots_status = 'not found'
                yield f"data: {json.dumps({'type':'info','msg':f'robots.txt returned HTTP {resp.status_code} — no rules to enforce'})}\n\n"
        except Exception as e:
            robots_status = 'error'
            yield f"data: {json.dumps({'type':'info','msg':f'robots.txt unreachable ({str(e)[:80]}) — continuing without'})}\n\n"

        session = requests.Session()
        session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
        })

        # Launch Playwright browser once per crawl if JS rendering requested
        pw_ctx = None
        pw_browser = None
        pw_page = None
        if render_js:
            try:
                from playwright.sync_api import sync_playwright
                pw_ctx = sync_playwright().start()
                pw_browser = pw_ctx.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
                pw_page = pw_browser.new_page(
                    viewport={'width': 1280, 'height': 900},
                    user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
                )
                pw_page.set_default_timeout(20000)
                yield f"data: {json.dumps({'type': 'info', 'msg': 'JS rendering enabled (Playwright). Crawl will be 3-5x slower.'})}\n\n"
            except Exception as e:
                app.logger.warning(f"[crawler] Playwright init failed: {e}")
                yield f"data: {json.dumps({'type': 'info', 'msg': f'JS rendering unavailable ({str(e)[:100]}); using raw HTML only.'})}\n\n"
                pw_page = None

        queue = deque()
        queue.append((_normalize_crawl_url(seed_url), 0))
        visited = set()
        results = []
        errors = 0
        total_time = 0
        # Map of target URL -> list of source URLs linking to it (inlinks / Screaming Frog style)
        inlinks_map = {}

        tracked_kws = []  # left in place for payload compatibility; no external data sources in the public build
        yield f"data: {json.dumps({'type': 'start', 'domain': domain, 'workers': max_workers, 'crawl_id': crawl_id})}\n\n"

        # CMS fingerprint using the seed page (cheap HEAD+GET already handles this below,
        # but we want the info up-front so the UI can badge + offer one-click recommendations).
        try:
            cms_resp = session.get(seed_url, timeout=10, allow_redirects=True)
            cms_info = detect_cms(seed_url, cms_resp.text, dict(cms_resp.headers))
            if cms_info.get('cms'):
                prof = CMS_PROFILES.get(cms_info['cms'], {})
                cms_info['profile'] = {
                    'exclude_patterns': prof.get('exclude_patterns', []),
                    'suggested_settings': prof.get('suggested_settings', {}),
                    'schema_warnings': prof.get('schema_warnings', []),
                    'tips': prof.get('tips', []),
                }
            yield f"data: {json.dumps({'type': 'cms_detected', **cms_info})}\n\n"
        except Exception as _cms_err:
            app.logger.info(f"[crawler] CMS detection skipped: {_cms_err}")

        # Per-host politeness: minimum gap between two requests to the same host.
        # Workers on DIFFERENT hosts run freely; same-host workers serialise via this lock+timestamp map.
        from concurrent.futures import ThreadPoolExecutor, wait as _fwait, FIRST_COMPLETED
        from urllib.parse import urlparse as _up
        host_last_fetch = {}
        host_lock = threading.Lock()
        host_backoff = {}  # host → multiplier for adaptive slow-down on 429/403

        def _wait_host_turn(u):
            host = _up(u).netloc
            while True:
                with host_lock:
                    now = time.time()
                    last = host_last_fetch.get(host, 0)
                    backoff = host_backoff.get(host, 1.0)
                    effective_delay = crawl_delay * backoff
                    wait = (last + effective_delay) - now
                    if wait <= 0:
                        host_last_fetch[host] = now
                        return
                time.sleep(wait)

        def _adjust_host_backoff(u, page_data):
            host = _up(u).netloc
            status = page_data.get('status_code', 0)
            with host_lock:
                cur = host_backoff.get(host, 1.0)
                if status in (429, 503):
                    host_backoff[host] = min(cur * 2, 20.0)
                elif status == 403 or status == 0 or page_data.get('error'):
                    host_backoff[host] = min(cur * 1.5, 20.0)
                else:
                    # Decay back toward 1.0 on successes
                    if cur > 1.0:
                        host_backoff[host] = max(1.0, cur * 0.8)

        def _fetch_job(url, depth):
            """Worker: politeness-wait, fetch, return (url, depth, page_data)."""
            _wait_host_turn(url)
            pd = _crawl_page(url, session, domain, pw_page=pw_page, ignore_noindex=ignore_noindex)
            pd['depth'] = depth
            _adjust_host_backoff(url, pd)
            return url, depth, pd

        in_flight = {}  # future -> (url, depth)
        consecutive_errors = 0

        def _visit(url):
            visited.add(url)
            alt = _crawl_slash_alt(url)
            if alt:
                visited.add(alt)

        def _dequeue_next():
            """Pop the next URL that passes filters + robots. Returns (url, depth) or None."""
            while queue:
                url, depth = queue.popleft()
                if url in visited or depth > max_depth:
                    continue
                if not _url_allowed(url):
                    _visit(url)
                    continue
                if not ignore_robots:
                    try:
                        if not rp.can_fetch('*', url):
                            _visit(url)
                            continue
                    except Exception:
                        pass
                _visit(url)
                return url, depth
            return None

        try:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                # Prime the pool
                while len(in_flight) < max_workers and len(visited) < max_pages:
                    nxt = _dequeue_next()
                    if nxt is None:
                        break
                    fut = executor.submit(_fetch_job, nxt[0], nxt[1])
                    in_flight[fut] = nxt

                while in_flight:
                    done_set, _ = _fwait(in_flight.keys(), return_when=FIRST_COMPLETED)
                    for fut in done_set:
                        submitted = in_flight.pop(fut, None)
                        try:
                            url, depth, page_data = fut.result()
                        except Exception as e:
                            url = submitted[0] if submitted else '?'
                            page_data = {
                                'url': url, 'status_code': 0, 'error': str(e)[:200],
                                'issues': [f'Fetch error: {str(e)[:80]}'], 'depth': submitted[1] if submitted else 0,
                            }

                        # Count adaptive signal for surfacing a speed notice
                        status = page_data.get('status_code', 0)
                        if status in (429, 503, 403) or status == 0 or page_data.get('error'):
                            consecutive_errors += 1
                            if consecutive_errors in (3, 6, 12):
                                _reason_code = status if status else 'conn'
                                yield f"data: {json.dumps({'type': 'speed_adjusted', 'reason': f'HTTP {_reason_code} — per-host back-off active'})}\n\n"
                        else:
                            consecutive_errors = max(0, consecutive_errors - 1)

                        link_urls = page_data.get('internal_link_urls', [])

                        # Tracked-keyword enrichment
                        if tracked_kws:
                            page_url_clean = url.rstrip('/')
                            matching_kws = [k for k in tracked_kws if k.get('url','').rstrip('/') == page_url_clean]
                            if matching_kws:
                                page_data['tracked_keywords'] = matching_kws

                        results.append(page_data)
                        if page_data.get('error'):
                            errors += 1
                        total_time += page_data.get('response_time', 0)

                        # Enqueue discovered links + record inlinks
                        source_url = page_data.get('url') or url
                        for entry in link_urls:
                            if isinstance(entry, (list, tuple)):
                                link = entry[0]
                                anchor = entry[1] if len(entry) > 1 else ''
                                placement = entry[2] if len(entry) > 2 else ''
                            else:
                                link, anchor, placement = entry, '', ''
                            bucket = inlinks_map.setdefault(link, [])
                            key = (source_url, anchor, placement)
                            if not any((e.get('source'), e.get('anchor'), e.get('placement')) == key for e in bucket):
                                bucket.append({'source': source_url, 'anchor': anchor, 'placement': placement})
                            alt = _crawl_slash_alt(link)
                            if link not in visited and (not alt or alt not in visited) and _url_allowed(link):
                                queue.append((link, depth + 1))

                        yield f"data: {json.dumps({'type': 'page', 'data': page_data, 'crawled': len(visited), 'queued': len(queue), 'errors': errors})}\n\n"

                    # Keep the pool topped up
                    while len(in_flight) < max_workers and len(visited) < max_pages:
                        nxt = _dequeue_next()
                        if nxt is None:
                            break
                        fut2 = executor.submit(_fetch_job, nxt[0], nxt[1])
                        in_flight[fut2] = nxt

        except GeneratorExit:
            app.logger.info(f"[crawler] Client disconnected, stopping crawl at {len(visited)} pages")
            session.close()
            _teardown_pw(pw_page, pw_browser, pw_ctx)
            ACTIVE_CRAWL_RULES.pop(crawl_id, None)
            return

        session.close()
        _teardown_pw(pw_page, pw_browser, pw_ctx)

        # Summary
        avg_time = round(total_time / len(results), 2) if results else 0
        issue_counts = {}
        for r in results:
            for issue in r.get('issues', []):
                # Normalize issue name for counting
                base = issue.split('(')[0].strip()
                issue_counts[base] = issue_counts.get(base, 0) + 1

        summary = {
            'total': len(results),
            'errors': errors,
            'warnings': sum(1 for r in results if r.get('issues')),
            'avg_time': avg_time,
            'issue_counts': issue_counts,
            'js_rendered_count': sum(1 for r in results if r.get('js_rendered')),
            'render_js': render_js,
        }

        # Attach inlinks per page (cap to 20 for payload size)
        inlinks_payload = {}
        for r in results:
            u = r.get('url')
            if not u:
                continue
            # Look up by exact URL and normalized variants
            sources = inlinks_map.get(u) or inlinks_map.get(u.rstrip('/')) or inlinks_map.get(u + '/') or []
            if sources:
                inlinks_payload[u] = sources[:20]

        # ---------- Post-crawl aggregated reports ----------
        from collections import defaultdict as _dd

        # Duplicate titles / metas / H1s / body
        # Skip redirected URLs (http/https/www variants that 301 to the canonical)
        # and non-200 responses — those aren't unique content, just transit stops.
        # Dedupe within each group by normalised URL so pagination (/page/2/)
        # and tracking/ecommerce params (?add-to-cart=, ?utm_*, ?replytocom=)
        # don't fragment a single canonical page across its variants.
        def _group_by(field_getter):
            g = _dd(dict)  # value -> {normalised_url: original_url}
            for r in results:
                if not (r.get('indexable', True) or ignore_noindex):
                    continue
                if r.get('redirect_url'):
                    continue
                if r.get('status_code') and r['status_code'] >= 300:
                    continue
                v = field_getter(r)
                if not v:
                    continue
                url = r.get('url')
                norm = _normalize_url_for_dup(url)
                if norm not in g[v]:
                    g[v][norm] = url
            return {k: list(d.values()) for k, d in g.items() if len(d) > 1}

        dup_titles = _group_by(lambda r: (r.get('title') or '').strip().lower())
        dup_metas = _group_by(lambda r: (r.get('meta_description') or '').strip().lower())
        dup_h1s = _group_by(lambda r: (r.get('h1') or '').strip().lower())
        dup_bodies = _group_by(lambda r: r.get('body_hash') or '')

        # Response code summary
        rc_buckets = {'2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, 'other': 0}
        for r in results:
            sc = r.get('status_code', 0)
            if 200 <= sc < 300: rc_buckets['2xx'] += 1
            elif 300 <= sc < 400: rc_buckets['3xx'] += 1
            elif 400 <= sc < 500: rc_buckets['4xx'] += 1
            elif 500 <= sc < 600: rc_buckets['5xx'] += 1
            else: rc_buckets['other'] += 1

        # Redirect chains (2+ hops) — surfaced distinctly from single redirects
        redirect_chains = [
            {'url': r['url'], 'chain': r['redirect_chain'], 'hops': r['redirect_hops']}
            for r in results if r.get('redirect_hops', 0) >= 2
        ]

        # Orphan detection via sitemap (URLs in sitemap but not in crawl).
        # Handle sitemap index by recursively fetching sub-sitemaps (max 20 to bound cost).
        orphans = []
        sitemap_urls_set = set()
        import xml.etree.ElementTree as _ET

        def _fetch_sitemap(sm_url, depth=0, seen=None):
            if seen is None: seen = set()
            if depth > 2 or sm_url in seen or len(seen) > 20:
                return
            seen.add(sm_url)
            try:
                r = requests.get(sm_url, timeout=10, headers={'User-Agent': 'SEO-Audit-Bot'})
                if r.status_code != 200:
                    return
                root = _ET.fromstring(r.content)
                tag = root.tag.lower()
                if tag.endswith('sitemapindex'):
                    # Recurse into each sub-sitemap
                    for loc in root.findall('.//{http://www.sitemaps.org/schemas/sitemap/0.9}loc'):
                        if loc.text:
                            _fetch_sitemap(loc.text.strip(), depth + 1, seen)
                else:
                    # urlset — collect page URLs
                    for loc in root.findall('.//{http://www.sitemaps.org/schemas/sitemap/0.9}loc'):
                        if loc.text:
                            sitemap_urls_set.add(loc.text.strip().rstrip('/'))
            except Exception:
                pass

        _fetch_sitemap(f"{parsed.scheme}://{parsed.netloc}/sitemap.xml")
        crawled_urls_set = {r['url'].rstrip('/') for r in results}
        # Also include redirect targets (since they were actually reached)
        for r in results:
            if r.get('redirect_url'):
                crawled_urls_set.add(r['redirect_url'].rstrip('/'))
        orphans = sorted(sitemap_urls_set - crawled_urls_set)[:200]

        # Crawl depth distribution (depth tracking needs to be added in BFS queue,
        # stored on page_data via tuple queue; for now derive via shortest inlink path
        # approximation — homepage=0, pages linked from homepage=1, etc.)
        # Simpler: use what we have — each page's 'depth' is set by BFS via queue tuple.
        depth_dist = _dd(int)
        for r in results:
            depth_dist[r.get('depth', 0)] += 1

        reports = {
            'response_codes': rc_buckets,
            'duplicate_titles': [{'value': k, 'urls': v} for k, v in sorted(dup_titles.items(), key=lambda x: -len(x[1]))][:100],
            'duplicate_metas': [{'value': k, 'urls': v} for k, v in sorted(dup_metas.items(), key=lambda x: -len(x[1]))][:100],
            'duplicate_h1s': [{'value': k, 'urls': v} for k, v in sorted(dup_h1s.items(), key=lambda x: -len(x[1]))][:100],
            'duplicate_bodies': [{'value': k[:8], 'urls': v} for k, v in sorted(dup_bodies.items(), key=lambda x: -len(x[1]))][:100],
            'redirect_chains': redirect_chains[:200],
            'orphans': orphans,
            'sitemap_count': len(sitemap_urls_set),
            'depth_distribution': dict(depth_dist),
        }

        app.logger.info(f"[crawler] Crawl complete: {len(results)} pages, {errors} errors, {avg_time}s avg, {len(dup_titles)} dup titles, {len(orphans)} orphans")
        yield f"data: {json.dumps({'type': 'complete', 'total': len(results), 'summary': summary, 'inlinks': inlinks_payload, 'reports': reports})}\n\n"
        yield "data: [DONE]\n\n"
        ACTIVE_CRAWL_RULES.pop(crawl_id, None)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        }
    )


# =============================================================================
# Saved crawls — store / list / load / delete / compare
# Storage: ~/.site-crawler-crawls/  (LOCAL ONLY, never pushed to git).
# Open to all users on this instance — saved crawls are shared.
# Note: this is pure file I/O + diff math. No AI / LLM involved.
# =============================================================================

_CRAWL_FOLDER = os.path.expanduser('~/.site-crawler-crawls')

@app.route('/crawl/save', methods=['POST'])
def crawl_save():
    body = request.json or {}
    name = (body.get('name') or '').strip() or f'crawl-{int(time.time())}'
    results = body.get('results') or []
    inlinks = body.get('inlinks') or {}
    reports = body.get('reports') or {}
    if not results:
        return jsonify({'error': 'No crawl data supplied'}), 400
    os.makedirs(_CRAWL_FOLDER, exist_ok=True)
    safe = _re.sub(r'[^A-Za-z0-9._-]', '_', name)[:80]
    path = os.path.join(_CRAWL_FOLDER, f'{int(time.time())}_{safe}.json')
    try:
        with open(path, 'w') as f:
            json.dump({
                'name': name,
                'saved_at': int(time.time()),
                'pages': len(results),
                'seed': (results[0].get('url') if results else ''),
                'saved_by': (request.remote_addr or 'anon'),
                'results': results,
                'inlinks': inlinks,
                'reports': reports,
            }, f)
    except Exception as e:
        return jsonify({'error': f'Save failed: {str(e)[:200]}'}), 500
    # 30-day cleanup
    try:
        cutoff = int(time.time()) - 30 * 86400
        for fn in os.listdir(_CRAWL_FOLDER):
            if not fn.endswith('.json'):
                continue
            fp = os.path.join(_CRAWL_FOLDER, fn)
            try:
                with open(fp) as f:
                    d = json.load(f)
            except Exception:
                continue
            if (d.get('saved_at') or 0) < cutoff:
                try: os.remove(fp)
                except OSError: pass
    except Exception:
        pass
    return jsonify({'ok': True, 'file': os.path.basename(path), 'name': name})


@app.route('/crawl/list', methods=['GET'])
def crawl_list():
    """List ALL saved crawls from the last 30 days (shared across users)."""
    if not os.path.isdir(_CRAWL_FOLDER):
        return jsonify({'crawls': []})
    cutoff = int(time.time()) - 30 * 86400
    out = []
    for fn in sorted(os.listdir(_CRAWL_FOLDER), reverse=True):
        if not fn.endswith('.json'): continue
        path = os.path.join(_CRAWL_FOLDER, fn)
        try:
            with open(path) as f: d = json.load(f)
            if (d.get('saved_at') or 0) < cutoff: continue
            out.append({
                'file': fn,
                'name': d.get('name', fn),
                'saved_at': d.get('saved_at'),
                'pages': d.get('pages', 0),
                'seed': d.get('seed', ''),
                'saved_by': d.get('saved_by', '') or 'unknown',
            })
        except Exception:
            continue
    return jsonify({'crawls': out})


@app.route('/crawl/load', methods=['GET'])
def crawl_load():
    fn = request.args.get('file', '')
    if not fn or '/' in fn or '\\' in fn or not fn.endswith('.json'):
        return jsonify({'error': 'Invalid file'}), 400
    path = os.path.join(_CRAWL_FOLDER, fn)
    if not os.path.exists(path):
        return jsonify({'error': 'Not found'}), 404
    try:
        with open(path) as f: d = json.load(f)
    except Exception as e:
        return jsonify({'error': f'Load failed: {str(e)[:200]}'}), 500
    return jsonify({
        'results': d.get('results', []),
        'inlinks': d.get('inlinks', {}),
        'reports': d.get('reports', {}),
        'name': d.get('name', ''),
        'seed': d.get('seed', ''),
    })


@app.route('/crawl/delete', methods=['POST'])
def crawl_delete():
    fn = (request.json or {}).get('file', '')
    if not fn or '/' in fn or '\\' in fn or not fn.endswith('.json'):
        return jsonify({'error': 'Invalid file'}), 400
    path = os.path.join(_CRAWL_FOLDER, fn)
    if not os.path.exists(path):
        return jsonify({'error': 'Not found'}), 404
    try:
        os.remove(path)
    except Exception as e:
        return jsonify({'error': f'Delete failed: {str(e)[:200]}'}), 500
    return jsonify({'ok': True})


@app.route('/crawl/compare', methods=['POST'])
def crawl_compare():
    """Diff two crawls. Accepts {a_file, b_file} or {a_file, b_results}.
    Returns aggregate metrics, issues comparison, structure diff,
    plus added/removed/changed URL lists."""
    body = request.json or {}

    def _load_file(fn):
        if not fn or '/' in fn or '\\' in fn or not fn.endswith('.json'):
            return None, 'Invalid file'
        fp = os.path.join(_CRAWL_FOLDER, fn)
        if not os.path.exists(fp):
            return None, 'Not found'
        try:
            with open(fp) as f: d = json.load(f)
        except Exception as e:
            return None, f'Load failed: {str(e)[:200]}'
        return d, None

    a_file = body.get('a_file', '')
    a_data, err = _load_file(a_file)
    if err: return jsonify({'error': err}), 400
    a_results = a_data.get('results', [])
    a_meta = {'name': a_data.get('name',''), 'saved_at': a_data.get('saved_at'), 'pages': a_data.get('pages', len(a_results))}

    b_file = body.get('b_file', '')
    b_results_in = body.get('b_results')
    if b_file:
        b_data, err = _load_file(b_file)
        if err: return jsonify({'error': err}), 400
        b_results = b_data.get('results', [])
        b_meta = {'name': b_data.get('name',''), 'saved_at': b_data.get('saved_at'), 'pages': b_data.get('pages', len(b_results))}
    elif isinstance(b_results_in, list):
        b_results = b_results_in
        b_meta = {'name': 'Current crawl (in memory)', 'saved_at': int(time.time()), 'pages': len(b_results)}
    else:
        return jsonify({'error': 'Supply b_file or b_results'}), 400

    def _key(u):
        return (u or '').rstrip('/').lower()
    a_by = {_key(r.get('url')): r for r in a_results if r.get('url')}
    b_by = {_key(r.get('url')): r for r in b_results if r.get('url')}
    a_urls = set(a_by.keys()); b_urls = set(b_by.keys())
    added = sorted(b_urls - a_urls); removed = sorted(a_urls - b_urls)
    shared = a_urls & b_urls

    watch = (
        'status_code', 'title', 'title_len', 'meta_description', 'meta_len',
        'h1', 'word_count', 'canonical', 'redirect_url', 'indexable',
        'depth', 'response_time', 'internal_links', 'external_links',
        'images_no_alt', 'body_hash',
    )
    def _norm_list(v):
        if v is None: return ''
        if isinstance(v, list): return ', '.join(sorted(str(x) for x in v))
        return str(v)
    changed = []
    for k in sorted(shared):
        ar = a_by[k]; br = b_by[k]
        diffs = {}
        for f in watch:
            av = ar.get(f); bv = br.get(f)
            if (av if av is not None else '') != (bv if bv is not None else ''):
                diffs[f] = {'old': av, 'new': bv}
        sa = _norm_list(ar.get('schema_types')); sb = _norm_list(br.get('schema_types'))
        if sa != sb:
            diffs['schema_types'] = {'old': sa or '—', 'new': sb or '—'}
        if diffs:
            changed.append({'url': ar.get('url') or br.get('url'), 'diffs': diffs})

    def _agg(rows):
        n = len(rows); codes = {'2xx':0,'3xx':0,'4xx':0,'5xx':0,'other':0}
        errors=warns=indexable=noindex=with_schema=redirects=missing_title=missing_meta=missing_h1=missing_canonical=title_too_long=meta_too_long=thin=slow=no_alt=0
        depths=[]; rts=[]
        for r in rows:
            sc = r.get('status_code') or 0
            if 200 <= sc < 300: codes['2xx'] += 1
            elif 300 <= sc < 400: codes['3xx'] += 1
            elif 400 <= sc < 500: codes['4xx'] += 1
            elif 500 <= sc < 600: codes['5xx'] += 1
            else: codes['other'] += 1
            if sc >= 400 or r.get('error'): errors += 1
            if r.get('issues'): warns += 1
            depths.append(r.get('depth') or 0)
            if r.get('response_time'): rts.append(r['response_time'])
            if r.get('indexable') is True: indexable += 1
            elif r.get('indexable') is False: noindex += 1
            if r.get('schema_types'): with_schema += 1
            if r.get('redirect_url'): redirects += 1
            if not r.get('title'): missing_title += 1
            elif (r.get('title_len') or 0) > 60: title_too_long += 1
            if not r.get('meta_description'): missing_meta += 1
            elif (r.get('meta_len') or 0) > 160: meta_too_long += 1
            if not r.get('h1'): missing_h1 += 1
            if not r.get('canonical'): missing_canonical += 1
            if (r.get('word_count') or 0) < 200: thin += 1
            if (r.get('response_time') or 0) > 3: slow += 1
            no_alt += int(r.get('images_no_alt') or 0)
        return {'pages':n,'codes':codes,'errors':errors,'warns_pages':warns,
                'max_depth':max(depths) if depths else 0,
                'avg_depth':round(sum(depths)/len(depths),2) if depths else 0,
                'avg_response_time':round(sum(rts)/len(rts),2) if rts else 0,
                'indexable':indexable,'noindex':noindex,'with_schema':with_schema,
                'redirects':redirects,'missing_title':missing_title,'missing_meta':missing_meta,
                'missing_h1':missing_h1,'missing_canonical':missing_canonical,
                'title_too_long':title_too_long,'meta_too_long':meta_too_long,
                'thin':thin,'slow':slow,'images_no_alt':no_alt}
    agg_a = _agg(a_results); agg_b = _agg(b_results)

    def _normalize_issue(s):
        if not s: return s
        out = _re.sub(r'\s*\([^)]*\)\s*$', '', s).strip()
        out = _re.sub(r'^\d+\s+', '', out).strip()
        return out or s
    def _issue_url_sets(rows):
        m = {}
        for r in rows:
            url = r.get('url') or ''
            seen = set()
            for issue in (r.get('issues') or []):
                norm = _normalize_issue(issue)
                if not norm or norm in seen: continue
                seen.add(norm)
                m.setdefault(norm, set()).add(url)
        return m
    urls_a_by_issue = _issue_url_sets(a_results)
    urls_b_by_issue = _issue_url_sets(b_results)
    issues_compare = []
    _URL_CAP = 500
    for iss in sorted(set(urls_a_by_issue) | set(urls_b_by_issue)):
        ua = urls_a_by_issue.get(iss, set()); ub = urls_b_by_issue.get(iss, set())
        ia = len(ua); ib = len(ub)
        if ia == ib == 0: continue
        only_a = sorted(ua - ub)[:_URL_CAP]
        only_b = sorted(ub - ua)[:_URL_CAP]
        both   = sorted(ua & ub)[:_URL_CAP]
        issues_compare.append({
            'issue': iss, 'a': ia, 'b': ib, 'delta': ib - ia,
            'only_a': only_a, 'only_b': only_b, 'both': both,
            'only_a_total': len(ua - ub),
            'only_b_total': len(ub - ua),
            'both_total':   len(ua & ub),
        })
    issues_compare.sort(key=lambda x: (abs(x['delta']), x['a'] + x['b']), reverse=True)

    from urllib.parse import urlparse as _urlp
    def _dir_counts(rows):
        c = {}
        for r in rows:
            try: p = _urlp(r.get('url') or '').path or '/'
            except Exception: p = '/'
            seg = '/' + p.lstrip('/').split('/', 1)[0] + ('/' if '/' in p.lstrip('/') else '')
            if seg in ('/', '/'): seg = '/' if p == '/' else seg
            c[seg] = c.get(seg, 0) + 1
        return c
    dirs_a = _dir_counts(a_results); dirs_b = _dir_counts(b_results)
    structure = []
    for d in sorted(set(dirs_a) | set(dirs_b)):
        da = dirs_a.get(d, 0); db = dirs_b.get(d, 0)
        if da == db == 0: continue
        structure.append({'path': d, 'a': da, 'b': db, 'delta': db - da})
    structure.sort(key=lambda x: -(x['a'] + x['b']))

    return jsonify({
        'a': a_meta, 'b': b_meta,
        'aggregate': {'a': agg_a, 'b': agg_b},
        'issues': issues_compare,
        'structure': structure[:30],
        'added': [{'url': b_by[k].get('url'), 'status_code': b_by[k].get('status_code'), 'title': b_by[k].get('title')} for k in added],
        'removed': [{'url': a_by[k].get('url'), 'status_code': a_by[k].get('status_code'), 'title': a_by[k].get('title')} for k in removed],
        'changed': changed,
        'summary': {'added': len(added), 'removed': len(removed),
                    'changed': len(changed), 'unchanged': len(shared) - len(changed)},
    })


@app.route('/crawl/update-rules', methods=['POST'])
def crawl_update_rules():
    """Apply new include/exclude patterns to a crawl that's already running.

    The crawl_id is issued in the 'start' SSE event. Patterns use robots.txt
    syntax (Google's spec): ``*`` is any sequence, ``$`` at end anchors end of
    URL, everything else is literal (including ``?``).
    """
    payload = request.get_json(silent=True) or {}
    crawl_id = (payload.get('crawl_id') or '').strip()
    if not crawl_id or crawl_id not in ACTIVE_CRAWL_RULES:
        return jsonify({'ok': False, 'error': 'No active crawl with that id'}), 404

    def _parse(raw):
        if not raw:
            return []
        return [p.strip() for p in raw.splitlines() if p.strip() and not p.strip().startswith('#')]

    new_excl = _parse(payload.get('exclude_patterns', ''))
    new_incl = _parse(payload.get('include_patterns', ''))
    ACTIVE_CRAWL_RULES[crawl_id] = {'include': new_incl, 'exclude': new_excl}
    app.logger.info(f"[crawler] {crawl_id} rules updated: {len(new_excl)} exclude, {len(new_incl)} include")
    return jsonify({'ok': True, 'exclude': new_excl, 'include': new_incl})



if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002, debug=False, threaded=True)

