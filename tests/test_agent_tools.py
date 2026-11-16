#!/usr/bin/env python3
"""agent_tools.py and mcp_server.py, offline: no crawler app, no network.

1. The Python copies of sevOf() and _scIssueGroup() give the same answer as
   the ones in static/script.js for every quoted string in page_checks.py and
   app.py plus a hand-picked list (node runs the JS side).
2. build_brief() writes exactly the text _scBuildAiBrief() writes for the
   same crawl, and DEFAULT_PROMPT is the app's prompt word for word.
3. The browser-side steps done in Python (inlinks map, late issues, bot
   findings) behave like the browser.
4. mcp_server answers both MCP eras, including the fields current clients
   check (resultType, ttlMs, cacheScope), and refuses unknown versions.

    python3 tests/test_agent_tools.py
"""
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

import agent_tools as at  # noqa: E402
import mcp_server  # noqa: E402

PASS = 0
FAILURES = []


def check(name, cond):
    global PASS
    if cond:
        PASS += 1
    else:
        FAILURES.append(name)


NODE = shutil.which('node')
SRC = open(os.path.join(REPO, 'static', 'script.js'), encoding='utf-8').read()


def grab(header, end_needle):
    start = SRC.index(header)
    end = SRC.index(end_needle, start)
    return SRC[start:end + len(end_needle)]


def run_node(js, payload):
    proc = subprocess.run([NODE, '-e', js], input=json.dumps(payload), capture_output=True, text=True,
                          encoding='utf-8', timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-800:])
    return json.loads(proc.stdout)


# ── 1. severity and grouping parity ──────────────────────────────────────────
HAND_PICKED = [
    'Missing title', 'Missing H1', 'Missing meta description', 'Missing canonical', 'Missing viewport',
    'Title too long (72 chars)', 'Title too short (12)', 'Meta desc too long (190)', 'Meta desc too short (40)',
    'Multiple H1s (3)', 'H1 same as title', 'H1 identical to title tag', 'Missing Open Graph', 'Missing og:image',
    'Missing Twitter Card', 'Mixed content (2 resources)', 'noindex', 'Canonicalised', 'Thin content (90 words)',
    'Slow (2.4s)', 'No schema', 'Redirect (301)', 'Trailing slash redirect', 'HTTP→HTTPS redirect',
    'www normalization', '3 imgs missing alt', '2 imgs with empty alt', 'imgs missing alt',
    '4 image(s) with alt text over 150 characters', '2 internal link(s) point to HTTP',
    '5 internal link(s) are nofollow', '1 on-page anchor(s) point to nothing',
    '2 link(s) to a local or staging host (localhost)', '1 form(s) submit over HTTP',
    '7 image(s) with no width or height', '2 pagination URL(s) declared by rel=next not linked',
    '3 hreflang alternate(s) do not link back', 'Soft 404 (page says not found)',
    'HTML lang en-US does not match hreflang en-AU', 'Charset is ISO-8859-1', 'First heading is H2',
    'HTTP 404', 'HTTP 503 error', 'URL: uppercase letters', 'URL: double slash',
    'AI crawlers blocked in robots.txt: GPTBot, ClaudeBot', 'AI training bots blocked in robots.txt: CCBot',
    'Search engines blocked in robots.txt: Googlebot', 'Title outside head', 'Canonical is malformed',
    'Multiple conflicting canonicals', 'Noindex in the X-Robots-Tag header', 'Robots "none"',
    'Lorem ipsum placeholder text', 'No <head> element', 'Canonical points to a non-200 URL',
    'Search bot blocked: Googlebot (HTTP 403)', 'AI search bot challenged: OAI-SearchBot',
    'AI assistant bot blocked: ChatGPT-User', 'Training bot blocked: GPTBot (HTTP 403)',
    'Training bot sees different content: CCBot', 'Noindex only for Googlebot',
    'Multiple title tags', 'Canonical points to HTTP', 'Noindex plus a canonical', 'No compression',
    'Paginated page canonicalised to another URL', 'No lang attribute', 'H1 too long (90 chars)',
    'Meta description may truncate in results', 'No doctype', 'Nosnippet', 'Content needs JavaScript',
    'Mobile page has less content', 'Heading level skips (H2 to H4)', 'Served over HTTP',
    'Something entirely new (with detail)', '', 'x', '(starts with a bracket)', 'Title too long\n(two lines)',
]


