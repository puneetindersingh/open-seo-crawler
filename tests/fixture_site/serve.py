#!/usr/bin/env python3
"""Serve the fault fixture site, adding the faults that are HTTP behaviour
rather than markup: a 301 and a 404.

    python3 serve.py [port]

Binds 127.0.0.1 only. Used by tests/test_fixture_site.py, which starts and
stops it, but it runs standalone too if you want to click around it.
"""
import functools
import os
import sys
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, 'site')

# path -> (status, location). These are the faults a static file cannot carry.
REDIRECTS = {'/old-url/': (301, '/redirect-target/'),
             '/old-url': (301, '/redirect-target/'),
             # Lands on a page the nav links, so the crawl holds it already.
             '/moved/': (301, '/services/')}
GONE = {'/gone/', '/gone'}
# Two pages that redirect to each other: a loop with no page at the end.
REDIRECTS['/loop-a/'] = (302, '/loop-b/')
REDIRECTS['/loop-b/'] = (302, '/loop-a/')
LOOP_HITS = [0]   # GET requests to the loop, so the test can bound retries
# Bot checks served as a 2xx page instead of the real one: Imunify360's
# "One moment, please..." with a 200, SiteGround's sgcaptcha with a 202.
CHALLENGES = {
    '/challenge-200/': (200, '<!doctype html><html><head><title>One moment, please...</title></head>'
                             '<body><p>Please wait while your request is being verified...</p></body></html>'),
    '/challenge-202/': (202, '<html><head><meta http-equiv="refresh" '
                             'content="0;/.well-known/sgcaptcha/?r=%2Fchallenge-202%2F"></head></html>'),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SITE, **kw)

    def _send_html(self, html, status=200):
        data = html.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def _page_html(self, path):
        with open(os.path.join(SITE, path.strip('/'), 'index.html'), encoding='utf-8') as fh:
            return fh.read()

    def _bot_fault(self, path):
        """Answer some crawler user agents differently, one fault per page.
        Returns True when it sent the response."""
        ua = self.headers.get('User-Agent', '')
        p = path.rstrip('/') + '/'
        if p == '/bot-blocked/' and 'GPTBot' in ua:
            self.send_error(403, 'Forbidden')
            return True
        if p == '/bot-redirect/' and 'bingbot' in ua:
            self.send_response(302)
            self.send_header('Location', '/about/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return True
        if p == '/bot-cloaked/' and 'Googlebot' in ua:
            html = self._page_html(p).replace('<title>The same title for everyone</title>',
                                              '<title>A different title for search engines</title>')
            self._send_html(html)
            return True
        if (p == '/bot-thin/' and 'PerplexityBot' in ua) or (p == '/bot-mobile-thin/' and 'Mobile' in ua):
            html = self._page_html(p)
            start = html.index('<p>') + 3
            # Keep the opening of the copy only: a cut-down page.
            html = html[:start] + 'Plain sentences about widgets and how they are made. ' * 3 + html[html.index('</p>', start):]
            self._send_html(html)
            return True
        return False

    def _bare_param_fault(self):
        """/services/?view is linked; ?view= answers 301 back to it, as
        WordPress does. A crawler that rewrites the bare key reports it."""
        if not self.path.endswith('?view='):
            return False
        self.send_response(301)
        self.send_header('Location', self.path[:-1])
        self.send_header('Content-Length', '0')
        self.end_headers()
        return True

    def do_GET(self):
        path = self.path.split('?')[0]
        if self._bot_fault(path) or self._bare_param_fault():
            return
        if path.startswith('/loop-'):
            LOOP_HITS[0] += 1
        if path in CHALLENGES:
            status, html = CHALLENGES[path]
            self._send_html(html, status)
            return
        if path in REDIRECTS:
            status, location = REDIRECTS[path]
            self.send_response(status)
            self.send_header('Location', location)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if path in GONE:
            self.send_error(404, 'Not Found')
            return
        # /search/?q=x must serve the search page whatever the query string is.
        super().do_GET()

    def do_HEAD(self):
        path = self.path.split('?')[0]
        if self._bare_param_fault():
            return
        if path in REDIRECTS:
            status, location = REDIRECTS[path]
            self.send_response(status)
            self.send_header('Location', location)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if path in GONE:
            self.send_error(404, 'Not Found')
            return
        super().do_HEAD()

    def log_message(self, *a):
        pass  # keep the test output readable


def start(port=8099):
    """Start the server on a background thread. Returns (server, base_url)."""
    if not os.path.isdir(SITE):
        from build import build
        build(f'http://127.0.0.1:{port}')
    httpd = HTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f'http://127.0.0.1:{port}'


if __name__ == '__main__':
    p = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    srv, base = start(p)
    print(f'serving the fixture site at {base}  (ctrl-c to stop)')
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()
