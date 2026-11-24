#!/usr/bin/env python3
"""End to end: crawl a site built to carry every fault, assert what comes back.

test_page_checks.py calls each check with a fixture string. This does the whole
pipeline instead: a real site over real HTTP, through the real crawl route, and
then asserts the issue list on each row. It catches what unit tests cannot, such
as a check that never gets called, a crawl-level pass that does not run, or a
finding attached to the wrong URL.

Every page carries ONE named fault, so a failure names the broken check. The
clean pages are asserted too, because a check that fires everywhere is as
useless as one that never fires.

    python3 tests/test_fixture_site.py

No network: the fixture is served from 127.0.0.1 and the crawler runs in
process. Takes about 20 seconds.
"""
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(HERE, 'fixture_site'))

PASS = 0
FAILURES = []


def check(name, cond):
    global PASS
    if cond:
        PASS += 1
    else:
        FAILURES.append(name)


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ── build and serve the fixture ───────────────────────────────────────────────
import build as fixture_build          # noqa: E402
import serve as fixture_serve          # noqa: E402

SITE_PORT = free_port()
BASE = f'http://127.0.0.1:{SITE_PORT}'
fixture_build.build(BASE)
httpd, _ = fixture_serve.start(SITE_PORT)

# ── run the real crawler in process ───────────────────────────────────────────
import app as crawler                  # noqa: E402

CRAWL_PORT = free_port()
threading.Thread(
    target=lambda: crawler.app.run(host='127.0.0.1', port=CRAWL_PORT,
                                   debug=False, threaded=True),
    daemon=True).start()

for _ in range(60):
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{CRAWL_PORT}/', timeout=1).read()
        break
    except Exception:
        time.sleep(0.25)


def post(path, payload, timeout=120):
    req = urllib.request.Request(
        f'http://127.0.0.1:{CRAWL_PORT}{path}', data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=timeout)


rows, complete = [], None
# solve_challenges off: the fixture's bot checks never clear, and the headed
# browser would only add its settle timeout to every one of them.
with post('/crawl', {'url': BASE + '/', 'max_pages': 70, 'delay': 0,
                     'render_js': False, 'solve_challenges': False}, timeout=300) as resp:
    for raw in resp:
        line = raw.decode('utf-8', 'replace').strip()
        if not line.startswith('data: '):
            continue
        msg = json.loads(line[6:])
        kind = msg.get('type')
        if kind == 'page':
            rows.append(msg.get('data') or msg)
        elif kind == 'limit_reached':
            post('/crawl/continue', {'crawl_id': msg.get('crawl_id'),
                                     'action': 'finalize'}, timeout=30).read()
        elif kind == 'complete':
            complete = msg
            break

# ── sitemap analysis, through the route the UI calls after every crawl ───────
# Inlinks are built the way the browser builds them, from each row's links.
inlinks = {}
for _r in rows:
    for _entry in (_r.get('internal_link_urls') or []):
        _target = _entry[0] if isinstance(_entry, list) else _entry
        if _target:
            inlinks.setdefault(_target, []).append({'source': _r.get('url')})
try:
    with post('/sitemap-analyse', {'domain': BASE, 'results': rows,
                                   'inlinks': inlinks}, timeout=60) as resp:
        sitemap = json.loads(resp.read())
except urllib.error.HTTPError as e:
    sitemap = {'http_error': e.code}

# ── bot readability, through the streaming route the UI calls ────────────────
BOT_PAGES = ['/about/', '/bot-blocked/', '/bot-cloaked/', '/bot-thin/', '/bot-mobile-thin/',
             '/bot-redirect/', '/bot-noindex/', '/bot-js/', '/bot-noindex-js/']
bots, bot_progress = {}, 0
with post('/bot-check', {'urls': [BASE + p for p in BOT_PAGES], 'delay': 0}, timeout=300) as resp:
    for raw in resp:
        line = raw.decode('utf-8', 'replace').strip()
        if not line.startswith('data: '):
            continue
        ev = json.loads(line[6:])
        if ev.get('type') == 'progress':
            bot_progress += 1
        elif ev.get('type') == 'result':
            bots = ev['report']
        elif ev.get('type') == 'error':
            bots = {'error': ev.get('error')}

httpd.shutdown()


def _key(u):
    """Path only, no query, no trailing slash. The search page is reached as
    /search/?q=widgets, so keying on the raw URL would never match it."""
    u = (u or '').split('?')[0].split('#')[0]
    return u.rstrip('/')


