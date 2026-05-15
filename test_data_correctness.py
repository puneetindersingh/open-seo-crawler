#!/usr/bin/env python3
"""
DATA-CORRECTNESS test — drives the UI like a real user, then reads
the underlying state out of `window` and asserts every detector's
items satisfy its detection rule. The kind of test that would have
caught the Redirects-in-Sitemap false positive.
"""
import sys, time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

TEST_SITES = [
    "https://hamptonparkshoppingcentre.com.au",   # known trailing-slash redirect in sitemap
    "https://mojodojo.io",                         # multi-regional, many near-dups
]
MAX_PAGES = 50

failures = []
def ok(label):  print(f"    [PASS] {label}")
def fail(label, detail=""):
    print(f"    [FAIL] {label}{(' — ' + detail) if detail else ''}")
    failures.append(f"{label} {detail}")

def norm(u):
    if not u: return ''
    p = urlparse(u)
    path = (p.path or '/').rstrip('/') or '/'
    return f"{p.scheme}://{p.netloc.lower()}{path}{('?' + p.query) if p.query else ''}"


def check_correctness(site_label, results, sitemap_reports, nd_pairs, nd_stats):
    by_norm = {norm(r['url']): r for r in (results or [])}

    print(f"\n  CORRECTNESS for {site_label} (crawled {len(results or [])}):")

    # === Sitemap analysis ===
    rs = (sitemap_reports.get('redirects_in_sitemap') or []) if sitemap_reports else []
    bad = [r for r in rs if norm(r.get('url','')) == norm(r.get('redirects_to') or '')]
    label = f"redirects_in_sitemap ({len(rs)} items): every src.norm != dst.norm"
    (ok if not bad else lambda l: fail(l, f"{len(bad)} false-positives: {[r['url'] for r in bad[:3]]}"))(label)

    n2 = sitemap_reports.get('non_200_in_sitemap') or [] if sitemap_reports else []
    bad = [r for r in n2 if (r.get('status_code') or 0) == 200]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} 200s wrongly flagged"))(
        f"non_200_in_sitemap ({len(n2)} items): all have status_code != 200")

    ni = sitemap_reports.get('non_indexable_in_sitemap') or [] if sitemap_reports else []
    bad = [r for r in ni if (lambda row: row and row.get('indexable', True))(by_norm.get(norm(r.get('url',''))))]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} indexable rows wrongly flagged"))(
        f"non_indexable_in_sitemap ({len(ni)} items): all flagged rows are noindex")

    mfs = sitemap_reports.get('missing_from_sitemap') or [] if sitemap_reports else []
    bad = [u for u in mfs if norm(u) not in by_norm]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} URLs not in crawl"))(
        f"missing_from_sitemap ({len(mfs)} items): every URL exists in crawl results")

    # === Issue rules ===
    def with_issue(substr): return [r for r in (results or []) if any(substr in (i or '') for i in (r.get('issues') or []))]

    tl = with_issue('Title too long')
    bad = [r for r in tl if (r.get('title_len') or 0) <= 60]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} pages flagged with title_len <= 60"))(
        f"Title too long ({len(tl)} pages): all title_len > 60")

    ts = with_issue('Title too short')
    bad = [r for r in ts if not r.get('title') or (r.get('title_len') or 999) >= 30]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} mismatched"))(
        f"Title too short ({len(ts)} pages): all non-empty + title_len < 30")

    ml = with_issue('Meta desc too long')
    bad = [r for r in ml if (r.get('meta_len') or 0) <= 160]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} mismatched"))(
        f"Meta desc too long ({len(ml)} pages): all meta_len > 160")

    mh1 = [r for r in (results or []) if 'Missing H1' in (r.get('issues') or [])]
    bad = [r for r in mh1 if r.get('h1')]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} pages have h1 set"))(
        f"Missing H1 ({len(mh1)} pages): all have empty h1")

    th = [r for r in (results or []) if 'Thin content' in (r.get('issues') or [])]
    bad = [r for r in th if (r.get('word_count') or 0) >= 200]
    (ok if not bad else lambda l: fail(l, f"{len(bad)} pages with wc >= 200"))(
        f"Thin content ({len(th)} pages): all word_count < 200")

    # === Near-dup ===
    if nd_pairs:
        thr = (nd_stats or {}).get('threshold', 0.9)
        bad = [p for p in nd_pairs if (p.get('similarity') or 0) < thr]
        (ok if not bad else lambda l: fail(l))(
            f"near-dup ({len(nd_pairs)} pairs): all similarity >= {thr*100:.0f}%")
        bad = [p for p in nd_pairs if norm(p.get('url_a','')) not in by_norm or norm(p.get('url_b','')) not in by_norm]
        (ok if not bad else lambda l: fail(l, f"{len(bad)} reference URLs not in crawl"))(
            f"near-dup pairs: both endpoints in crawl results")


def run(site):
    print(f"\n>>> CRAWLING {site}")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1500, "height": 900})
        page = ctx.new_page()
        page.goto("http://localhost:5002/", wait_until="domcontentloaded")
        page.wait_for_selector("#crawler-url")
        page.fill("#crawler-url", site)
        page.evaluate(f"() => {{ const m = document.getElementById('crawler-max'); m.value = {MAX_PAGES}; m.dispatchEvent(new Event('input', {{bubbles:true}})); }}")
        page.click("#crawler-start-btn")
        finalized = False
        for _ in range(80):
            time.sleep(3)
            c = page.locator("#cs-crawled").inner_text()
            if page.locator("#crawler-limit-banner").is_visible() and not finalized:
                page.click("#crawler-limit-finalize-btn"); finalized = True; time.sleep(2); continue
            if page.locator("#crawler-start-btn").is_visible() and c.isdigit() and int(c) > 0:
                break
        time.sleep(5)  # let sitemap+nd analyses complete
        state = page.evaluate("""() => {
            // crawlerResults is module-scoped, not on window. Reach into it
            // through any function that has access. _ndPairs is on window.
            let results = [];
            try { results = (typeof crawlerResults !== 'undefined') ? crawlerResults : []; } catch {}
            // The table rendered rows expose URL — fall back to that if module var unreachable.
            if (!results.length) {
                const rows = document.querySelectorAll('#crawler-tbody tr[data-url]');
                results = Array.from(rows).map(r => ({
                    url: r.getAttribute('data-url'),
                    indexable: r.getAttribute('data-indexable') !== '0',
                }));
            }
            return {
                results,
                sitemap_reports: (typeof crawlerSitemap !== 'undefined' && crawlerSitemap && crawlerSitemap.reports) || null,
                nd_pairs: window._ndPairs || [],
                nd_stats: window._ndStats || {},
            };
        }""")
        b.close()
        check_correctness(site, state['results'], state['sitemap_reports'],
                          state['nd_pairs'], state['nd_stats'])


for s in TEST_SITES:
    try:
        run(s)
    except Exception as e:
        print(f"  ERR: {e}")
        failures.append(f"{s}: {e}")

print("\n" + "=" * 60)
if failures:
    print(f" {len(failures)} FAILURES:")
    for f in failures: print(f"  - {f}")
    sys.exit(1)
else:
    print(" ALL DATA-CORRECTNESS CHECKS PASSED")
