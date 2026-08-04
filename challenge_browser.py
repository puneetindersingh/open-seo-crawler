"""Headed-browser fallback for hosts behind a bot challenge (Cloudflare et al).

Background
----------
Some hosts answer every HTML request with HTTP 403 plus a "Just a moment..."
interstitial (Cloudflare "managed challenge"). Testing against a live example
established what does and does not get past it:

  * User-Agent swaps do NOT work. Googlebot, Googlebot-Mobile, bingbot, desktop
    Chrome, Firefox, Safari and an empty UA all returned 403. Cloudflare
    verifies real search-engine bots by IP/reverse-DNS, so claiming to be
    Googlebot from an unrelated IP is simply an unverified bot.
  * Extra headers do NOT work: full sec-ch-ua/sec-fetch header sets, HTTP/1.1
    instead of HTTP/2, Accept-Language variations -- all still 403.
  * Headless Chrome does NOT work, even with navigator.webdriver patched and
    --disable-blink-features=AutomationControlled. Still served the challenge.
  * A HEADED Chrome DOES work. That was the only variable that mattered.
  * Cookie hand-off does NOT work: the host issues no cf_clearance cookie, and
    replaying the browser's cookies into `requests` still returns 403. So a
    challenged host must be fetched through the browser for EVERY page.

Hence this module: a real (non-headless) Chrome on a private virtual display,
driven one page at a time with a deliberate delay between loads.

Two constraints shape the implementation:

1. No windows on anyone's desktop. The browser is headed, so it needs a
   display -- we start our own Xvfb and hand DISPLAY only to the browser
   process. Nothing appears on a logged-in user's screen, and this works from
   a systemd service that has no DISPLAY of its own.
2. Playwright's sync API is greenlet-bound to the thread that started it, so
   every Playwright call is confined to one owner thread and callers talk to
   it through a queue (same approach as the JS renderer).

The browser is started lazily on the first fetch, so a crawl that never hits a
challenge never pays the launch cost.
"""

import os
import queue as _queue
import re
import subprocess
import threading
import time
from concurrent.futures import Future

_CHALLENGE_TITLE = re.compile(r"just a moment|attention required|checking your browser|verifying you are human", re.I)

# Screaming-Frog-style identity presets for the crawl session. These do not
# defeat a challenge (see above) but do change what a server chooses to serve,
# which matters for cloaking checks and for hosts that block unknown agents.
USER_AGENTS = {
    'chrome': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
               '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'),
    'chrome-mobile': ('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36'),
    'googlebot': ('Mozilla/5.0 (compatible; Googlebot/2.1; '
                  '+http://www.google.com/bot.html)'),
    'googlebot-mobile': ('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) '
                         'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 '
                         'Mobile Safari/537.36 (compatible; Googlebot/2.1; '
                         '+http://www.google.com/bot.html)'),
    'bingbot': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'firefox': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'safari': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
               '(KHTML, like Gecko) Version/17.4 Safari/605.1.15'),
}
DEFAULT_UA_KEY = 'chrome'


def resolve_user_agent(value):
    """Map a preset key to its UA string; pass through a custom UA unchanged."""
    if not value:
        return None
    v = str(value).strip()
    return USER_AGENTS.get(v.lower(), v)


def is_challenge_response(status_code, headers, body):
    """True if a response is a solvable bot interstitial rather than a hard block.

    Deliberately narrow: a hard block ("Attention Required", an IP ban) is not
    solvable by re-fetching, so callers should keep treating those as WAF
    blocks and back off instead of spending a browser load on them.
    """
    try:
        hdrs = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    except Exception:
        hdrs = {}
    if hdrs.get('cf-mitigated', '').lower() == 'challenge':
        return True
    if status_code not in (403, 503):
        return False
    head = (body or '')[:8000]
    if 'challenge-platform' in head or '__cf_chl' in head:
        return True
    if 'cloudflare' in hdrs.get('server', '').lower() and _CHALLENGE_TITLE.search(head):
        return True
    return False