def mined_strings():
    out = set()
    for fn in ('page_checks.py', 'app.py'):
        text = open(os.path.join(REPO, fn), encoding='utf-8').read()
        for m in re.finditer(r"f?(['\"])((?:(?!\1).){6,160})\1", text):
            s = re.sub(r'\{[^}]*\}', '3', m.group(2))
            if re.match(r'^[A-Z0-9]', s):
                out.add(s)
    return sorted(out)


CORPUS = HAND_PICKED + mined_strings()
check('the mined corpus is big enough to mean something', len(CORPUS) > 400)

if NODE:
    lifted = '\n'.join([grab('const _PAGE_CHECK_ERR_RE', ';\n'), grab('const _PAGE_CHECK_WARN_RE', ';\n'),
                        grab('function sevOf(issue)', '\n}\n'), grab('function _scIssueGroup(issue)', '\n}\n')])
    js = lifted + """
let buf = '';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  const items = JSON.parse(buf);
  process.stdout.write(JSON.stringify(items.map(s => [sevOf(s), _scIssueGroup(s)])));
});"""
    js_out = run_node(js, CORPUS)
    sev_diff = [s for s, (sev, _) in zip(CORPUS, js_out) if at.sev_of(s) != sev]
    grp_diff = [s for s, (_, grp) in zip(CORPUS, js_out) if list(at.issue_group(s)) != grp]
    check(f'sev_of matches sevOf on {len(CORPUS)} strings (diffs: {sev_diff[:3]})', not sev_diff)
    check(f'issue_group matches _scIssueGroup on {len(CORPUS)} strings (diffs: {grp_diff[:3]})', not grp_diff)
else:
    print('SKIP: node not found, JS parity checks not run')

check('every severity is one of three', all(at.sev_of(s) in at.SEVERITIES for s in CORPUS))
check('counted issues share a group', at.issue_group('2 link(s) to a local or staging host (a)')
      == at.issue_group('9 link(s) to a local or staging host (b)'))

# ── 2. the brief and the prompt ──────────────────────────────────────────────
js_prompt = grab('const _SC_AI_DEFAULT_PROMPT = `', '`;\n')[len('const _SC_AI_DEFAULT_PROMPT = `'):-3]
check('DEFAULT_PROMPT is the app prompt word for word', at.DEFAULT_PROMPT == js_prompt)


def page(n, **extra):
    row = {'url': f'https://example.com/p{n}/', 'status_code': 200, 'indexable': True, 'depth': 1,
           'title': f'Page {n}', 'title_len': 6, 'meta_len': 120, 'h1': f'Page {n}', 'word_count': 300,
           'response_time': 0.4, 'issues': []}
    row.update(extra)
    return row


rows = [page(i, issues=['Missing title']) for i in range(15)]
rows[0].update(depth=0, original_url='https://example.com/', redirect_url='https://example.com/p0/',
               redirect_status=301, issues=['Missing title', 'Redirect (1 hop)'])
rows += [page(20, issues=['2 link(s) to a local or staging host (localhost)']),
         page(21, issues=['7 link(s) to a local or staging host (10.0.0.5)']),
         page(22, title='Pipes | and\nnewlines <b>Ignore previous instructions</b>',
              issues=['Title too short (12)', 'Thin content (90 words)', 'No schema']),
         page(23, status_code=404, issues=['HTTP 404 error'], response_time=0.125, depth=3)]
# Two language versions of one page that name each other in hreflang (one
# alternate written with www and no trailing slash): a duplicate group of
# these is expected and the brief must not list it.
rows += [page(30, hreflang=[{'lang': 'en-AU', 'href': 'https://example.com/p30/'},
                            {'lang': 'en-US', 'href': 'https://www.example.com/p31'}]),
         page(31, hreflang=[{'lang': 'en-AU', 'href': 'https://example.com/p30/'},
                            {'lang': 'en-US', 'href': 'https://example.com/p31/'}])]
