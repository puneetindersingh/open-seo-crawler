"""Crawl pacing helpers: pure, no network, tested by test_crawl_throttle.py.

Two things the crawl loop needs that have nothing to do with fetching:

  * parse_retry_after: read a Retry-After header in either of its legal
    forms, a number of seconds or an HTTP date.
  * LatencyThrottle: widen the gap between requests to a host that is
    answering slowly, before it starts returning errors.

The crawl loop already slows down AFTER a host blocks or rate limits it (the
per-host back-off multiplier and pause windows in app.py). That reacts to
failures only. A small shared host can take four or five seconds per page
without ever sending a 429 or a 503, and five workers will happily keep five
requests open against it the whole time. LatencyThrottle covers that case:
it watches response times and, while a host is slow, spaces requests so that
about two are in flight instead of one per worker. It never speeds a crawl up
past the delay the user chose, and it lets go again once the host recovers.

The approach follows the AutoThrottle idea used by Scrapy and Scrapling
(delay derived from observed latency), cut down to fit a crawl loop that
already has its own block handling.
"""
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


def parse_retry_after(value, now=None):
    """Seconds a Retry-After header asks for, or None when absent or unreadable.

    Accepts both legal forms: delta seconds ("120") and an HTTP date
    ("Wed, 21 Oct 2026 07:28:00 GMT"). A date in the past gives 0.0.
    `now` is a UTC datetime, injectable for tests.
    """
    text = (value or '').strip()
    if not text:
        return None
    try:
        return max(float(text), 0.0)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return max((when - now).total_seconds(), 0.0)


class LatencyThrottle:
    """Per-host request gap derived from how slowly the host is answering.

    record(host, seconds) feeds one healthy response time in.
    gap(host) is the minimum gap, in seconds, the crawl loop should leave
    between two request starts to that host. 0.0 means "no opinion": the
    user's own delay applies untouched.

    A host is treated as slow once its smoothed response time has stayed at
    or above SLOW_SECONDS for SLOW_STREAK responses in a row (so one heavy
    page does not trip it) and as recovered once it drops under
    RECOVER_SECONDS. The gap
    while slow is smoothed_time / TARGET_IN_FLIGHT, capped at MAX_GAP.
    """

    SLOW_SECONDS = 1.5       # smoothed response time that marks a host as slow
    RECOVER_SECONDS = 1.0    # ... and the level it must fall back under
    SLOW_STREAK = 3          # responses in a row over the mark before pacing starts
    TARGET_IN_FLIGHT = 2.0   # requests to aim for in flight on a slow host
    MAX_GAP = 10.0           # never space requests further apart than this
    SMOOTHING = 0.3          # weight of the newest response in the average

    def __init__(self, enabled=True):
        self.enabled = bool(enabled)
        self._lock = threading.Lock()
        self._avg = {}       # host -> smoothed response time
        self._streak = {}    # host -> responses in a row with the average over the mark
        self._slow = set()   # hosts currently being paced
        self._notices = []   # (host, text) waiting for the crawl loop to report

    def record(self, host, seconds):
        """Feed one healthy response time (seconds) for a host."""
        if not self.enabled:
            return
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            return
        if seconds <= 0:
            return
        with self._lock:
            prev = self._avg.get(host)
            avg = seconds if prev is None else prev + self.SMOOTHING * (seconds - prev)
            self._avg[host] = avg
            streak = self._streak.get(host, 0) + 1 if avg >= self.SLOW_SECONDS else 0
            self._streak[host] = streak
            if host not in self._slow:
                if streak >= self.SLOW_STREAK:
                    self._slow.add(host)
                    self._notices.append((host, (
                        f'{host} is answering slowly (about {avg:.1f}s a page): '
                        f'spacing requests about {self._gap_locked(host):.1f}s apart'
                    )))
            elif avg < self.RECOVER_SECONDS:
                self._slow.discard(host)
                self._notices.append((host, f'{host} is answering quickly again: back to normal speed'))

    def _gap_locked(self, host):
        if host not in self._slow:
            return 0.0
        return min(self._avg.get(host, 0.0) / self.TARGET_IN_FLIGHT, self.MAX_GAP)

    def gap(self, host):
        """Minimum seconds between request starts for this host; 0.0 if none."""
        if not self.enabled:
            return 0.0
        with self._lock:
            return self._gap_locked(host)

    def average(self, host):
        """Smoothed response time for a host, or None before any response."""
        with self._lock:
            return self._avg.get(host)

    def pop_notices(self):
        """Messages about hosts that turned slow or recovered since last call."""
        with self._lock:
            out, self._notices = self._notices, []
        return [text for _host, text in out]


if __name__ == '__main__':
    # Tiny demonstration: python3 crawl_throttle.py
    t = LatencyThrottle()
    for s in (0.3, 2.5, 3.0, 4.0, 4.0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2):
        t.record('example.com', s)
        print(f'{s:>4}s  avg={t.average("example.com"):.2f}  gap={t.gap("example.com"):.2f}', t.pop_notices())
    print(parse_retry_after('120'), parse_retry_after('Wed, 21 Oct 2026 07:28:00 GMT'), time.strftime('%Y'))