class ChallengeBrowser:
    """A headed browser on a private display, serialised and rate limited.

    ``fetch()`` is safe to call from any thread. Calls are queued and executed
    one at a time on the owner thread, with ``delay`` seconds enforced between
    consecutive page loads.
    """

    _SENTINEL = object()

    def __init__(self, user_agent=None, delay=3.0, launch_timeout=90, settle_timeout=30):
        self._ua = user_agent
        self._delay = max(0.0, float(delay))
        self._launch_timeout = launch_timeout
        self._settle_timeout = settle_timeout
        self._queue = _queue.Queue()
        self._ready = threading.Event()
        self._start_lock = threading.Lock()
        self._init_error = None
        self._started = False
        self._closed = False
        self._thread = None
        self.pages_fetched = 0

    # -- lifecycle ---------------------------------------------------------
    def _start(self):
        """Launch on first use. Returns True if the browser is usable."""
        with self._start_lock:
            if self._started:
                return self._init_error is None
            self._started = True
            self._thread = threading.Thread(target=self._run, daemon=True,
                                            name='challenge-browser')
            self._thread.start()
            if not self._ready.wait(timeout=self._launch_timeout):
                self._init_error = 'challenge browser launch timed out'
            return self._init_error is None

    def _start_xvfb(self):
        """Start a private X display. Returns (proc, display_str) or (None, None).

        If the process already has a DISPLAY we still prefer our own, so we
        never draw onto a real user's session.
        """
        for num in range(99, 140):
            sock = '/tmp/.X11-unix/X%d' % num
            if os.path.exists(sock):
                continue
            try:
                proc = subprocess.Popen(
                    ['Xvfb', ':%d' % num, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except FileNotFoundError:
                return None, None
            for _ in range(100):
                if os.path.exists(sock):
                    return proc, ':%d' % num
                if proc.poll() is not None:
                    break
                time.sleep(0.1)
            try:
                proc.terminate()
            except Exception:
                pass
        return None, None

    def _run(self):
        xvfb = browser = ctx = pw = None
        try:
            from playwright.sync_api import sync_playwright
            xvfb, display = self._start_xvfb()
            if not display:
                raise RuntimeError('Xvfb unavailable - install xvfb for challenge fallback')
            env = dict(os.environ)
            env['DISPLAY'] = display
            pw = sync_playwright().start()
            args = ['--no-sandbox', '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled']
            try:
                browser = pw.chromium.launch(headless=False, channel='chrome',
                                             args=args, env=env)
            except Exception:
                # No system Chrome - fall back to Playwright's bundled build.
                browser = pw.chromium.launch(headless=False, args=args, env=env)
            ctx_kwargs = {'viewport': {'width': 1440, 'height': 900},
                          'locale': 'en-AU', 'timezone_id': 'Australia/Sydney'}
            if self._ua:
                ctx_kwargs['user_agent'] = self._ua
            ctx = browser.new_context(**ctx_kwargs)
        except Exception as e:
            self._init_error = str(e)[:200]
            self._ready.set()
            self._teardown(ctx, browser, pw, xvfb)
            return
        self._ready.set()
        last_fetch = 0.0
        try:
            while True:
                item = self._queue.get()
                if item is self._SENTINEL:
                    break
                url, timeout, future = item
                if future.cancelled():
                    continue
                gap = self._delay - (time.monotonic() - last_fetch)
                if gap > 0:
                    time.sleep(gap)
                try:
                    future.set_result(self._load(ctx, url, timeout))
                except Exception as e:
                    future.set_result(('', None, 'challenge fetch: %s' % str(e)[:160]))
                last_fetch = time.monotonic()
        finally:
            self._teardown(ctx, browser, pw, xvfb)

    def _load(self, ctx, url, timeout):
        """Load one URL, waiting for the interstitial to clear. Owner thread only."""
        page = ctx.new_page()
        seen = {'status': None}

        def _on_response(resp):
            try:
                if resp.request.resource_type == 'document' and resp.request.is_navigation_request():
                    seen['status'] = resp.status
            except Exception:
                pass

        page.on('response', _on_response)
        try:
            resp = page.goto(url, wait_until='domcontentloaded', timeout=timeout)
            status = seen['status'] or (resp.status if resp else None)
            deadline = time.monotonic() + self._settle_timeout
            solved = False
            while time.monotonic() < deadline:
                try:
                    title = page.title()
                except Exception:
                    title = ''
                if not _CHALLENGE_TITLE.search(title or ''):
                    solved = True
                    break
                time.sleep(1)
            html = page.content()
            status = seen['status'] or status
            if not solved:
                return (html, status, 'challenge did not clear')
            self.pages_fetched += 1
            # Once the interstitial clears the served document is the real
            # page; the recorded status may still be the 403 of the first hop.
            if status is None or status == 403:
                status = 200
            return (html, status, None)
        finally:
            try:
                page.close()
            except Exception:
                pass

    def _teardown(self, ctx, browser, pw, xvfb):
        for obj, meth in ((ctx, 'close'), (browser, 'close'), (pw, 'stop')):
            if obj is not None:
                try:
                    getattr(obj, meth)()
                except Exception:
                    pass
        if xvfb is not None:
            try:
                xvfb.terminate()
                xvfb.wait(timeout=5)
            except Exception:
                try:
                    xvfb.kill()
                except Exception:
                    pass

    # -- public API --------------------------------------------------------
    def fetch(self, url, timeout=45000):
        """Return (html, status, error). Safe to call from any thread."""
        if self._closed:
            return ('', None, 'challenge browser closed')
        if not self._start():
            return ('', None, self._init_error or 'challenge browser unavailable')
        f = Future()
        self._queue.put((url, timeout, f))
        try:
            return f.result(timeout=(timeout / 1000.0) + self._settle_timeout + 30)
        except Exception as e:
            f.cancel()
            return ('', None, 'challenge fetch: %s' % str(e)[:160])

    @property
    def init_error(self):
        return self._init_error

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self._started and self._thread is not None:
            try:
                self._queue.put(self._SENTINEL)
            except Exception:
                pass
            self._thread.join(timeout=15)