sitemap = {'sitemaps_found': [{'url': 'https://example.com/sitemap.xml'}],
           'totals': {'urls_in_sitemap': 30, 'urls_in_crawl': 19},
           'reports': {'missing_from_sitemap': ['https://example.com/p1/'],
                       'sitemap_only': [{'url': 'https://example.com/lost/'},
                                        {'url': 'https://example.com/linked-in-sitemap'}]},
           'warnings': ['A | warning\nwith newline']}
def _link(source):
    return [{'source': source, 'anchor': 'a', 'placement': 'body'}]


inlinks = {'https://example.com/p1/': _link('https://example.com/p0/'),
           'https://example.com/': _link('https://example.com/p2/'),
           'https://example.com/deep/': _link('https://example.com/p1/'),
           'https://example.com/file.pdf': _link('https://example.com/p1/'),
           'https://example.com/linked-in-sitemap/': _link('https://example.com/p2/')}
pairs = [{'url_a': 'https://example.com/p1/', 'url_b': 'https://example.com/p2/', 'similarity': 0.965}]
reports = {
    'duplicate_titles': [{'value': 'Same title', 'urls': [f'https://example.com/d{i}/' for i in range(7)]}],
    'duplicate_bodies': [{'value': 'x', 'urls': ['https://example.com/a/', 'https://example.com/b/']}],
    'duplicate_metas': [{'value': 'Same meta', 'urls': ['https://example.com/p30/', 'https://example.com/p31/']}],
    'redirect_chains': [{'url': 'https://example.com/old/', 'hops': 2,
                         'chain': [{'status': 301, 'url': 'https://example.com/mid/'},
                                   {'status': 200, 'url': 'https://example.com/new/'}]}],
    'url_traps': {'checked': True, 'soft_404': True, 'nested_trap': False},
    'bot_check': {'sample': ['https://example.com/p0/', 'https://example.com/p1/'],
                  'agents': [{'id': 'browser', 'label': 'Browser'}, {'id': 'gptbot', 'label': 'GPTBot'},
                             {'id': 'googlebot', 'label': 'Googlebot smartphone'}],
                  'verdicts': {'gptbot': {'counts': {'blocked': 2}, 'checked': 2},
                               'googlebot-desktop': {'counts': {'same': 2}, 'checked': 2},
                               'googlebot': {'counts': {'same': 2}, 'checked': 2}},
                  'page_issues': {'https://example.com/p0/': ['Training bot blocked: GPTBot (HTTP 403)']},
                  'notes': ['One note']},
}