by_url = {}
for r in rows:
    by_url.setdefault(_key(r.get('url')), r)
    if r.get('original_url'):
        by_url.setdefault(_key(r['original_url']), r)

# The crawl-level findings ride on the complete event, because they cannot
# exist until every row is in and the rows were streamed long before that. The
# browser merges them onto the rows it holds; this does the same, so the test
# exercises the same path the UI does.
late = (complete or {}).get('late_issues') or {}
for _u, _list in late.items():
    _row = by_url.get(_key(_u))
    if not _row:
        continue
    _row.setdefault('issues', [])
    for _i in _list:
        if _i not in _row['issues']:
            _row['issues'].append(_i)


def issues(path):
    row = by_url.get(_key(BASE + path))
    return [i.lower() for i in (row.get('issues') or [])] if row else None


def fires(path, fragment):
    got = issues(path)
    if got is None:
        return False
    return any(fragment.lower() in i for i in got)


def quiet(path, fragment):
    got = issues(path)
    if got is None:
        return False
    return not any(fragment.lower() in i for i in got)


# ── the crawl itself ──────────────────────────────────────────────────────────
check('the crawl completed', complete is not None)
check('the crawl found the fixture pages', len(rows) >= 18)
for path in ('/', '/lorem', '/images-no-dims', '/dead-end', '/blog',
             '/only-from-noindex', '/hreflang-en', '/big', '/no-head'):
    check(f'crawled {path or "/"}', issues(path) is not None)

# ── one fault per page ────────────────────────────────────────────────────────
check('lorem ipsum is found', fires('/lorem', 'lorem ipsum placeholder'))
check('images with no dimensions are found',
      fires('/images-no-dims', 'image(s) with no width or height'))
check('the sized image is not counted',
      fires('/images-no-dims', '2 image(s) with no width or height'))
check('the insecure form is found',
      fires('/forms-insecure', 'form(s) submit over http'))
check('local and staging links are found',
      fires('/local-links', 'link(s) to a local or staging host'))
check('the real website is not called staging',
      quiet('/local-links', 'dev.to'))
check('the canonical fragment is found',
      fires('/canonical-fragment', 'canonical contains a fragment'))
check('a canonical naming a 404 is found',
      fires('/canonical-to-404', 'canonical points to a non-200'))
# /old-url/ redirects to /redirect-target/, which nothing else links to. The row
# is stored under the landing URL, so it is a page and gets the content checks.
check('a page reached only through a redirect still gets the content checks',
      fires('/redirect-target/', 'title too short'))
check('a canonical naming a redirect is found',
      fires('/canonical-to-redirect', 'canonical points to a url that redirects'))

# /redirect-links/ links /about (301 to /about/, which the nav links) and
# /moved/ (301 to /services/). Both land on pages the crawl holds anyway. The
# redirect is either its own row (url = where it starts) or, when it was
# fetched before the page it lands on, the landing row's original_url.


def _redirect_from(path):
    want = BASE + path
    return next((r for r in rows if r.get('redirect_status') == 301
                 and want in (r.get('url'), r.get('original_url'))
                 and r.get('redirect_url') not in (None, want)), None)


_about_rd, _moved_rd = _redirect_from('/about'), _redirect_from('/moved/')
check('a link to a slash twin that redirects is reported',
      bool(_about_rd) and _about_rd.get('redirect_url') == BASE + '/about/')
check('a redirect landing on a page the crawl already holds is reported',
      bool(_moved_rd) and _moved_rd.get('redirect_url') == BASE + '/services/')
check('redirects are counted as 3xx',
      (((complete or {}).get('reports') or {}).get('response_codes') or {}).get('3xx', 0) >= 1)
check('a page reached directly and through a redirect keeps one row',
      sum(1 for r in rows if r.get('url') == BASE + '/services/') == 1
      and sum(1 for r in rows if r.get('url') == BASE + '/about/') == 1)
check('a bare query key is fetched as written, not rewritten to key=',
      not any(str(r.get(k) or '').endswith('?view=') for r in rows for k in ('url', 'original_url'))
      and any(r.get('url') == BASE + '/services/?view' for r in rows))
check('the URL normaliser keeps a bare key and still drops utm',
      crawler._normalize_crawl_url(BASE + '/p/?et_blog&utm_source=x&b=1') == BASE + '/p/?et_blog&b=1')
