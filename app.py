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
import re as _re
import time
import logging
import threading
from collections import deque, defaultdict as _dd
from urllib.parse import urlparse, urljoin, urlunparse, parse_qs, urlencode
from bs4 import BeautifulSoup

app = Flask(__name__, static_folder='static', template_folder='templates')
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')


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

def fetch_site_structure(url):
    """Fetch sitemap(s) to discover all pages, services, products, and categories on the site.
    Groups URLs by their sitemap source for accurate categorisation."""
    import xml.etree.ElementTree as ET
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    homepage = get_homepage_url(url)
    structure = {'pages': [], 'products': [], 'categories': [], 'posts': []}

    def parse_sitemap_urls(sitemap_url):
        """Fetch a sitemap and return list of URLs."""
        try:
            resp = requests.get(sitemap_url, headers=headers, timeout=10)
            if resp.status_code != 200:
                return []
            root = ET.fromstring(resp.content)
            ns = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
            sitemaps = root.findall('.//s:sitemap/s:loc', ns)
            if sitemaps:
                return [s.text for s in sitemaps]
            return [loc.text for loc in root.findall('.//s:url/s:loc', ns)]
        except Exception:
            return []

    try:
        sitemap_index = parse_sitemap_urls(f"{homepage.rstrip('/')}/sitemap.xml")
        if not sitemap_index:
            return structure

        for item in sitemap_index:
            if not item.endswith('.xml'):
                structure['pages'].append(item)
                continue

            # Categorise by sitemap filename
            sitemap_name = item.split('/')[-1].lower()
            urls = parse_sitemap_urls(item)

            if 'product_cat' in sitemap_name or 'category-sitemap' in sitemap_name:
                structure['categories'].extend(urls)
            elif 'product' in sitemap_name:
                structure['products'].extend(urls)
            elif 'post' in sitemap_name:
                structure['posts'].extend(urls)
            else:
                # page-sitemap, local-sitemap, etc.
                structure['pages'].extend(urls)
    except Exception:
        pass

    return structure



def summarise_site_structure(structure):
    """Turn site structure into a concise text summary for the LLM context."""
    lines = []

    def url_to_entry(u):
        """Extract a readable name from a URL, with the URL for linking."""
        path = u.rstrip('/').split('/')[-1]
        name = path.replace('-', ' ').replace('_', ' ').title()
        return f"{name} ({u})"

    if structure.get('categories'):
        entries = [url_to_entry(u) for u in structure['categories'][:25]]
        lines.append(f"Product/service categories ({len(structure['categories'])}):")
        for e in entries:
            lines.append(f"  - {e}")

    if structure.get('products'):
        entries = [url_to_entry(u) for u in structure['products'][:30]]
        lines.append(f"Products ({len(structure['products'])}):")
        for e in entries:
            lines.append(f"  - {e}")

    if structure.get('pages'):
        entries = [url_to_entry(u) for u in structure['pages'][:25]]
        lines.append(f"Pages ({len(structure['pages'])}):")
        for e in entries:
            lines.append(f"  - {e}")

    if structure.get('posts'):
        entries = [url_to_entry(u) for u in structure['posts'][:15]]
        lines.append(f"Blog posts ({len(structure['posts'])}):")
        for e in entries:
            lines.append(f"  - {e}")

    return '\n'.join(lines)



def _normalize_crawl_url(url):
    """Normalize URL for deduplication: strip fragments, utm params, lowercase host.

    Preserves the trailing slash as found in the source href. Stripping slashes
    was manufacturing phantom 'Trailing slash redirect' issues — we'd queue
    /foo after seeing <a href="/foo/"> and then be surprised when the server
    redirected us back. We also couldn't show inlinks because the inlinks_map
    key and result['url'] didn't line up with the anchor as written.
    """
    from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
    parsed = urlparse(url)
    path = parsed.path or '/'
    if parsed.query:
        params = parse_qs(parsed.query, keep_blank_values=True)
        cleaned = {k: v for k, v in params.items() if not k.startswith('utm_') and k not in ('fbclid', 'gclid', 'mc_cid', 'mc_eid')}
        query = urlencode(cleaned, doseq=True)
    else:
        query = ''
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), path, '', query, ''))


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