if NODE:
    lifted = '\n'.join([grab('const _PAGE_CHECK_ERR_RE', ';\n'), grab('const _PAGE_CHECK_WARN_RE', ';\n'),
                        grab('function sevOf(issue)', '\n}\n'), grab('function _scIssueGroup(issue)', '\n}\n'),
                        grab('const _SC_AI_DEFAULT_PROMPT', '`;\n'), grab('function _scLocalDate()', '\n}\n'),
                        grab('function _scMdCell(v, max)', '\n}\n'),
                        grab('const _SC_CONVENTION = ', ']);\n'),
                        grab('function _scPageWeights(pages, inlinks)', '\n}\n'),
                        grab('function _scGroupScore(urls, total, weights)', '\n}\n'),
                        grab('function _scBuildAiBrief(opts)', '\n}\n')])
    js = """
let buf = '';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  const inp = JSON.parse(buf);
  let crawlerResults = inp.rows;
  const window = { crawlerReports: inp.reports, _ndPairs: inp.pairs };
  let crawlerSitemap = inp.sitemap;
  let crawlerInlinks = inp.inlinks;
  """ + lifted + """
  const outs = inp.opts.map(o => _scBuildAiBrief(o));
  process.stdout.write(JSON.stringify(outs));
});"""
    opt_sets = [{}, {'pageTable': False}, {'pageLimit': 5}, {'prompt': 'Short prompt for {site}'}, {'maxUrls': 3}]
    js_briefs = run_node(js, {'rows': rows, 'reports': reports, 'pairs': pairs, 'sitemap': sitemap,
                              'inlinks': inlinks, 'opts': opt_sets})
    crawl = {'results': json.loads(json.dumps(rows)), 'inlinks': json.loads(json.dumps(inlinks)),
             'reports': dict(json.loads(json.dumps(reports)), sitemap=sitemap, near_dup={'pairs': pairs})}
    for opts, js_text in zip(opt_sets, js_briefs):
        exported = re.search(r'- Exported: (\S+)', js_text).group(1)
        py_text = at.build_brief(crawl, prompt=opts.get('prompt'), page_table=opts.get('pageTable', True),
                                 page_limit=opts.get('pageLimit', 200), max_urls=opts.get('maxUrls', 10),
                                 today=exported)
        if py_text != js_text:
            for i, (a, b) in enumerate(zip(py_text.splitlines(), js_text.splitlines())):
                if a != b:
                    print(f'  brief differs at line {i + 1}:\n    py: {a!r}\n    js: {b!r}')
                    break
        check(f'build_brief matches _scBuildAiBrief with {opts or "defaults"}', py_text == js_text)
    check('the brief folds hreflang language versions out of the duplicate list',
          'Not listed: 1 group of language or region versions' in js_briefs[0]
          and '## Duplicate meta descriptions (0 groups)' in js_briefs[0])
    _warn = js_briefs[0].split('## Warnings (should fix)')[1].split('\n## ')[0] if '## Warnings (should fix)' in js_briefs[0] else ''
    check('the brief reports redirects in their own section, not under warnings',
          '## Redirects (not page issues' in js_briefs[0] and '### Redirect' not in _warn)
    empty_js = run_node(js, {'rows': [], 'reports': {}, 'pairs': [], 'sitemap': None, 'inlinks': {}, 'opts': [{}]})[0]
    exported = re.search(r'- Exported: (\S+)', empty_js).group(1)
    check('an empty crawl builds the same brief', at.build_brief({'results': []}, today=exported) == empty_js)

_ms = at.mcp_setup()
check('mcp_setup names this interpreter and the bundled server',
      _ms['args'][0].endswith('mcp_server.py') and _ms['server_exists'] and _ms['command'])
check('mcp_setup leaves out OSC_URL on the default address', 'env' not in _ms['config']['mcpServers']['open-seo-crawler'])
_ms2 = at.mcp_setup('http://127.0.0.1:5099/')
check('mcp_setup passes another address as OSC_URL',
      _ms2['config']['mcpServers']['open-seo-crawler'].get('env') == {'OSC_URL': 'http://127.0.0.1:5099'})
check('mcp_setup links the release bundle from server.json', _ms['bundle_url'].endswith('.mcpb'))
check('JS-style toFixed rounds halves up', at._to_fixed(0.125, 2) == '0.13' and at._to_fixed(0.4, 2) == '0.40')

# ── 3. the browser steps done in Python ──────────────────────────────────────
inl = at.build_inlinks([
    {'url': 'https://e.com/a/', 'internal_link_urls': [['https://e.com/b/', 'B', 'nav'], ['https://e.com/b/', 'B', 'main'],
                                                       ['https://e.com/b/', 'Bee', 'main'], 'https://e.com/c/', ['', 'x']]},
    {'url': 'https://e.com/c/', 'internal_link_urls': [['https://e.com/b/', 'B', 'footer']]},
])
check('inlinks keep one entry per source and anchor', [(e['source'], e['anchor']) for e in inl['https://e.com/b/']]
      == [('https://e.com/a/', 'B'), ('https://e.com/a/', 'Bee'), ('https://e.com/c/', 'B')])
check('inlinks keep the first placement seen', inl['https://e.com/b/'][0]['placement'] == 'nav')
check('plain string links count, empty ones do not', 'https://e.com/c/' in inl and '' not in inl)

late_rows = [{'url': 'https://e.com/a', 'issues': ['x']}, {'url': 'https://e.com/b/', 'original_url': 'https://e.com/old', 'issues': None}]
at.merge_late_issues(late_rows, {'https://e.com/a/': ['x', 'Dead end'], 'https://e.com/old/': ['Canonical conflict'],
                                 'https://e.com/zzz': ['ignored']})
check('late issues attach by URL without the trailing slash', late_rows[0]['issues'] == ['x', 'Dead end'])
check('late issues attach by original URL', late_rows[1]['issues'] == ['Canonical conflict'])

