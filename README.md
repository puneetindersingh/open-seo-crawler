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

### One-line install — auto-start + auto-update (Linux / macOS / Windows)

Each installer registers the crawler as a background service that starts on boot/login and a daily auto-updater that pulls the latest from this repo (with rollback on failure). Installs to `~/open-seo-crawler` (or `%USERPROFILE%\open-seo-crawler` on Windows). Browser auto-opens to `http://localhost:5002/` when done.

| Platform | Install command |
|---|---|
| **Linux Mint / Ubuntu / Debian** | See below — `install.sh` |
| **macOS** (Intel + Apple Silicon) | See [macOS section](#one-line-install-on-macos) |
| **Windows 10 / 11** | See [Windows section](#one-line-install-on-windows-10--11) |

### One-line install on Linux Mint / Ubuntu / Debian

Installs to `~/open-seo-crawler`, registers a `systemd` service so it auto-starts on every boot, and sets up a daily + on-boot auto-updater that pulls the latest from this repo.

Open a terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install.sh -o install.sh && chmod +x install.sh && ./install.sh
```

That's it — when it finishes your browser opens to `http://localhost:5002/`.

Optional dry-run preflight first (checks Python, port, disk, internet — makes no changes):

```bash
curl -fsSL https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install.sh -o install.sh && chmod +x install.sh && ./install.sh --check
```

What the installer does:

- Verifies prerequisites (Python 3.10+, systemd, sudo, disk space, free port 5002, internet)
- Installs `python3 / python3-venv / git / curl` via `apt` if missing
- **Old Ubuntu/Mint support**: if the system ships Python < 3.10 (e.g. Mint 20.x = Python 3.8), the installer adds the deadsnakes PPA and tries `python3.13` → `3.12` → `3.11` → `3.10` until one installs cleanly. If none of those are available in the index, it falls back to **compiling Python 3.10.14 from source** automatically (~5–15 min).
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

That's it — when it finishes your browser opens to `http://localhost:5002/`.

Optional dry-run preflight first (checks Python, port, disk, internet — makes no changes):

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

That's it — when it finishes your browser opens to `http://localhost:5002/`.

Optional dry-run preflight first (checks Python, port, disk, internet — makes no changes):

```powershell
iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-windows.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1 -Check
```

What the installer does:

- Verifies prerequisites (Windows, Python 3.10+, disk space, free port 5002, internet)
- Installs Python 3.12 + Git via `winget` if missing
- Clones the repo to `%USERPROFILE%\open-seo-crawler`, creates a virtualenv, installs Python deps
- Registers a `OpenSeoCrawler` Task Scheduler task (starts at logon, runs in the background via `pythonw.exe` — no console window)
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

> If PowerShell's execution policy blocks the script, prefix with `-ExecutionPolicy Bypass` as shown above. No admin rights are needed — `winget --scope user` and user-level scheduled tasks both work without UAC.

### Optional: JS rendering (for SPAs)

Only needed for React / Vue / Wix / heavy Squarespace sites. Adds ~400 MB of browser dependencies.

```bash
pip install playwright
playwright install chromium
```

## Usage

1. Enter a website URL
2. (Optional) tweak defaults — 500 pages, 5 workers, 0.4 s per-host delay, depth 10. **Sitemap analysis** and **Near-duplicate content (≥90% similarity)** are pre-checked so a fresh crawl runs both post-analyses automatically.
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
| Max pages | 500 | Cap on total URLs crawled (1-5000 + Unlimited) |
| Workers | 5 | Concurrent HTTP workers (1-20) |
| Per-host delay | 0.4 s | Min gap between two requests to the same host. A warning is shown if set below 0.4 s |
| Max depth | 10 | Clicks from seed URL |
| Render JS | off | Enable for SPAs (requires Playwright) |
| Ignore robots.txt | off | Default: respect Disallow rules |
| Ignore noindex | off | Default: noindex pages excluded from duplicate / orphan reports |
| Sitemap analysis | **on** | Post-crawl: flags missing from sitemap, orphans, sitemap-only, non-200, redirects in sitemap |
| Near-duplicate content | **on** at 90% | Shingle Jaccard on body content; flag pairs ≥ 90% similar (tweak to 80/85/90 or custom) |
| Include / exclude patterns | empty | Glob wildcards, e.g. `*?variant=*`, `*/cart/*` |

## Performance

Tested on a Shopify store:

- **10 pages in 3.3 seconds** (5 workers, 0.1 s delay)
- **~3× faster** than a single-threaded crawler with 1 s delay

Concurrency scales linearly up to about 8 workers before target server rate limits become the bottleneck.

## Privacy

Runs entirely on your machine. No API calls, no accounts, no telemetry. The only HTTP requests made are to the target site you're crawling.

## Responsible use

You are responsible for the targets you crawl. Before pointing this tool at a site you don't own:

- **Respect `robots.txt`.** It's on by default for a reason. Disabling it on a site you don't own may violate that site's terms of service.
- **Respect rate limits.** The default `0.4 s` per-host delay and 5-worker concurrency are conservative — keep them, or raise them, when crawling production sites. Hammering a server can be treated as abuse.
- **Honour the target's terms of service.** Some sites explicitly prohibit automated crawling. Read their ToS before scanning.
- **Personal / private data.** If a crawled page contains personal data, applicable privacy law (GDPR / UK GDPR / Australian Privacy Act / CCPA, etc.) may apply to anything you do with it afterwards. This tool stores results only in your local browser / process — what you do next is your responsibility.

The authors accept no liability for misuse. See the LICENSE for the full disclaimer.

## Trademarks

Screaming Frog, Sitebulb, Ahrefs, Shopify, WordPress, Yoast SEO, Rank Math, Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, and Joomla are trademarks of their respective owners. This project is an independent open-source tool and is not affiliated with, endorsed by, or sponsored by any of them. References to these names are descriptive comparisons / compatibility lists only.

## Licence

MIT. See [LICENSE](./LICENSE).

## Contributing

PRs welcome. The whole crawler is one readable Flask file (`app.py`) plus a minimal frontend — easy to extend.

## Keywords

free SEO crawler, open-source SEO spider, Screaming Frog alternative, self-hosted SEO audit tool, technical SEO crawler, website crawler for SEO, SEO site audit tool, free site crawler, CMS-aware crawler, Shopify SEO crawler, WordPress SEO audit, concurrent web crawler, open source SEO spider tool