# /placement/: body classes name a header, a footer and a nav; none of them is a region.
_pl_row = by_url.get(_key(BASE + '/placement/')) or {}
_pl = {_key(t): p for t, _a, p in (_pl_row.get('internal_link_urls') or [])}
check(f'a copy link is copy although the body class names a footer (got {_pl.get(_key(BASE + "/clean-second/"))})',
      _pl.get(_key(BASE + '/clean-second/')) in ('body', 'main'))
check(f'a class word like navy is not a nav (got {_pl.get(_key(BASE + "/dead-end/"))})',
      _pl.get(_key(BASE + '/dead-end/')) in ('body', 'main'))
check(f'a Divi hero module is not the site header (got {_pl.get(_key(BASE + "/blog/"))})',
      _pl.get(_key(BASE + '/blog/')) in ('body', 'main'))
check('real regions keep their label: nav tag, footer and theme builder header classes',
      _pl.get(_key(BASE + '/about/')) == 'nav' and _pl.get(_key(BASE + '/lorem/')) == 'footer'
      and _pl.get(_key(BASE + '/accents/')) == 'header')
# /inert-markup/: SVG icon titles, a menu <template>, a script string and a
# quick-view dialog are not faults; the lifestyle photo with alt="" is.
check('crawled /inert-markup', issues('/inert-markup') is not None)
check('SVG icon titles after an early head close are not "title outside head"',
      quiet('/inert-markup', 'title outside head'))
check('SVG and template titles are not multiple title tags',
      quiet('/inert-markup', 'multiple title tags'))
check('a quick-view dialog h2 ahead of main does not start the outline',
      quiet('/inert-markup', 'first heading is h2'))
check('only the undescribed lifestyle photo is empty-alt content imagery',
      fires('/inert-markup', '1 imgs with empty alt on content imagery'))
check('a canonical naming a noindex page is found',
      fires('/canonical-to-noindex', 'canonical points to a non-indexable'))
check('a page with no outgoing links is found',
      fires('/dead-end', 'no internal outlinks'))
check('a page linked only from noindex is found',
      fires('/only-from-noindex', 'only from non-indexable'))
check('unreachable pagination is found',
      fires('/blog', 'pagination url(s) declared by rel'))
check('a one-way hreflang pair is found',
      fires('/hreflang-en', 'do not link back'))
# A repeated path segment is NOT asserted: the crawler refuses to fetch such a
# URL at all, which is a better defence than reporting on it afterwards.
check('the crawler never fetched the repeated-slug URL',
      issues('/blog/blog/post') is None)
check('an internal search page is found',
      fires('/search', 'internal search result page'))
check('a missing head element is found', fires('/no-head', 'no <head> element'))
check('a missing body element is found', fires('/no-body', 'no <body> element'))
check('an oversized document is found', fires('/big', 'over 2mb'))

# ── the clean pages must stay clean ───────────────────────────────────────────
NEW_FINDINGS = (
    'lorem ipsum placeholder', 'link(s) to a local or staging host',
    'form(s) submit over http', 'image(s) with no width or height',
    'pagination url(s) declared by rel', 'canonical contains a fragment',
    'canonical points to a', 'no <head> element', 'no <body> element',
    'over 2mb', 'no internal outlinks', 'only from non-indexable',
    'do not link back', 'repetitive path', 'internal search result page',
)
for path, label in (('/', 'the home page'), ('/clean-second', 'the clean second page'),
                    ('/about', 'the about page'), ('/services', 'the services page')):
    got = issues(path) or []
    noisy = [f for f in NEW_FINDINGS if any(f in i for i in got)]
    check(f'{label} carries none of the new findings (got {noisy})', not noisy)

# A site served from localhost must not have every link called a local link.
check('internal links on a localhost site are not called local links',
      quiet('/', 'link(s) to a local or staging host'))
check('a form posting to localhost is not called insecure',
      quiet('/', 'form(s) submit over http'))

# ── decoding ──────────────────────────────────────────────────────────────────
_acc = by_url.get(_key(BASE + '/accents/')) or {}
check(f'a page with no charset is read as UTF-8 (got {_acc.get("title")!r})',
      _acc.get('title') == 'Café crème brûlée')
check(f'its title length counts characters, not bytes (got {_acc.get("title_len")})',
      _acc.get('title_len') == 17)

# ── sitemap analysis ──────────────────────────────────────────────────────────
reports = sitemap.get('reports') or {}


def in_report(key, path):
    urls = [v.get('url') if isinstance(v, dict) else v for v in (reports.get(key) or [])]
    return any(_key(u) == _key(BASE + path) for u in urls)