def _crawl_page(url, session, domain, pw_page=None):
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
        'schema_types': [], 'indexable': True, 'issues': [], 'error': None,
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

        # Schema types
        for script in soup.find_all('script', attrs={'type': 'application/ld+json'}):
            try:
                ld = json.loads(script.string or '')
                if isinstance(ld, dict):
                    if '@type' in ld: result['schema_types'].append(ld['@type'])
                    if '@graph' in ld:
                        for item in ld['@graph']:
                            if isinstance(item, dict) and '@type' in item:
                                result['schema_types'].append(item['@type'])
                elif isinstance(ld, list):
                    for item in ld:
                        if isinstance(item, dict) and '@type' in item:
                            result['schema_types'].append(item['@type'])
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

        # Word count (strip nav/footer/script/style)
        soup_body = BeautifulSoup(raw_html, 'html.parser')
        for tag in soup_body(['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript']):
            tag.decompose()
        body_text = soup_body.get_text(separator=' ', strip=True)
        result['word_count'] = len(body_text.split()) if body_text else 0

        # Body hash for exact-duplicate detection — normalize whitespace first
        import hashlib as _hashlib
        _norm = ' '.join(body_text.lower().split())
        result['body_hash'] = _hashlib.md5(_norm.encode('utf-8', errors='ignore')).hexdigest() if _norm else ''

        # Mixed content: HTTPS page loading HTTP resources
        if result.get('security', {}).get('is_https'):
            mixed = []
            for tag_name, attr in (('img', 'src'), ('script', 'src'), ('link', 'href'),
                                    ('iframe', 'src'), ('video', 'src'), ('audio', 'src'),
                                    ('source', 'src')):
                for t in soup.find_all(tag_name, attrs={attr: True}):
                    v = t.get(attr, '').strip()
                    if v.startswith('http://'):
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

        # Issues detection — skip content/SEO checks for noindex pages
        # (noindex means Google won't rank it, so missing titles/metas/H1/alt
        # text / thin content / schema are irrelevant noise)
        if result['indexable']:
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
    # Per-host politeness delay (minimum gap between two requests to the SAME host).
    # Default 0.1s matches Screaming Frog's typical setting; workers on different hosts run freely.
    crawl_delay = max(float(data.get('crawl_delay', 0.1) or 0.1), 0.0)
    render_js = bool(data.get('render_js', False))
    ignore_robots = bool(data.get('ignore_robots', False))
    # Concurrent workers. Default 5 matches Screaming Frog. Clamped to [1, 20].
    # When render_js is on, Playwright can't share a single page across threads —
    # force single-worker mode so page state stays consistent.
    max_workers = int(data.get('max_workers', 5) or 5)
    max_workers = max(1, min(20, max_workers))
    if render_js:
        max_workers = 1

    # URL include/exclude patterns (simple glob: * wildcard, one per line).
    # Exclude beats include. If include is non-empty, URLs must match at least one.
    import fnmatch as _fnmatch
    def _parse_patterns(raw):
        if not raw: return []
        return [p.strip() for p in raw.splitlines() if p.strip() and not p.strip().startswith('#')]
    include_patterns = _parse_patterns(data.get('include_patterns', ''))
    exclude_patterns = _parse_patterns(data.get('exclude_patterns', ''))

    def _url_allowed(u):
        if exclude_patterns and any(_fnmatch.fnmatch(u, p) or _fnmatch.fnmatch(urlparse(u).path, p) for p in exclude_patterns):
            return False
        if include_patterns and not any(_fnmatch.fnmatch(u, p) or _fnmatch.fnmatch(urlparse(u).path, p) for p in include_patterns):
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
        yield f"data: {json.dumps({'type': 'start', 'domain': domain, 'workers': max_workers})}\n\n"

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
            pd = _crawl_page(url, session, domain, pw_page=pw_page)
            pd['depth'] = depth
            _adjust_host_backoff(url, pd)
            return url, depth, pd

        in_flight = {}  # future -> (url, depth)
        consecutive_errors = 0

        def _dequeue_next():
            """Pop the next URL that passes filters + robots. Returns (url, depth) or None."""
            while queue:
                url, depth = queue.popleft()
                if url in visited or depth > max_depth:
                    continue
                if not _url_allowed(url):
                    visited.add(url)
                    continue
                if not ignore_robots:
                    try:
                        if not rp.can_fetch('*', url):
                            visited.add(url)
                            continue
                    except Exception:
                        pass
                visited.add(url)
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
                            if link not in visited:
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
        def _group_by(field_getter):
            g = _dd(list)
            for r in results:
                if not r.get('indexable', True):
                    continue
                v = field_getter(r)
                if v:
                    g[v].append(r.get('url'))
            return {k: v for k, v in g.items() if len(v) > 1}

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

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        }
    )



if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002, debug=False, threaded=True)

