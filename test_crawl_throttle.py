#!/usr/bin/env python3
"""crawl_throttle tests: no network, no server.

    python3 test_crawl_throttle.py
"""
import os
import sys
import threading
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crawl_throttle import LatencyThrottle, parse_retry_after

PASS = 0


def check(name, got, want):
    global PASS
    if got != want:
        print(f'FAIL {name}: got {got!r}, want {want!r}')
        sys.exit(1)
    PASS += 1


def near(name, got, want, tol=0.01):
    global PASS
    if got is None or abs(got - want) > tol:
        print(f'FAIL {name}: got {got!r}, want about {want!r}')
        sys.exit(1)
    PASS += 1


# --- parse_retry_after -------------------------------------------------------
NOW = datetime(2026, 10, 21, 7, 28, 0, tzinfo=timezone.utc)
check('seconds', parse_retry_after('120'), 120.0)
check('seconds with spaces', parse_retry_after('  30 '), 30.0)
check('fractional seconds', parse_retry_after('1.5'), 1.5)
check('negative clamps to zero', parse_retry_after('-5'), 0.0)
check('empty', parse_retry_after(''), None)
check('None', parse_retry_after(None), None)
check('garbage', parse_retry_after('soon'), None)
check('http date ahead', parse_retry_after('Wed, 21 Oct 2026 07:30:00 GMT', now=NOW), 120.0)
check('http date in the past', parse_retry_after('Wed, 21 Oct 2026 07:00:00 GMT', now=NOW), 0.0)
check('http date without zone reads as UTC', parse_retry_after('Wed, 21 Oct 2026 07:29:00', now=NOW), 60.0)

# --- LatencyThrottle ---------------------------------------------------------
t = LatencyThrottle()
check('no data, no gap', t.gap('a.com'), 0.0)
check('no data, no average', t.average('a.com'), None)

# A fast host is never paced.
for _ in range(50):
    t.record('fast.com', 0.25)
check('fast host has no gap', t.gap('fast.com'), 0.0)
check('fast host raises no notice', t.pop_notices(), [])

# One heavy page on an otherwise fast host does not trip it.
t = LatencyThrottle()
for s in (0.2, 0.2, 0.2, 6.0, 0.2, 0.2):
    t.record('spiky.com', s)
    check(f'single spike does not pace ({s})', t.gap('spiky.com'), 0.0)

# The first responses alone cannot trip it (SLOW_STREAK).
t = LatencyThrottle()
t.record('slow.com', 5.0)
t.record('slow.com', 5.0)
check('two samples are not enough', t.gap('slow.com'), 0.0)
t.record('slow.com', 5.0)
near('third slow sample paces: avg / 2', t.gap('slow.com'), 2.5)
notes = t.pop_notices()
check('one notice when a host turns slow', len(notes), 1)
check('notice names the host', 'slow.com' in notes[0] and 'slowly' in notes[0], True)
check('notices are handed out once', t.pop_notices(), [])

# Staying slow raises no more notices; the gap follows the average.
for _ in range(10):
    t.record('slow.com', 5.0)
check('no repeat notice while still slow', t.pop_notices(), [])
near('gap tracks the average', t.gap('slow.com'), 2.5)

# The gap is capped.
t = LatencyThrottle()
for _ in range(20):
    t.record('dying.com', 60.0)
check('gap is capped at MAX_GAP', t.gap('dying.com'), LatencyThrottle.MAX_GAP)

# Recovery: needs the average under RECOVER_SECONDS, not just under SLOW_SECONDS.
t = LatencyThrottle()
for _ in range(5):
    t.record('h.com', 3.0)
t.pop_notices()
t.record('h.com', 0.2)
check('one quick page does not release it', t.gap('h.com') > 0, True)
for _ in range(12):
    t.record('h.com', 0.2)
check('sustained quick pages release it', t.gap('h.com'), 0.0)
notes = t.pop_notices()
check('one notice on recovery', len(notes), 1)
check('recovery notice wording', 'quickly again' in notes[0], True)

# Between the two thresholds nothing flaps.
t = LatencyThrottle()
for _ in range(30):
    t.record('mid.com', 1.2)
check('1.2s host is never paced', t.gap('mid.com'), 0.0)
check('1.2s host raises nothing', t.pop_notices(), [])

# Hosts are independent.
t = LatencyThrottle()
for _ in range(5):
    t.record('slow.com', 4.0)
    t.record('fast.com', 0.1)
check('slow host paced', t.gap('slow.com') > 0, True)
check('other host untouched', t.gap('fast.com'), 0.0)

# Bad input is ignored.
t = LatencyThrottle()
for bad in (0, -1, None, 'x', ''):
    t.record('b.com', bad)
check('zero, negative and junk times are ignored', t.average('b.com'), None)

# Switched off: records nothing, never paces.
t = LatencyThrottle(enabled=False)
for _ in range(10):
    t.record('slow.com', 9.0)
check('disabled never paces', t.gap('slow.com'), 0.0)
check('disabled raises nothing', t.pop_notices(), [])

# Thread safety smoke: many workers recording at once.
t = LatencyThrottle()


def _hammer():
    for _ in range(2000):
        t.record('busy.com', 2.0)
        t.gap('busy.com')
        t.pop_notices()


threads = [threading.Thread(target=_hammer) for _ in range(8)]
for th in threads:
    th.start()
for th in threads:
    th.join()
near('concurrent records settle on the right average', t.average('busy.com'), 2.0)
near('concurrent records settle on the right gap', t.gap('busy.com'), 1.0)

print(f'{PASS}/{PASS} crawl_throttle checks passed')