check(f'sitemap analysis answers (got {sitemap.get("http_error") or "a report"})',
      'reports' in sitemap)
check('the sitemap is found through robots.txt', bool(sitemap.get('sitemaps_found')))
check('a sitemap URL that 404s is reported', in_report('non_200_in_sitemap', '/gone/'))
check('a sitemap URL that redirects is reported',
      in_report('redirects_in_sitemap', '/old-url/'))
check('a sitemap URL no page links to is reported',
      in_report('sitemap_only', '/sitemap-only/') or in_report('orphan_in_sitemap', '/sitemap-only/'))
_only = [v for v in (reports.get('sitemap_only') or []) if isinstance(v, dict) and _key(v.get('url')) == _key(BASE + '/sitemap-only/')]
check('a sitemap URL the crawl never fetched says how many crawled pages link to it',
      not _only or _only[0].get('linked_from') == 0)
check('a crawled page the sitemap leaves out is reported',
      in_report('missing_from_sitemap', '/clean-second/'))
check('a page the sitemap lists is not called missing',
      not in_report('missing_from_sitemap', '/about/'))
check('a linked page in the sitemap is not called an orphan',
      not in_report('orphan_in_sitemap', '/about/'))
check('a redirect row never stands in for its slash twin in the sitemap check',
      not in_report('non_200_in_sitemap', '/about/') and not in_report('redirects_in_sitemap', '/about/'))

# ── the raw-HTML parser behind the JS vs non-JS diff ─────────────────────────
_nojs = crawler._parse_no_js_subset(
    '<html><head><script type="application/ld+json">{"@type": "Organization"}</script></head>'
    '<body><div itemscope itemtype="https://schema.org/CreativeWork"><p>one two three</p></div>'
    '<script>var x = 1;</script></body></html>', BASE + '/')
check('the no-JS parser reads JSON-LD (scripts used to be stripped first)',
      'Organization' in _nojs['schema_types'])
check('the no-JS parser reads microdata, as the main parser does',
      'CreativeWork' in _nojs['schema_types'])
check('the no-JS word count still leaves scripts out', _nojs['word_count'] == 3)

# ── bot readability ───────────────────────────────────────────────────────────
def cell(path, agent):
    return (((bots.get('pages') or {}).get(BASE + path) or {}).get('cells') or {}).get(agent) or {}


def bot_issues(path):
    return (bots.get('page_issues') or {}).get(BASE + path) or []


check(f'the bot check returns a report (got {bots.get("error") or "one"})', 'pages' in bots)
check('the bot check streams its progress', bot_progress >= 2)
check('a clean page reads the same for every crawler',
      all(cell('/about/', a).get('state') == 'same'
          for a in ('googlebot', 'bingbot', 'applebot', 'oai-searchbot', 'perplexitybot', 'chatgpt-user', 'gptbot', 'ccbot')))
check('a 403 for one crawler is reported as blocked', cell('/bot-blocked/', 'gptbot').get('state') == 'blocked')
check('the block becomes an issue on the page',
      any(i.startswith('Training bot blocked: GPTBot') for i in bot_issues('/bot-blocked/')))
check('other crawlers on the blocked page are fine', cell('/bot-blocked/', 'perplexitybot').get('state') == 'same')
check('a different title for one crawler is reported',
      cell('/bot-cloaked/', 'googlebot').get('state') == 'different' and 'title' in cell('/bot-cloaked/', 'googlebot').get('fields', []))
check('a cut-down page for one crawler is thinner, not different',
      cell('/bot-thin/', 'perplexitybot').get('state') == 'thinner')
check('a redirect for one crawler is reported', cell('/bot-redirect/', 'bingbot').get('state') == 'redirected')
check('a noindex aimed at Googlebot applies to Googlebot only',
      cell('/bot-noindex/', 'googlebot').get('state') == 'noindex' and cell('/bot-noindex/', 'bingbot').get('state') == 'same')
check('mobile parity: a thin mobile page is reported',
      any(i.startswith('Mobile page has less content than desktop') for i in bot_issues('/bot-mobile-thin/')))
check('robots.txt: CCBot is disallowed on the bot pages only',
      ((bots.get('pages') or {}).get(BASE + '/bot-blocked/') or {}).get('robots', {}).get('ccbot') is False
      and ((bots.get('pages') or {}).get(BASE + '/about/') or {}).get('robots', {}).get('ccbot') is True)
