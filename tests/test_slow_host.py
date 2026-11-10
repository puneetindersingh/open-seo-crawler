#!/usr/bin/env python3
"""End to end: pacing on a slow host, Retry-After as a date, robots.txt with a BOM.

test_crawl_throttle.py checks the arithmetic. This checks the wiring: a real
site over real HTTP, through the real crawl route.

  * Slow host: every page takes about 2 seconds. With 5 workers and no pacing
    the crawler holds 5 requests open against it. With pacing it must report
    the slow-down and settle at about 2 in flight.
  * The same crawl with auto_throttle off must NOT pace (the switch works and
    the test above is measuring the throttle, not something else).
  * Retry-After sent as an HTTP date on a 429: the page must still be crawled.
  * robots.txt served with a byte order mark and no charset: its Disallow
    rule must still be obeyed.

    python3 tests/test_slow_host.py

No network: everything is on 127.0.0.1. Takes about a minute.
"""
import json
import os
import socket
import sys
import threading
import time
import urllib.request
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

PASS = 0
FAILURES = []


def check(name, cond, detail=''):
    global PASS
    if cond:
        PASS += 1
    else:
        FAILURES.append(f'{name} {detail}'.strip())


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


PAGES = 24
PAGE_SECONDS = 2.0


class State:
    lock = threading.Lock()
    in_flight = 0
    samples = []          # (monotonic time, requests in flight when this one started)
    hits = {}             # path -> times requested
    limited_once = False  # /limited answered 429 already

    @classmethod
    def reset(cls):
        with cls.lock:
            cls.in_flight = 0
            cls.samples = []
            cls.hits = {}
            cls.limited_once = False


def page(title, links):
    body = ''.join(f'<p><a href="{h}">Page {h}</a></p>' for h in links)
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>'
            f'<meta name="description" content="Fixture page {title} for the slow host test.">'
            f'</head><body><h1>{title}</h1>{body}</body></html>').encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='text/html; charset=utf-8', extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        self._send(200, b'')

    def do_GET(self):
        path = self.path.split('?')[0]
        with State.lock:
            State.hits[path] = State.hits.get(path, 0) + 1
        if path == '/robots.txt':
            # BOM first, and no charset on the Content-Type.
            body = b'\xef\xbb\xbfUser-agent: *\nDisallow: /private/\n'
            return self._send(200, body, ctype='text/plain')
        if path == '/sitemap.xml':
            return self._send(404, b'', ctype='text/plain')
        if path == '/limited':
            with State.lock:
                first = not State.limited_once
                State.limited_once = True
            if first:
                when = formatdate(time.time() + 3, usegmt=True)   # HTTP date, 3s ahead
                return self._send(429, b'slow down', extra={'Retry-After': when})
            return self._send(200, page('Limited', ['/']))
        if path == '/':
            links = [f'/p{i}' for i in range(PAGES)] + ['/private/secret', '/limited']
            return self._send(200, page('Home', links))
        if path.startswith('/private/'):
            return self._send(200, page('Private', ['/']))
        if path.startswith('/p'):
            with State.lock:
                State.in_flight += 1
                State.samples.append((time.monotonic(), State.in_flight))
            try:
                time.sleep(PAGE_SECONDS)       # slow before the headers go out
                return self._send(200, page(f'Slow {path}', ['/']))
            finally:
                with State.lock:
                    State.in_flight -= 1
        return self._send(404, b'not found', ctype='text/plain')


SITE_PORT = free_port()
BASE = f'http://127.0.0.1:{SITE_PORT}'
httpd = ThreadingHTTPServer(('127.0.0.1', SITE_PORT), Handler)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()