bot_rows = [{'url': 'https://e.com/a', 'issues': ['Missing H1']}, {'url': 'https://e.com/b', 'issues': []}]
at.merge_bot_issues({'page_issues': {'https://e.com/a': ['Search bot blocked: Googlebot']}}, bot_rows)
at.merge_bot_issues({'page_issues': {'https://e.com/b': ['Training bot blocked: CCBot']}}, bot_rows)
check('a second bot check replaces the first one\'s findings',
      bot_rows[0]['issues'] == ['Missing H1'] and bot_rows[1]['issues'] == ['Training bot blocked: CCBot'])
check('every row carries _bot_issues like the browser leaves it', all('_bot_issues' in r for r in bot_rows))

body, opts = at.crawl_settings({'url': 'example.com', 'exclude_patterns': ['/tag/*', '', '/cart']})
check('crawl settings start from the UI defaults', body['max_pages'] == 1500 and body['crawl_delay'] == 0.4
      and body['max_workers'] == 5 and body['max_depth'] == 10 and body['solve_challenges'] is True
      and opts['sitemap'] and opts['near_dup'] and opts['bot_check'] and opts['bot_sample'] == 10)
check('pattern lists become one per line', body['exclude_patterns'] == '/tag/*\n/cart')
check('compare_no_js needs render_js', at.crawl_settings({'url': 'x', 'compare_no_js': True})[0]['compare_no_js'] is False)
try:
    at.crawl_settings({'url': ''})
    check('a crawl without a URL is refused', False)
except at.ToolError:
    check('a crawl without a URL is refused', True)
check('autosave name matches the browser', at.autosave_name([{'url': 'https://example.com/a/b'}],
      now=at.datetime(2026, 1, 2, 3, 4)) == 'example.com - 2026-01-02 03:04')

# ── 4. the MCP server ────────────────────────────────────────────────────────
MODERN = {'_meta': {'io.modelcontextprotocol/protocolVersion': '2026-07-28'}}
h = mcp_server.handle

r = h({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}})
check('legacy initialize echoes a supported version', r['result']['protocolVersion'] == '2025-06-18'
      and 'resultType' not in r['result'] and r['result']['capabilities'].get('tools') is not None)