# The sample keeps a start page the crawl reached through a redirect (the row is
# stored under the URL it landed on) and skips a row whose own URL redirects.
_rows = [{'url': BASE + '/', 'status_code': 200, 'depth': 0, 'content_type': 'text/html',
          'redirect_url': BASE + '/', 'original_url': 'http://localhost:1/'},
         {'url': BASE + '/about/', 'status_code': 200, 'depth': 1, 'content_type': 'text/html'},
         {'url': BASE + '/old-url/', 'status_code': 200, 'depth': 1, 'content_type': 'text/html',
          'redirect_url': BASE + '/redirect-target/'}]
_pick = crawler._bot_sample(_rows, 10)
check('the bot sample keeps a start page reached through a redirect', _pick[:1] == [BASE + '/'])
check('the bot sample skips a row whose own URL redirects elsewhere', BASE + '/old-url/' not in _pick)
check('crawlers without a published user agent are robots.txt only',
      any(a['id'] == 'claudebot' and not a['live'] for a in bots.get('agents', [])))
if bots.get('rendered'):
    check('content written by script is measured',
          any(i.startswith('Content needs JavaScript') for i in bot_issues('/bot-js/')))
    check('a noindex that script removes is reported',
          any(i.startswith('noindex in the HTML is removed by JavaScript') for i in bot_issues('/bot-noindex-js/')))
else:
    check('without JS rendering the report says so', any('not measured' in n for n in bots.get('notes', [])))

# AI directives, read on every crawled page during the crawl itself.
check('noarchive is reported with its documented meaning', fires('/bot-ai-directives', 'noarchive (bing keeps the page out of copilot'))
check('nocache is reported', fires('/bot-ai-directives', 'nocache (bing copilot shows only'))
check('a small max-snippet is reported', fires('/bot-ai-directives', 'max-snippet limits the text google can show'))
check('data-nosnippet sections are counted', fires('/bot-ai-directives', 'data-nosnippet keeps sections out of snippets and ai answers (1 section(s))'))
check('a noindex aimed at Googlebot is caught in the crawl', fires('/bot-noindex', 'noindex only for googlebot'))

# Bot checks served as 2xx pages are blocked rows, not pages missing a title.
check('a 200 bot check page is reported as a challenge',
      fires('/challenge-200', 'bot challenge served instead of the page (http 200)'))
check('a 200 bot check page gets no content findings',
      quiet('/challenge-200', 'missing h1') and quiet('/challenge-200', 'thin content')
      and quiet('/challenge-200', 'title too short'))
check('a 202 sgcaptcha page is reported as a challenge',
      fires('/challenge-202', 'bot challenge served instead of the page (http 202)'))
check('a bot check row carries an error', bool((by_url.get(_key(BASE + '/challenge-200/')) or {}).get('error')))
# A redirect loop is reported once, named, and not retried into the host.
check('a redirect loop is reported', fires('/loop-a', 'redirect loop: '))
check('the loop starts at the requested URL and names the one that repeats',
      fires('/loop-a', f'redirect loop: {BASE}/loop-a/ -> {BASE}/loop-b/ -> {BASE}/loop-a/'))
check(f'a redirect loop is not retried (loop GETs: {fixture_serve.LOOP_HITS[0]})',
      0 < fixture_serve.LOOP_HITS[0] <= 2 * (crawler.CRAWL_MAX_REDIRECTS + 1))
check('Shopify search parameters do not make a second row',
      not any(('_pos=' in (r.get('url') or '') or '_sid=' in (r.get('url') or '')) for r in rows))
import agent_tools as _at   # noqa: E402
check('a bot check page is an error', _at.sev_of('Bot challenge served instead of the page (HTTP 200): x') == 'error')
check('a redirect loop is an error', _at.sev_of('Redirect loop: a -> b -> a') == 'error')
check('normal redirects stay warnings', _at.sev_of('Redirect (1 hop)') == 'warn')

# ── report ────────────────────────────────────────────────────────────────────
if FAILURES:
    for f in FAILURES:
        print('FAIL: ' + f)
    print('\ncrawled URLs and how many late findings arrived:')
    print(f'  late_issues on the complete event: {len(late)} url(s)')
    for u in sorted(by_url):
        print('   ' + (u.replace(BASE, '') or '/'))
    print(f'{PASS}/{PASS + len(FAILURES)} fixture-site checks passed')
    sys.exit(1)
print(f'{PASS}/{PASS} fixture-site checks passed ({len(rows)} pages crawled)')
