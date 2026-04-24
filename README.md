# Open SEO Crawler — Free, Self-Hosted SEO Site Crawler

A fast, concurrent, CMS-aware **SEO site crawler** you can run locally. A free, open-source alternative to Screaming Frog, Sitebulb, and Ahrefs Site Audit — no accounts, no API keys, no cloud, no per-URL limits.

Built for SEO professionals, web developers, and site owners who want a technical SEO audit that stays on their machine.

## Why another crawler?

- **Screaming Frog is paid** past 500 URLs. **Sitebulb is paid**. **Ahrefs Site Audit is paid**.
- Free alternatives either can't be scripted, phone home with your data, or choke above 100 URLs.
- This tool runs locally, has no page limit, no signup, no telemetry, and takes about one minute to install.

## Features

- **Concurrent crawling** — 5 workers by default, 1-20 configurable. Per-host politeness keeps you under rate limits while running fast.
- **CMS detection + one-click recommendations** — auto-detects Shopify, WordPress (+ Yoast / Rank Math), Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, Joomla. Applies sensible exclude patterns and JS-render settings per platform.
- **Smart retry** — exponential backoff on 429 / 5xx / connection errors. Respects `Retry-After`. Per-host adaptive back-off doubles when a server starts rate-limiting, then decays back.
- **Severity-tagged SEO issues** — every issue classified as error / warning / info. Click any category to see an info panel with the "why it matters" explanation and cited sources (Ahrefs, Moz).
- **Full on-page SEO audit per URL** — title, meta description, H1, canonical, Open Graph, Twitter Card, schema markup, word count, images missing alt, redirects, mixed content, noindex, URL hygiene, Core Web Vitals signals.
- **Click any URL for details** — bottom dock with full page details, issue breakdown, inlinks (pages pointing to this URL), outlinks (pages this URL points to).
- **Robots.txt aware** (or ignore it, your choice).
- **Glob include / exclude URL patterns** for fine-grained control.
- **Optional JS rendering via Playwright** — install separately if you need to crawl SPA sites (React, Vue, Wix).

## What this crawler detects

Every page is checked for:

- **Title & meta description** — missing, too long (>60 / >160 chars), too short
- **H1** — missing, multiple, identical to title tag
- **Canonical URL** — missing, pointing elsewhere (canonicalised)
- **Schema.org structured data** — missing, types present
- **Open Graph & Twitter Card** — missing `og:title`, `og:image`, `twitter:card`
- **Content** — thin content flag (<200 words)
- **Performance** — slow response time (>3 s)
- **Redirects** — real redirects vs trailing-slash / www / HTTPS normalisations (classified separately)
- **HTTP errors** — 4xx / 5xx with retry counts
- **Indexability** — `noindex` in meta robots or X-Robots-Tag
- **Pagination** — `/page/N/` and `?page=N` archive URLs are crawled but skipped for SEO issue checks (no false positives for missing meta/title on paginated archive pages)
- **Mobile-friendliness** — viewport meta tag presence
- **Mixed content** — HTTPS pages loading HTTP resources
- **URL hygiene** — uppercase, underscores, spaces, >115 chars, tracking parameters
- **Images** — count of images missing `alt` attributes (decorative `alt=""` not penalised)
- **Security headers** — HTTPS, HSTS, CSP, X-Frame-Options, X-Content-Type-Options

## Quick install

Requires Python 3.10+.

```bash
git clone https://github.com/puneetindersingh/open-seo-crawler.git
cd open-seo-crawler
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

Open [http://localhost:5002/](http://localhost:5002/) in your browser.

### Optional: JS rendering (for SPAs)

Only needed for React / Vue / Wix / heavy Squarespace sites. Adds ~400 MB of browser dependencies.

```bash
pip install playwright
playwright install chromium
```

## Usage

1. Enter a website URL
2. (Optional) tweak defaults — 200 pages, 5 workers, 0.4 s per-host delay, depth 10
3. Click **Start crawl**

The tool detects the target's CMS on the first request and offers a one-click **Apply recommendations** button that populates sensible exclude patterns and worker counts.

Click any URL in the results table to open the bottom dock with:

- **Details** — full page metadata, schema types, security headers
- **Issues** — severity-tagged issues for this specific page
- **Inlinks** — all pages that link to this URL, with anchor text
- **Outlinks** — all internal links this page makes

Click any issue category in the left sidebar to filter results and see an info panel with the "why it matters" explanation and cited sources.

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| Max pages | 200 | Cap on total URLs crawled |
| Workers | 5 | Concurrent HTTP workers (1-20) |
| Per-host delay | 0.4 s | Min gap between two requests to the same host. A warning is shown if set below 0.4 s |
| Max depth | 10 | Clicks from seed URL |
| Render JS | off | Enable for SPAs (requires Playwright) |
| Ignore robots.txt | off | Default: respect Disallow rules |
| Include / exclude patterns | empty | Glob wildcards, e.g. `*?variant=*`, `*/cart/*` |

## Performance

Tested on a Shopify store:

- **10 pages in 3.3 seconds** (5 workers, 0.1 s delay)
- **~3× faster** than a single-threaded crawler with 1 s delay

Concurrency scales linearly up to about 8 workers before target server rate limits become the bottleneck.

## Privacy

Runs entirely on your machine. No API calls, no accounts, no telemetry. The only HTTP requests made are to the target site you're crawling.

## Licence

MIT. See [LICENSE](./LICENSE).

## Contributing

PRs welcome. The whole crawler is one readable Flask file (`app.py`) plus a minimal frontend — easy to extend.

## Keywords

free SEO crawler, open-source SEO spider, Screaming Frog alternative, self-hosted SEO audit tool, technical SEO crawler, website crawler for SEO, SEO site audit tool, free site crawler, CMS-aware crawler, Shopify SEO crawler, WordPress SEO audit, concurrent web crawler, open source SEO spider tool