r = h({'jsonrpc': '2.0', 'id': 2, 'method': 'initialize', 'params': {'protocolVersion': '2099-01-01'}})
check('legacy initialize falls back to the newest legacy version', r['result']['protocolVersion'] == '2025-11-25')
check('notifications get no reply', h({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) is None)

r = h({'jsonrpc': '2.0', 'id': 3, 'method': 'server/discover', 'params': MODERN})['result']
check('discover lists the modern version and server info', r['supportedVersions'] == ['2026-07-28']
      and r['resultType'] == 'complete' and r['_meta']['io.modelcontextprotocol/serverInfo']['name'] == 'open-seo-crawler')

r = h({'jsonrpc': '2.0', 'id': 4, 'method': 'tools/list', 'params': MODERN})['result']
check('modern tools/list carries resultType, ttlMs and cacheScope',
      r['resultType'] == 'complete' and isinstance(r['ttlMs'], int) and r['cacheScope'] in ('public', 'private'))
names = [t['name'] for t in r['tools']]
check('tool names are unique', len(names) == len(set(names)))
check('every tool has a description and an object schema',
      all(t.get('description') and t['inputSchema'].get('type') == 'object' for t in r['tools']))
check('every tool is wired to a function', all(n in mcp_server.TOOL_NAMES for n in names)
      and all(mcp_server._call.__code__.co_consts.count(n) for n in names))
check('no tool description carries a dash the house style bans',
      not any(re.search('[\u2013\u2014]', json.dumps(t, ensure_ascii=False)) for t in r['tools']))

r = h({'jsonrpc': '2.0', 'id': 5, 'method': 'tools/list'})['result']
check('legacy tools/list has no modern-only fields', 'resultType' not in r and 'ttlMs' not in r)
r = h({'jsonrpc': '2.0', 'id': 6, 'method': 'prompts/list', 'params': MODERN})['result']
check('prompts/list offers seo_audit with cache fields', r['prompts'][0]['name'] == 'seo_audit' and 'ttlMs' in r)

r = h({'jsonrpc': '2.0', 'id': 7, 'method': 'tools/list',
       'params': {'_meta': {'io.modelcontextprotocol/protocolVersion': '1900-01-01'}}})
check('an unknown modern version gets UnsupportedProtocolVersionError',
      r['error']['code'] == -32022 and '2026-07-28' in r['error']['data']['supported'])
r = h({'jsonrpc': '2.0', 'id': 8, 'method': 'tools/call', 'params': dict(MODERN, name='nope', arguments={})})
check('an unknown tool is a protocol error', r['error']['code'] == -32602)
r = h({'jsonrpc': '2.0', 'id': 9, 'method': 'resources/list', 'params': MODERN})
check('an unsupported method is method-not-found', r['error']['code'] == -32601)

for value, want in (('', at.DEFAULT_URL), ('${user_config.crawler_url}', at.DEFAULT_URL),
                    ('localhost:5002', 'http://localhost:5002'), ('http://office-pc:5002/', 'http://office-pc:5002'),
                    ('not a url at all', at.DEFAULT_URL)):
    os.environ['OSC_URL'] = value
    check(f'OSC_URL {value!r} reads as {want}', at.base_url() == want)

# The bundle, the registry entry and the code all carry one version.
_manifest = json.load(open(os.path.join(REPO, 'mcpb', 'manifest.json'), encoding='utf-8'))
_server = json.load(open(os.path.join(REPO, 'server.json'), encoding='utf-8'))
check('manifest.json, server.json and agent_tools.VERSION agree',
      _manifest['version'] == _server['version'] == at.VERSION == mcp_server.SERVER_INFO['version'])
check('the registry entry points at this version\'s release asset',
      _server['packages'][0]['identifier'].endswith(f'/mcp-v{at.VERSION}/open-seo-crawler-mcp.mcpb')
      and len(_server['packages'][0]['fileSha256']) == 64)
check('the bundle lists every tool the server serves',
      sorted(t['name'] for t in _manifest['tools']) == sorted(mcp_server.TOOL_NAMES))
check('the registry description fits its 100-character limit', len(_server['description']) <= 100)

os.environ['OSC_URL'] = 'http://127.0.0.1:9'  # nothing listens on the discard port
r = h({'jsonrpc': '2.0', 'id': 10, 'method': 'tools/call',
       'params': dict(MODERN, name='list_crawls', arguments={})})['result']
check('a tool call with the app down is a tool error that says how to fix it',
      r['isError'] is True and 'not answering' in r['content'][0]['text'] and r['resultType'] == 'complete')

big = {'crawl': 'x', 'pages': [{'url': f'https://e.com/{i}', 'title': 'T' * 200} for i in range(2000)], 'note': 'n'}
text = mcp_server.fit(big, limit=20000)
parsed = json.loads(text)
check('fit sheds rows and stays valid JSON', len(text) <= 20000 and 0 < len(parsed['pages']) < 2000
      and 'truncated' in parsed)
check('fit leaves small results alone', mcp_server.fit({'a': [1]}) == '{"a": [1]}')

proc = subprocess.run([sys.executable, os.path.join(REPO, 'mcp_server.py')],
                      input='\n'.join([
                          json.dumps({'jsonrpc': '2.0', 'id': 'd', 'method': 'server/discover', 'params': MODERN}),
                          json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}),
                          'not json at all',
                          json.dumps({'jsonrpc': '2.0', 'id': 'l', 'method': 'tools/list', 'params': MODERN})]) + '\n',
                      capture_output=True, text=True, timeout=60)
replies = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
check('stdio: one reply per request, parse errors answered, notifications silent',
      [x.get('id') for x in replies] == ['d', None, 'l'] and replies[1]['error']['code'] == -32700)
check('stdio: stdout carries nothing but JSON-RPC', all(x.get('jsonrpc') == '2.0' for x in replies))

if FAILURES:
    for f in FAILURES:
        print('FAIL: ' + f)
    print(f'{PASS}/{PASS + len(FAILURES)} agent tool checks passed')
    sys.exit(1)
print(f'{PASS}/{PASS} agent tool checks passed')