# Set OSC_TEST_CRAWLER=http://127.0.0.1:5002 to test a crawler that is already
# running instead of starting one in process.
CRAWLER = os.environ.get('OSC_TEST_CRAWLER', '').rstrip('/')
if not CRAWLER:
    import app as crawler              # noqa: E402

    CRAWL_PORT = free_port()
    CRAWLER = f'http://127.0.0.1:{CRAWL_PORT}'
    threading.Thread(
        target=lambda: crawler.app.run(host='127.0.0.1', port=CRAWL_PORT,
                                       debug=False, threaded=True),
        daemon=True).start()
for _ in range(60):
    try:
        urllib.request.urlopen(CRAWLER + '/', timeout=1).read()
        break
    except Exception:
        time.sleep(0.25)


def crawl(**extra):
    State.reset()
    payload = {'url': BASE + '/', 'max_pages': 60, 'crawl_delay': 0.05,
               'max_workers': 5, 'render_js': False}
    payload.update(extra)
    req = urllib.request.Request(
        CRAWLER + '/crawl', data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'})
    rows, notes = [], []
    with urllib.request.urlopen(req, timeout=600) as resp:
        for raw in resp:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data: '):
                continue
            msg = json.loads(line[6:])
            kind = msg.get('type')
            if kind == 'page':
                rows.append(msg.get('data') or msg)
            elif kind == 'speed_adjusted':
                notes.append(msg.get('reason') or '')
            elif kind == 'complete':
                break
    with State.lock:
        samples = list(State.samples)
        hits = dict(State.hits)
    return rows, notes, samples, hits


def tail_peak(samples):
    """Highest number in flight over the last third of the slow requests."""
    tail = samples[len(samples) * 2 // 3:]
    return max((n for _t, n in tail), default=0)


# ── 1. pacing on ──────────────────────────────────────────────────────────────
rows, notes, samples, hits = crawl()
urls = {r.get('url', '') for r in rows}
slow_notes = [n for n in notes if 'answering slowly' in n]
check('slow host: every slow page was crawled',
      sum(1 for u in urls if '/p' in u.replace(BASE, '')[:2]) == PAGES,
      f'(got {sorted(u.replace(BASE, "") for u in urls)})')
check('slow host: the slow-down is reported to the UI', len(slow_notes) == 1, f'(notes: {notes})')
check('slow host: early requests ran at full width', max((n for _t, n in samples[:5]), default=0) >= 4,
      f'(first samples: {[n for _t, n in samples[:5]]})')
check('slow host: settles at about two in flight', 1 <= tail_peak(samples) <= 3,
      f'(in flight over the last third: {[n for _t, n in samples[len(samples) * 2 // 3:]]})')
check('robots BOM: disallowed path was not requested', '/private/secret' not in hits, f'(hits: {hits.get("/private/secret")})')
check('robots BOM: disallowed path is not in the results', not any('/private/' in u for u in urls))
check('Retry-After date: the 429 page was retried', hits.get('/limited', 0) >= 2, f'(hits: {hits.get("/limited")})')
limited = [r for r in rows if r.get('url', '').endswith('/limited')]
check('Retry-After date: the page ends up crawled with a 200',
      len(limited) == 1 and limited[0].get('status_code') == 200,
      f'(rows: {[(r.get("url"), r.get("status_code")) for r in limited]})')

# ── 2. pacing off ─────────────────────────────────────────────────────────────
rows2, notes2, samples2, hits2 = crawl(auto_throttle=False)
check('switch off: nothing is reported', not [n for n in notes2 if 'answering slowly' in n], f'(notes: {notes2})')
check('switch off: stays at full width', tail_peak(samples2) >= 4,
      f'(in flight over the last third: {[n for _t, n in samples2[len(samples2) * 2 // 3:]]})')
check('switch off: every slow page was still crawled',
      sum(1 for r in rows2 if r.get('url', '').replace(BASE, '').startswith('/p')) >= PAGES)

httpd.shutdown()
if FAILURES:
    for f in FAILURES:
        print('FAIL', f)
    print(f'{PASS} passed, {len(FAILURES)} failed')
    sys.exit(1)
print(f'{PASS}/{PASS} slow host checks passed')
