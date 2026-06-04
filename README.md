# Open SEO Crawler — Free, Self-Hosted Screaming Frog Alternative

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Platform: Linux · macOS · Windows](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)](#one-line-install--auto-start--auto-update-linux--macos--windows)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)

**A free, open-source SEO site crawler you can run locally.** Fast, concurrent, CMS-aware. A drop-in alternative to Screaming Frog, Sitebulb, and Ahrefs Site Audit, with no accounts, no API keys, no cloud, and no per-URL limits.

Built for SEO professionals, web developers, and site owners who want a real technical SEO audit that stays on their machine.

→ One-line install on Linux, macOS, or Windows. Auto-starts on boot, auto-updates daily. Browser opens at `http://localhost:5002/` when done.

## How it compares

| | Open SEO Crawler | Screaming Frog (free) | Screaming Frog (paid) | Sitebulb | Ahrefs Site Audit |
|---|---|---|---|---|---|
| URL limit | **Unlimited** | 500 | Unlimited | Unlimited | Per-credit |
| Price | **Free, MIT** | Free | £199 / yr | $13.50+ / mo | $129+ / mo |
| Self-hosted | ✅ | ✅ | ✅ | ✅ | ❌ cloud |
| Phones home | ❌ | ❌ | ❌ | ❌ | ✅ |
| Auto-update | ✅ daily + on-boot | ❌ manual | ❌ manual | ❌ manual | n/a |
| Open source | ✅ | ❌ | ❌ | ❌ | ❌ |
| CMS-aware presets | ✅ 10 CMSs | ❌ | partial | partial | partial |
| Headless JS render | ✅ optional | ✅ paid | ✅ | ✅ | ✅ |

## What's new (recent additions)

- **robots.txt AI-crawler block detection** — flags, as a red error, when robots.txt blocks AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider + 20 more) — meaning the site can't be read or cited by ChatGPT, AI, Perplexity or Google AI Overviews — or when classic search engines (Googlebot/Bingbot) are blocked. Also detects Cloudflare `Content-Signal: ai-train=no` opt-outs. Surfaces on the homepage row in the issues sidebar under **AI Crawlers Blocked** / **Search Engines Blocked**.
- **Post-crawl Summary dashboard** — auto-opens after a crawl finishes with a one-glance view of issues by severity, total pages, response code mix, and the worst offenders.
- **Bulk SEO reports** — All Titles, All Metas, All H1s, All Canonicals, plus dedicated Duplicate Title / Duplicate Meta / Duplicate H1 / Duplicate Body / Multiple H1s / Redirect Chains / Response Codes / Deep Pages / Hreflang reports.
- **Severity-grouped issues view** — pages are bucketed by the worst issue on them (Errors / Warnings / Info) and grouped by issue type so you fix the highest-impact problems first.
- **One-click auto-update** — version badge in the topbar checks GitHub for newer commits and offers a one-click `git pull + restart + page reload` so you're always on the latest code.
- **Dark mode toggle** — explicit per-user choice (persists in localStorage), overrides system `prefers-color-scheme` cleanly.
- **Saved crawls list** — every crawl is auto-saved; reopen any historical crawl from the Load Saved modal. Names of who ran each crawl resolve across multiple tools on the same LAN.
- **Smart noindex / canonicalised handling** — these pages no longer inflate the Error count or get flagged as duplicates by Bulk Reports.

## Features

### Crawling

- **Concurrent crawling** — 5 workers by default, 1-20 configurable. Per-host politeness keeps you under target rate limits while still moving fast.
- **CMS detection + one-click recommendations** — auto-detects Shopify, WordPress (+ Yoast / Rank Math), Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, Joomla. Applies sensible exclude patterns and JS-render settings per platform.
- **Smart retry** — exponential backoff on 429 / 5xx / connection errors. Respects `Retry-After`. Per-host adaptive back-off doubles when a server starts rate-limiting, decays back when it recovers.
- **Sitemap analysis** — fetches sitemap.xml, cross-checks against the crawl: flags missing from sitemap, orphans, sitemap-only URLs, non-200 in sitemap, redirects in sitemap.
- **Near-duplicate content** — shingle-based Jaccard similarity flags pairs of pages that are 90%+ similar (tweakable 80 / 85 / 90 or custom).
- **Robots.txt aware** (or ignore it, your choice).
- **Glob include / exclude patterns** — `*?variant=*`, `*/cart/*`, etc.
- **Optional JS rendering via Playwright** — install separately for SPA sites (React, Vue, Wix).

### What gets checked per page

- **Titles** — missing, too long (>60 chars), too short, duplicate across pages, identical to H1
- **Meta descriptions** — missing, too long (>160 chars), too short, duplicate across pages
- **H1 tags** — missing, multiple H1s, identical to title, duplicate across pages
- **Canonical tags** — missing, points elsewhere (canonicalised), self-referencing
- **Schema.org structured data** — presence + types detected
- **Open Graph + Twitter Card** — missing `og:title`, `og:image`, `twitter:card`
- **Content** — thin content (<200 words), near-duplicate bodies (Jaccard similarity)
- **Performance** — slow response time (>3 s)
- **Redirects** — real redirects vs trailing-slash / www / HTTPS normalisations (classified separately so trailing-slash 301s don't pollute your Redirect Chain report)
- **Redirect chains** — multi-hop redirects flagged with full hop list
- **HTTP errors** — 4xx / 5xx with retry counts
- **Indexability** — `noindex` in meta robots or X-Robots-Tag
- **Hreflang** — extracted, validated, missing return-tags flagged
- **Pagination** — `/page/N/` and `?page=N` archive URLs crawled but skipped for SEO issue checks (no false positives for missing meta on paginated archives)
- **Mobile-friendliness** — viewport meta tag presence
- **Mixed content** — HTTPS pages loading HTTP resources
- **URL hygiene** — uppercase, underscores, spaces, >115 chars, tracking parameters
- **Images** — count of images missing `alt` attributes (decorative `alt=""` not penalised)
- **Security headers** — HTTPS, HSTS, CSP, X-Frame-Options, X-Content-Type-Options
- **Deep pages** — URLs more than N clicks from the homepage (configurable)

### Bulk reports (sidebar)

Every report exports to XLSX so you can hand it to a content team or dev:

- **All Titles** / **All Metas** / **All H1s** / **All Canonicals** — one row per page
- **Duplicate Titles** / **Duplicate Metas** / **Duplicate H1s** / **Duplicate Bodies** — grouped by duplicate value, normalised URLs (no trailing-slash false positives)
- **Multiple H1s** — pages with 2+ H1 tags, dynamic H1(1) / H1(2) / H1(N) columns
- **Redirect Chains** — pages reached via 2+ hops, with the full chain
- **Response Codes** — breakdown by status code
- **Deep Pages** — URLs N+ clicks from homepage
- **Hreflang** — extracted, validated, cross-page consistency checked
- **Severity views** — All Errors / All Warnings / All Info, with irrelevant columns hidden per view

### Auto-update + version badge

- Topbar version badge shows the current build, polls GitHub for newer commits, and flips to **"Update available"** when there's a newer master commit.
- One click runs `git pull + restart service + reload page` end-to-end. No SSH, no manual commands.
- Background daily auto-update (Linux systemd timer / macOS LaunchAgent / Windows Task Scheduler) keeps everyone on the latest without you thinking about it. Rolls back automatically if a pull breaks the app.

### UI

- **Post-crawl Summary** dashboard auto-opens with severity counts, top issues, and crawl stats.
- **Severity sidebar** — All Pages / Errors / Warnings / Info, each with live counts.
- **Issue grouping** — click any severity and see issues grouped by type with the worst-affected pages listed under each.
- **Page detail dock** — click any URL for full page metadata, all issues for that page, inlinks (with anchor text), outlinks.
- **Dark mode** — toggle in the topbar, persists per user.
- **Saved crawls** — every crawl auto-saved, reopenable from the Load Saved modal.
- **Sitemap + XLSX export buttons** in the topbar — one click each.

## Quick install (manual)

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

## One-line install — auto-start + auto-update (Linux / macOS / Windows)

Each installer registers the crawler as a background service that starts on boot/login, plus a daily auto-updater that pulls the latest from this repo (with rollback on failure). Installs to `~/open-seo-crawler` (or `%USERPROFILE%\open-seo-crawler` on Windows). Browser auto-opens to `http://localhost:5002/` when done.

| Platform | Install command |
|---|---|
| **Linux Mint / Ubuntu / Debian** | See [Linux section](#one-line-install-on-linux-mint--ubuntu--debian) |
| **macOS** (Intel + Apple Silicon) | See [macOS section](#one-line-install-on-macos) |
| **Windows 10 / 11** | See [Windows section](#one-line-install-on-windows-10--11) |

### One-line install on Linux Mint / Ubuntu / Debian

Open a terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install.sh -o install.sh && chmod +x install.sh && ./install.sh
```

That's it. When it finishes your browser opens to `http://localhost:5002/`.

Optional dry-run preflight (checks Python, port, disk, internet; makes no changes):

```bash
curl -fsSL https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install.sh -o install.sh && chmod +x install.sh && ./install.sh --check
```

What the installer does:

- Verifies prerequisites (Python 3.10+, systemd, sudo, disk space, free port 5002, internet)
- Installs `python3 / python3-venv / git / curl` via `apt` if missing
- **Old Ubuntu/Mint support**: if the system ships Python < 3.10 (e.g. Mint 20.x = Python 3.8), the installer adds the deadsnakes PPA and tries `python3.13` → `3.12` → `3.11` → `3.10` until one installs. If none are available, falls back to **compiling Python 3.10.14 from source** automatically (~5-15 min).
- Clones the repo, creates a virtualenv, installs Python deps
- Registers `open-seo-crawler.service` so the crawler starts on every boot
- Registers `open-seo-crawler-update.timer` to `git pull` + restart 2 min after every boot and once daily (auto-rolls-back on any failure)
- Prints the access URLs (`http://localhost:5002/` plus your LAN IP) and auto-opens the browser if you're on a desktop
- Saves the URLs to `~/open-seo-crawler/ACCESS_URLS.txt` for later

Useful commands after install:

```bash
systemctl status open-seo-crawler                  # is it running?
sudo systemctl restart open-seo-crawler            # restart
sudo systemctl disable open-seo-crawler            # stop autostarting on boot
./install.sh --update-now                          # force a git-pull + restart now
systemctl list-timers | grep open-seo-crawler      # when's the next auto-update?
journalctl -u open-seo-crawler-update.service -n 50  # update history
sudo systemctl disable --now open-seo-crawler-update.timer  # turn auto-update off
tail -f /var/log/open-seo-crawler.log              # live app logs
```

### One-line install on macOS

Works on Intel + Apple Silicon, macOS 11 Big Sur and newer. Uses Homebrew + `launchd`.

Open Terminal (⌘+Space → "Terminal") and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-macos.sh -o install-macos.sh && chmod +x install-macos.sh && ./install-macos.sh
```

Dry-run preflight:

```bash
curl -fsSL https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-macos.sh -o install-macos.sh && chmod +x install-macos.sh && ./install-macos.sh --check
```

What the installer does:

- Verifies prerequisites (macOS, Python 3.10+, disk space, free port 5002, internet)
- Installs Homebrew if missing (will prompt for your password)
- Installs `python@3.12` + `git` via Homebrew if missing
- Clones the repo, creates a virtualenv, installs Python deps
- Registers `io.openseocrawler.app` LaunchAgent (starts on login, restarts on crash)
- Registers `io.openseocrawler.update` LaunchAgent (runs 2 min after login + daily at 03:30 with auto-rollback)
- Opens `http://localhost:5002/` in your default browser

Useful commands after install:

```bash
launchctl list | grep openseocrawler                                                # is it running?
launchctl kickstart -k gui/$(id -u)/io.openseocrawler.app                           # restart
launchctl bootout gui/$(id -u)/io.openseocrawler.app                                # stop
rm ~/Library/LaunchAgents/io.openseocrawler.app.plist                               # disable autostart
./install-macos.sh --update-now                                                     # force update now
tail -f ~/Library/Logs/OpenSEOCrawler/app.log                                       # live app logs
tail -f ~/Library/Logs/OpenSEOCrawler/update.log                                    # update history
```

### One-line install on Windows 10 / 11

Uses `winget` + Task Scheduler. No admin rights needed.

Open PowerShell (Start menu → type "powershell" → Enter) and paste:

```powershell
iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-windows.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Dry-run preflight:

```powershell
iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-windows.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1 -Check
```

What the installer does:

- Verifies prerequisites (Windows, Python 3.10+, disk space, free port 5002, internet)
- Installs Python 3.12 + Git via `winget` if missing
- Clones the repo to `%USERPROFILE%\open-seo-crawler`, creates a virtualenv, installs Python deps
- Registers a `OpenSeoCrawler` Task Scheduler task (starts at logon, runs in the background via `pythonw.exe`, no console window)
- Registers a `OpenSeoCrawler-Update` Task Scheduler task (runs 2 min after boot + daily at 03:30 with auto-rollback)
- Opens `http://localhost:5002/` in your default browser

Useful commands after install (PowerShell):

```powershell
Get-ScheduledTask -TaskName OpenSeoCrawler                                          # is it registered?
Stop-ScheduledTask -TaskName OpenSeoCrawler; Start-ScheduledTask -TaskName OpenSeoCrawler  # restart
Stop-ScheduledTask -TaskName OpenSeoCrawler                                         # stop
Unregister-ScheduledTask -TaskName OpenSeoCrawler -Confirm:$false                   # remove
.\install-windows.ps1 -UpdateNow                                                    # force update
Get-Content "$env:USERPROFILE\open-seo-crawler\update.log" -Tail 50 -Wait           # tail update log
```

> If PowerShell's execution policy blocks the script, the `-ExecutionPolicy Bypass` prefix shown above handles it. No admin rights are needed; `winget --scope user` and user-level scheduled tasks both work without UAC.

### Optional: JS rendering (for SPAs)

Only needed for React / Vue / Wix / heavy Squarespace sites. Adds ~400 MB of browser dependencies.

```bash
pip install playwright
playwright install chromium
```

## Usage

1. Enter a website URL
2. (Optional) tweak defaults — 1500 pages, 5 workers, 0.4 s per-host delay, depth 10. **Sitemap analysis** and **Near-duplicate content (≥90% similarity)** are pre-checked so a fresh crawl runs both post-analyses automatically.
3. Click **Start crawl**

The tool detects the target's CMS on the first request and offers a one-click **Apply recommendations** button that populates sensible exclude patterns and worker counts.

The **Summary** tab auto-opens during the crawl and live-refreshes as pages come in. When the crawl finishes you have:

- A severity breakdown (Errors / Warnings / Info) with live counts
- Bulk reports for every common SEO audit (All Titles, Duplicate Titles, Redirect Chains, etc.)
- A page-detail dock for any URL (click a row): metadata, issues, inlinks, outlinks
- Sitemap + XLSX export buttons in the topbar

## Use cases

- **Pre-launch audit**: crawl a staging site, fix every Error before the redirect cutover.
- **Post-launch verification**: re-crawl after a migration and compare Redirect Chains, Response Codes, and Hreflang reports against the pre-migration crawl.
- **Periodic technical SEO health-checks**: weekly crawl of your main domain to catch regressions in canonicals, duplicate titles, broken internal links.
- **Competitor research**: crawl a competitor's site (responsibly, respecting their robots.txt) to understand their internal linking, content depth, and structured data coverage.
- **Bulk meta audits**: export All Titles or All Metas, hand the XLSX to a content team for rewrites.
- **Hreflang debugging**: international sites with regional subfolders or subdomains can validate every hreflang annotation in one click.
- **Sitemap hygiene**: catch sitemap-only URLs (in sitemap, not actually linked from the site), orphans (linked but not in sitemap), and stale URLs that return 404 / 301.

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| Max pages | 1500 | Cap on total URLs crawled (1-5000 + Unlimited) |
| Workers | 5 | Concurrent HTTP workers (1-20) |
| Per-host delay | 0.4 s | Min gap between two requests to the same host. A warning is shown if set below 0.4 s |
| Max depth | 10 | Clicks from seed URL |
| Render JS | off | Enable for SPAs (requires Playwright) |
| Ignore robots.txt | off | Default: respect Disallow rules |
| Ignore noindex | off | Default: noindex pages excluded from duplicate / orphan reports |
| Sitemap analysis | **on** | Post-crawl: flags missing from sitemap, orphans, sitemap-only, non-200, redirects in sitemap |
| Near-duplicate content | **on** at 90% | Shingle Jaccard on body content; flag pairs ≥ 90% similar (tweak to 80 / 85 / 90 or custom) |
| Include / exclude patterns | empty | Glob wildcards, e.g. `*?variant=*`, `*/cart/*` |

## Performance

Tested on a Shopify store:

- **10 pages in 3.3 seconds** (5 workers, 0.1 s delay)
- **~3× faster** than a single-threaded crawler with 1 s delay
- **1500-page WordPress site** crawled in under 3 minutes (5 workers, default delay)

Concurrency scales linearly up to about 8 workers before target server rate limits become the bottleneck.

## Privacy

Runs entirely on your machine. No API calls, no accounts, no telemetry. The only HTTP requests made are to the target site you're crawling and (when you click "check for updates") `api.github.com` to read the latest commit SHA on this repo.

## Responsible use

You are responsible for the targets you crawl. Before pointing this tool at a site you don't own:

- **Respect `robots.txt`.** It's on by default for a reason. Disabling it on a site you don't own may violate that site's terms of service.
- **Respect rate limits.** The default `0.4 s` per-host delay and 5-worker concurrency are conservative. Keep them, or raise them, when crawling production sites. Hammering a server can be treated as abuse.
- **Honour the target's terms of service.** Some sites explicitly prohibit automated crawling. Read their ToS before scanning.
- **Personal / private data.** If a crawled page contains personal data, applicable privacy law (GDPR / UK GDPR / Australian Privacy Act / CCPA, etc.) may apply to anything you do with it afterwards. This tool stores results only in your local browser / process; what you do next is your responsibility.

The authors accept no liability for misuse. See the LICENSE for the full disclaimer.

## Trademarks

Screaming Frog, Sitebulb, Ahrefs, Shopify, WordPress, Yoast SEO, Rank Math, Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, and Joomla are trademarks of their respective owners. This project is an independent open-source tool and is not affiliated with, endorsed by, or sponsored by any of them. References to these names are descriptive comparisons / compatibility lists only.

## Licence

MIT. See [LICENSE](./LICENSE).

## Contributing

PRs welcome. The whole crawler is one readable Flask file (`app.py`) plus a minimal frontend, easy to extend.

## Related search terms

free SEO crawler, open source SEO spider, free Screaming Frog alternative, self-hosted SEO audit tool, technical SEO crawler, website crawler for SEO, free site audit tool, SEO site crawler open source, Shopify SEO crawler, WordPress SEO audit tool, Webflow SEO audit, free duplicate content checker, free duplicate title checker, free duplicate meta description checker, free duplicate H1 checker, free broken link checker, free redirect chain finder, free hreflang validator, free XML sitemap analyzer, GDPR-safe SEO crawler, no signup SEO tool, no API key SEO crawler, CMS-aware crawler, concurrent web crawler, local SEO spider, MIT licensed SEO tool, Python SEO crawler, Flask SEO crawler, SEO audit XLSX export, severity-grouped SEO issues, post-crawl SEO summary dashboard, auto-update SEO tool
