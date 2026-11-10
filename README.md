# Open SEO Crawler: Free SEO Crawler, Website Audit & AI Crawler Checker (Self-Hosted)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Platform: Linux · macOS · Windows](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)](#one-line-install-auto-start--auto-update-linux--macos--windows)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)

**Open SEO Crawler is a free, open-source SEO crawler you run locally**: a self-hosted website SEO crawler and site audit tool that crawls any website for technical SEO issues. Fast, concurrent, and CMS-aware, it's a drop-in alternative to Screaming Frog, Sitebulb, and Ahrefs Site Audit, with no accounts, no API keys, no cloud, and no per-URL limits.

**It is also an AI crawler checker.** Can AI search and Google read your pages? After each crawl, a sample of pages is requested as Googlebot, Bingbot, Applebot and every AI crawler that publishes its user agent (GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, CCBot). A page that a crawler is blocked from, challenged on, redirected away from or served a thinner version of gets flagged, and so does text that only appears after JavaScript runs. When the crawl is done, the **Use with AI** button packs it into a summary and a ready-made prompt you can paste into any AI assistant, or hands you a setup prompt that connects your AI app to the crawler so it can run crawls itself.

**Your AI assistant can drive it.** The repo ships an MCP server and a command-line tool, so Claude Code, Claude Desktop, Cursor and other MCP apps (or any script) can start crawls, read the issues and pull up any page without opening the browser. The crawler still calls no AI: your assistant calls the crawler. [Set it up](#use-it-from-an-ai-assistant-mcp-or-the-command-line).

Built for SEO professionals, web developers, and site owners who want a real technical SEO audit that stays on their machine. Use it as a free SEO crawler for a single site or a recurring website crawler across your whole portfolio.

Built by [Puneet Singh](https://au.linkedin.com/in/puneet-singh0), a working SEO. Questions, ideas or bugs you would rather talk through? Connect on LinkedIn.

→ One-line install on Linux, macOS, or Windows. Auto-starts on boot, auto-updates daily. Browser opens at `http://localhost:5002/` when done.

![Crawl summary: every issue grouped by severity, with the count of affected pages](docs/screenshot-summary.png)

![Bot Readability: what Googlebot, Bingbot, Applebot and the AI crawlers each get from a sample of pages](docs/screenshot-bot-readability.png)

<sub>A 100-page test crawl of books.toscrape.com, a public scraping sandbox.</sub>

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

## Companion: SEO Side Panel for Chrome

The crawler covers a whole site. For the one page you have open, there is [SEO Side Panel](https://chromewebstore.google.com/detail/seo-side-panel/npjfeaapfebfgkmcbikigoigojfhcbho), a free Chrome extension from the same maker. It stays open beside every page you visit and lists each issue with its fix.

- **What AI crawlers miss.** The raw HTML the server sends, next to the rendered page. GPTBot, ClaudeBot and PerplexityBot do not run JavaScript, so anything that only appears after hydration is invisible to them.
- **Titles and meta descriptions measured in pixels,** not characters.
- **JSON-LD errors named by block and line,** in plain words.
- **Link status:** every link on the page marked 200, redirect or 404.

No account, no API key, no telemetry. Crawl the site here to find the pages with problems, then open one in Chrome to see what is wrong with it.

## What's new (recent additions)

- **Use with AI, two ways**: the top bar button now opens on a choice. *Paste a brief* copies the crawl as a Markdown brief for any AI chat. *Connect an AI app* gives a setup prompt with this computer's exact command and paths: paste it into an AI app that can run commands and it adds the MCP server itself. The command and the settings block are there to copy too, for setting it up by hand.
- **A plainer look, modelled on the crawlers people already use**: measured against the desktop and hosted crawlers. A light grey canvas with white panels, one blue, sentence case throughout, Lighthouse-style severity marks, a Summary laid out like an audit overview (crawled pages by status, pages with issues by severity, crawl details, one table of issues), plain 200s with badges only for redirects and errors, row actions on hover, and a dark mode in neutral greys. The settings column folds away once a crawl is on screen (Settings in the top bar brings it back), and Start crawl stays visible however long the settings get.
- **Crawl progress and a live Summary**: a bar under the top bar shows how far a crawl has got (pages crawled against crawled plus queued, capped at the page limit), the queue, the time so far and an estimate of the time left. A new crawl opens on the Summary, which fills in as pages arrive.
- **Pages reached through a redirect are now checked**: the crawler stores a followed redirect under the page it landed on, but skipped that page's content checks, so a start URL that redirects (example.com to www.example.com, or to a language folder) never had its title, meta description, H1, canonical or Open Graph checked. It does now, and those pages also count in the duplicate reports, the sitemap comparison and the exported sitemap.
- **A truer AI brief**: it names the start URL and where it redirects, says when the crawl stopped before reaching every linked page (so URLs it never reached are not called orphans), lists an issue that hits almost every page as the few pages without it, keeps `|` in titles as written, and dates the export in your own time zone. The sitemap report's *In sitemap, not crawled* list now says how many crawled pages link to each URL.
- **MCP server and command line**: connect Claude Code, Claude Desktop or any other MCP app to the crawler, or script it with `osc.py`. Start a crawl and follow it, read the Summary as data, filter pages by issue, open one page with its inlinks, compare two crawls, run the AI crawler check on any URL, export to .xlsx. Crawls started this way run the same checks as the browser and show up under Load. Standard-library Python, nothing extra to install. See [Use it from an AI assistant](#use-it-from-an-ai-assistant-mcp-or-the-command-line).
- **AI crawler checker (bot readability)**: after every crawl, a sample of pages is requested as a browser and as Googlebot, Bingbot, Applebot and the AI crawlers that publish their user agents (OAI-SearchBot, PerplexityBot, ChatGPT-User, GPTBot, CCBot). Blocks, CDN challenges, redirects, a different title or text, a thinner page or a noindex aimed at one crawler are flagged, as is content that only exists after JavaScript runs and a mobile page with less content than desktop. On by default for 10 pages.
- **AI brief** (now under *Use with AI*): one click turns the crawl into a compact Markdown brief with a ready-made prompt, to paste into any AI assistant for a ranked list of fixes. Issues are grouped the way the Summary groups them and URL lists are capped, so the brief fits a chat window. The crawler itself calls no AI and sends nothing anywhere.
- **Every report exports**: Export view now works on every report tab (All Titles, Redirect Chains, Hreflang, Deep Pages and the rest), and the .xlsx workbook adds a sheet for each report that has rows.
- **Safer and steadier**: crawled titles, URLs and robots.txt lines can no longer run script inside the app, other websites can no longer trigger Update or Restart, the Update button restarts cleanly under systemd and launchd, and sitemap analysis works again.
- **Malformed link href detection**: a scheme-less `href` containing a raw space (a street address or Google Maps Plus Code pasted straight into a link, e.g. `<a href="7FG4+8Q Springfield">Directions</a>`) used to resolve relative to every page carrying it and flood the crawl with phantom 404s. One broken footer link on a 300-page site meant ~300 fake 404 rows. Now it's skipped as a link and reported once per page as a **Malformed link href** issue naming the offending text.
- **JS vs no-JS compare mode**: with Render JS on, tick *Compare with non-JS HTML* to crawl every page in BOTH modes (Playwright-rendered and raw HTML). The per-page diff shows exactly which content is invisible to AI crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot), which mostly don't execute JavaScript.
- **Shared-instance support**: point the saved-crawls list at extra folders (`SITE_CRAWLER_EXTRA_CRAWL_DIRS`) so one office instance shows crawls from multiple tools, and label who ran each crawl by IP (`SITE_CRAWLER_USER_MAP`).
- **Crawl Budget page**: scans the homepage + section pages, buckets every discovered URL by query parameter, classifies crawl-budget traps (Elementor `?e-page-` AJAX pagination, faceted filters, sort / tracking / session params) and generates ready-to-paste robots.txt `Disallow` rules. Shows the sitemap's real page count next to the phantom parameter URLs so the wasted crawl budget is obvious.
- **Soft-404 / infinite-URL-trap detection**: after every crawl, two probe requests check whether the server returns 200 for URLs that cannot exist (`/<token>/` at the root, and nested under a real page). A 200 means the server soft-404s and mints an infinite crawlable URL space; flagged red in the issues sidebar with fix guidance.
- **Images Missing Alt report**: an image-centric bulk report with one row per image missing alt text and every page that embeds it.
- **robots.txt AI-crawler block detection**: flags, as a red error, when robots.txt blocks AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider + 20 more), meaning the site can't be read or cited by ChatGPT, Perplexity or Google AI Overviews, or when classic search engines (Googlebot/Bingbot) are blocked. Also detects Cloudflare `Content-Signal: ai-train=no` opt-outs. Surfaces on the homepage row in the issues sidebar under **AI Crawlers Blocked** / **Search Engines Blocked**.
- **Post-crawl Summary dashboard**: auto-opens after a crawl finishes with a one-glance view of issues by severity, total pages, response code mix, and the worst offenders.
- **Bulk SEO reports**: All Titles, All Metas, All H1s, All Canonicals, plus dedicated Duplicate Title / Duplicate Meta / Duplicate H1 / Duplicate Body / Multiple H1s / Redirect Chains / Response Codes / Deep Pages / Hreflang reports.
- **Severity-grouped issues view**: pages are bucketed by the worst issue on them (Errors / Warnings / Info) and grouped by issue type so you fix the highest-impact problems first.
- **One-click auto-update**: version badge in the topbar checks GitHub for newer commits and offers a one-click `git pull + restart + page reload` so you're always on the latest code.
- **Dark mode toggle**: explicit per-user choice (persists in localStorage), overrides system `prefers-color-scheme` cleanly.
- **Saved crawls list**: every crawl is auto-saved; reopen any historical crawl from the Load Saved modal. Names of who ran each crawl resolve across multiple tools on the same LAN.
- **Smart noindex / canonicalised handling**: these pages no longer inflate the Error count or get flagged as duplicates by Bulk Reports.

## Features

### Crawling

- **Concurrent crawling**: 5 workers by default, 1-20 configurable. Per-host politeness keeps you under target rate limits while still moving fast.
- **CMS detection + one-click recommendations**: auto-detects Shopify, WordPress (+ Yoast / Rank Math), Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, Joomla. Applies sensible exclude patterns and JS-render settings per platform.
- **Smart retry**: exponential backoff on 429 / 5xx / connection errors. Respects `Retry-After`, as seconds or as a date. Per-host adaptive back-off doubles when a server starts rate-limiting, decays back when it recovers.
- **Latency-aware pacing**: a host that answers slowly without ever returning an error gets its requests spaced out (about two in flight instead of one per worker), and goes back to full speed when it recovers. On by default; send `auto_throttle: false` to `/crawl` to switch it off.
- **Sitemap analysis**: fetches sitemap.xml, cross-checks against the crawl: flags missing from sitemap, orphans, sitemap-only URLs, non-200 in sitemap, redirects in sitemap.
- **Near-duplicate content**: shingle-based Jaccard similarity flags pairs of pages that are 90%+ similar (tweakable 80 / 85 / 90 or custom).
- **Robots.txt aware** (or ignore it, your choice).
- **Glob include / exclude patterns**: `*?variant=*`, `*/cart/*`, etc.
- **Optional JS rendering via Playwright**: install separately for SPA sites (React, Vue, Wix). With **Compare with non-JS HTML** ticked, every page is crawled in both modes and the diff flags content invisible to non-JS crawlers.
- **Built-in crawler-trap protection**: bad links and infinite URL spaces are filtered before they poison your reports, no config needed:
  - Non-page paths skipped (`/feed/`, `/wp-json/`, `/wp-admin/`, `/cdn-cgi/`, sitemap XML, cart/checkout AJAX endpoints)
  - Repeating-segment guard: refuses `/our-team/our-team/`-style URLs minted by path-relative nav hrefs
  - Page-builder pagination/filter params (`?e-page-*`, `?e-filter-*` Elementor AJAX, `?infinity` Jetpack) never enqueued (the classic "26k queued on a 9k-page site" blow-up)
  - Bare emails written without `mailto:` (`<a href="sales@example.com">`) dropped instead of becoming fake `/contact/sales@example.com` URLs
  - Plain text pasted into `href` (addresses, Google Maps Plus Codes) reported as a **Malformed link href** issue instead of spawning a phantom 404 under every page
  - Post-crawl soft-404 probes detect servers that return 200 for URLs that cannot exist

### AI crawler checker (bot readability)

Googlebot, Bingbot and Applebot render JavaScript; most AI crawlers do not say they do, so they read the HTML as served. After each crawl (tick box, on by default) a sample of pages, the home page plus one page from each section, is requested as a browser and as each crawler below, then compared.

- **Live requests** with the user agent each operator publishes: Googlebot (smartphone and desktop), Bingbot, Applebot, OAI-SearchBot, PerplexityBot, ChatGPT-User, GPTBot and CCBot.
- **robots.txt only** for crawlers with no published user agent (ClaudeBot, Claude-SearchBot, Claude-User) and for tokens that are not crawlers (Google-Extended, Applebot-Extended).
- **Per page and crawler**: blocked (403, 429, 503), CDN challenge, redirected elsewhere, noindex for that crawler only, different title, H1, canonical or text, or a thinner page. Each page is fetched twice as a browser first, so pages that change on every load are not called different.
- **JavaScript**: each sample page is rendered once to count the words that only exist after JavaScript runs, and to catch a noindex in the HTML that a script removes (Google may skip rendering such a page).
- **Mobile first**: Googlebot smartphone against Googlebot desktop.
- **On every crawled page**: robots directives with the meaning their owners document for AI answers (nosnippet, noarchive and nocache for Bing Copilot, max-snippet, data-nosnippet) and noindex aimed at Googlebot or Bingbot only.

The requests come from your machine with each crawler's user agent. CDNs and firewalls recognise the real crawlers by IP address or signature, so a result can differ from what the real crawler gets, in either direction: treat a problem as a lead to check in your CDN or firewall settings, and confirm Googlebot with the URL Inspection live test in Search Console. Use it on sites you own or audit.

### What gets checked per page

- **Titles**: missing, too long (>60 chars), too short, duplicate across pages, identical to H1
- **Meta descriptions**: missing, too long (>160 chars), too short, duplicate across pages
- **H1 tags**: missing, multiple H1s, identical to title, duplicate across pages
- **Canonical tags**: missing, points elsewhere (canonicalised), self-referencing
- **Schema.org structured data**: presence + types detected from both JSON-LD and microdata (`itemtype`) markup
- **Open Graph + Twitter Card**: missing `og:title`, `og:image`, `twitter:card`
- **Content**: thin content (<200 words), near-duplicate bodies (Jaccard similarity)
- **Performance**: slow response time (>3 s)
- **Redirects**: real redirects vs trailing-slash / www / HTTPS normalisations (classified separately so trailing-slash 301s don't pollute your Redirect Chain report)
- **Redirect chains**: multi-hop redirects flagged with full hop list
- **HTTP errors**: 4xx / 5xx with retry counts
- **Indexability**: `noindex` in meta robots or X-Robots-Tag
- **Hreflang**: extracted, validated, missing return-tags flagged
- **Pagination**: `/page/N/`, `?page=N`, `?paged=N` and builder-prefixed variants like `?_page=N` crawled but skipped for SEO issue checks (no false positives for missing meta on paginated archives)
- **Mobile-friendliness**: viewport meta tag presence
- **Mixed content**: HTTPS pages loading HTTP resources
- **URL hygiene**: uppercase, underscores, spaces, >115 chars, tracking parameters
- **Malformed link hrefs**: plain text pasted into an `href` (addresses, Plus Codes) flagged per page instead of crawled as phantom URLs
- **Images**: count of images missing `alt` attributes (decorative `alt=""` not penalised)
- **Security headers**: HTTPS, HSTS, CSP, X-Frame-Options, X-Content-Type-Options
- **Deep pages**: URLs more than N clicks from the homepage (configurable)
- **Soft 404s / URL traps**: post-crawl probes detect servers that return 200 for non-existent URLs (root and nested), creating an infinite crawlable URL space; redirects and 4xx/5xx probe responses are treated as healthy

### Bulk reports (sidebar)

Every report exports to XLSX so you can hand it to a content team or dev:

- **All Titles** / **All Metas** / **All H1s** / **All Canonicals**: one row per page
- **Duplicate Titles** / **Duplicate Metas** / **Duplicate H1s** / **Duplicate Bodies**: grouped by duplicate value, normalised URLs (no trailing-slash false positives)
- **Multiple H1s**: pages with 2+ H1 tags, dynamic H1(1) / H1(2) / H1(N) columns
- **Redirect Chains**: pages reached via 2+ hops, with the full chain
- **Response Codes**: breakdown by status code
- **Deep Pages**: URLs N+ clicks from homepage
- **Images Missing Alt**: one row per image missing alt text, with every page that embeds it
- **Hreflang**: extracted, validated, cross-page consistency checked
- **Severity views**: All Errors / All Warnings / All Info, with irrelevant columns hidden per view

### Crawl budget analysis

- **On-demand Crawl Budget page** (topbar): no full crawl needed. It scans the homepage and section pages, buckets every discovered URL by query parameter, and classifies which parameters are crawl-budget traps, Elementor `?e-page-` AJAX pagination, faceted filters, sort orders, tracking and session IDs.
- **Ready-to-paste robots.txt rules**: generates the exact `Disallow` lines to block each trap, and explains what each trap is and why robots.txt is the right fix.
- **Waste made visible**: shows the sitemap's real page count next to the phantom parameter URLs, so you can see how much crawl budget is spent on URLs that shouldn't exist.
- **Soft-404 / infinite-URL-trap probe**: runs automatically after every crawl; results land in a red **URL Traps** category in the issues sidebar with a detail panel and fix guidance.

### Auto-update + version badge

- Topbar version badge shows the current build, polls GitHub for newer commits, and flips to **"Update available"** when there's a newer master commit.
- One click runs `git pull + restart service + reload page` end-to-end. No SSH, no manual commands.
- Background daily auto-update (Linux systemd timer / macOS LaunchAgent / Windows Task Scheduler) keeps everyone on the latest without you thinking about it. Rolls back automatically if a pull breaks the app.

### UI

- **Post-crawl Summary** dashboard auto-opens with severity counts, top issues, and crawl stats.
- **Severity sidebar**: All Pages / Errors / Warnings / Info, each with live counts.
- **Issue grouping**: click any severity and see issues grouped by type with the worst-affected pages listed under each.
- **Page detail dock**: click any URL for full page metadata, all issues for that page, inlinks (with anchor text), outlinks.
- **Dark mode**: toggle in the topbar, persists per user.
- **Saved crawls**: every crawl auto-saved, reopenable from the Load Saved modal, with the date it was saved shown when you open one.
- **Use with AI**: copy or download a compact brief of the crawl, with an editable prompt, for any AI assistant; or copy a setup prompt that connects an AI app to the crawler over MCP.
- **Sitemap + XLSX export buttons** in the topbar, one click each.

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

## One-line install: auto-start + auto-update (Linux / macOS / Windows)

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

Uses `winget` + a Startup-folder shortcut. No admin rights needed.

Open PowerShell (Start menu → type "powershell" → Enter) and paste:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-windows.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Dry-run preflight:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-windows.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1 -Check
```

> The `Tls12` prefix forces a modern TLS handshake. Without it, Windows PowerShell 5.1 on some machines defaults to TLS 1.0/1.1 and the GitHub download fails with *"Could not create SSL/TLS secure channel."*

What the installer does:

- Verifies prerequisites (Windows, Python 3.10+, disk space, free port 5002, internet)
- Installs Python 3.12 + Git via `winget` (pinned to `--source winget` so it never trips over the msstore source's certificate error) if missing
- Resolves the real `python.exe` directly (registry + standard install dirs), so the Microsoft Store `python` alias stub can't shadow a freshly-installed Python
- Clones the repo to `%USERPROFILE%\open-seo-crawler`, creates a virtualenv, installs Python deps
- Writes helper scripts (`Run.ps1`, `Stop.ps1`, `Update.ps1`, `Autostart.ps1`) into the install folder
- Adds Start Menu + Desktop shortcuts, and (unless `-NoAutostart`) a Startup-folder shortcut that pulls the latest code on each logon then launches the app in the background via `pythonw.exe` (no console window)
- Starts the crawler and opens `http://localhost:5002/` in your default browser

Flags: `-Check` (preflight only), `-UpdateNow` (pull + reinstall deps), `-NoAutostart` (skip the logon Startup shortcut).

Useful commands after install (PowerShell):

```powershell
& "$env:USERPROFILE\open-seo-crawler\Run.ps1"        # run in this window
& "$env:USERPROFILE\open-seo-crawler\Stop.ps1"       # stop whatever is on port 5002
& "$env:USERPROFILE\open-seo-crawler\Update.ps1"     # pull latest + reinstall deps if changed
Get-Content "$env:USERPROFILE\open-seo-crawler\autostart.log" -Tail 50 -Wait   # tail autostart/update log
```

To disable auto-start on logon, delete the `Open SEO Crawler (Autostart)` shortcut from
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`.

> If PowerShell's execution policy blocks the script, the `-ExecutionPolicy Bypass` prefix shown above handles it. No admin rights are needed; `winget --scope user` and the user-level Startup shortcut both work without UAC.

### JS rendering (for SPAs and no-code builders)

Needed for React / Vue / Wix / Bubble / heavy Squarespace sites. Tick **Render JS** before a crawl: the first time, the crawler installs Playwright and Chromium into its own Python by itself (one-time download, a couple of minutes, progress shown in the corner). Sites whose menus are clickable elements with no `<a href>` links (Bubble and similar) are followed by clicking them in the headless browser, and each such page is flagged "JS-only navigation", because search engines only follow real links.

If the automatic setup fails (no internet, locked-down Python), the crawl tells you why. Install manually with the crawler's Python, then restart it:

```bash
python -m pip install playwright
python -m playwright install chromium
```

## Usage

1. Enter a website URL
2. (Optional) tweak defaults: 1500 pages, 5 workers, 0.4 s per-host delay, depth 10. **Sitemap analysis** and **Near-duplicate content (≥90% similarity)** are pre-checked so a fresh crawl runs both post-analyses automatically.
3. Click **Start crawl**

The tool detects the target's CMS on the first request and offers a one-click **Apply recommendations** button that populates sensible exclude patterns and worker counts.

The **Summary** tab auto-opens during the crawl and live-refreshes as pages come in. When the crawl finishes you have:

- A severity breakdown (Errors / Warnings / Info) with live counts
- Bulk reports for every common SEO audit (All Titles, Duplicate Titles, Redirect Chains, etc.)
- A page-detail dock for any URL (click a row): metadata, issues, inlinks, outlinks
- Sitemap + XLSX export buttons in the topbar

## Use it from an AI assistant (MCP) or the command line

Two files in the repo let other programs use the crawler that is already running on port 5002:

- `mcp_server.py`, an MCP server. Your AI app starts it as a local program and talks to it over stdin and stdout, so no port is opened and there is nothing to log in to.
- `osc.py`, the same tools as terminal commands, with `--json` on every command for scripts.

Both need the crawler running (the one-line installers keep it running) and nothing beyond Python's standard library.

The server is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io/) as `io.github.puneetindersingh/open-seo-crawler`, so MCP apps and directories that read the registry can find it.

### Connect an AI app

The quickest way: click **Use with AI** in the top bar, open **Connect an AI app** and copy the setup prompt. It carries the exact command and paths for your machine. Paste it into an AI app that can run commands on your computer, and the app adds the MCP server with its own command, checks it connects and tells you if it needs a restart.

To do it by hand, run this once. It prints the exact command and config block for your machine, and tells you whether the crawler is up:

```bash
~/open-seo-crawler/venv/bin/python3 ~/open-seo-crawler/osc.py setup
```

On Windows: `%USERPROFILE%\open-seo-crawler\venv\Scripts\python.exe %USERPROFILE%\open-seo-crawler\osc.py setup`

**Claude Code** (MCP over stdio), one command:

```bash
claude mcp add --scope user open-seo-crawler -- ~/open-seo-crawler/venv/bin/python3 ~/open-seo-crawler/mcp_server.py
```

Then run `/mcp` in Claude Code and `open-seo-crawler` should show as connected. Ask something like "crawl example.com, 100 pages, and give me the ten fixes that matter most".

**Claude Desktop, one click** (MCP extension): download `open-seo-crawler-mcp.mcpb` from the [latest MCP release](https://github.com/puneetindersingh/open-seo-crawler/releases?q=mcp-v) and install it from Settings, then Extensions, then Advanced settings, then Install Extension. It needs Python 3.10+ on the PATH and the crawler running. It asks for the crawler address; the default fits a normal install.

**Claude Desktop by hand** (MCP config file): open Settings, then Developer, then Edit Config, and add the server to `claude_desktop_config.json` with the full paths `osc.py setup` printed:

```json
{
  "mcpServers": {
    "open-seo-crawler": {
      "command": "/home/you/open-seo-crawler/venv/bin/python3",
      "args": ["/home/you/open-seo-crawler/mcp_server.py"]
    }
  }
}
```

Restart Claude Desktop so it loads the MCP server. On Windows the paths look like `C:\\Users\\you\\open-seo-crawler\\venv\\Scripts\\python.exe`, with the backslashes doubled inside JSON. Use the config file rather than Settings, Connectors: connectors are reached over the internet, and this server only runs on your computer.

**Other MCP apps** (Cursor, VS Code, Windsurf and the rest): add the same command and arguments as a local (stdio) MCP server in the app's settings. Many apps take the `mcpServers` block above as it is; check your app's MCP docs for where it goes.

If the crawler runs on another port or another machine, set `OSC_URL` (for example `http://office-pc:5002`) in the server's environment.

### What your assistant can do

| Tool | What it does |
|---|---|
| `start_crawl` | Crawl a site with the app's engine, settings and defaults. Returns a job id straight away |
| `crawl_status`, `stop_crawl` | Follow a crawl; stop it and keep what was fetched, like the Stop button |
| `list_crawls` | Saved crawls from the last 30 days, from the app or from here |
| `crawl_summary` | The Summary tab as data: issues by severity with page counts and sample URLs, duplicates, redirect chains, sitemap gaps, near duplicates, bot readability |
| `get_pages`, `get_page` | Filter pages by issue, severity, status code, URL or indexability; open one URL in full with its inlinks |
| `get_brief` | The AI brief as Markdown |
| `compare_crawls` | What changed between two crawls of a site |
| `bot_check` | The AI crawler readability check for any URLs, no crawl needed |
| `check_robots`, `detect_cms` | robots.txt and the CMS behind any URL |
| `export_xlsx` | The .xlsx export, written to a path you choose |

There is also an `seo_audit` prompt that loads the AI brief for a saved crawl. Apps that support MCP prompts show it as a slash command.

A crawl started from an AI app runs exactly like one started in the browser: the same engine and defaults, then sitemap analysis, near-duplicate detection and the bot readability check, then the same auto-save, so it appears under **Load** in the app. robots.txt is respected unless you, or the AI at your request, turn it off. Read [Responsible use](#responsible-use) before letting an assistant crawl sites you don't own.

### Command line

```bash
cd ~/open-seo-crawler
venv/bin/python3 osc.py crawl https://example.com --max-pages 200   # crawl, save, print the summary
venv/bin/python3 osc.py summary latest                               # issue counts for a saved crawl
venv/bin/python3 osc.py pages latest --issue "Missing H1"            # which pages have it
venv/bin/python3 osc.py page latest https://example.com/about/       # one page and its inlinks
venv/bin/python3 osc.py brief latest --out brief.md                  # the AI brief as a file
venv/bin/python3 osc.py compare <older crawl> <newer crawl>          # what changed
venv/bin/python3 osc.py bots https://example.com/                    # AI crawler readability
venv/bin/python3 osc.py export latest crawl.xlsx
venv/bin/python3 osc.py list
```

Name a crawl with `latest`, a file name from `osc.py list`, or part of the site name (the newest match wins). Add `--json` to any command for machine-readable output. In a deploy pipeline, `osc.py crawl <staging URL> --fail-on error` exits with code 1 when any page has an error, so the deploy can stop there. Exit code 2 means the command itself failed, for example because the crawler isn't running.

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
| Compare with non-JS HTML | off | With Render JS on: crawl each page in both modes, diff flags JS-only content invisible to non-JS crawlers |
| Ignore robots.txt | off | Default: respect Disallow rules |
| Ignore noindex | off | Default: noindex pages excluded from duplicate / orphan reports |
| Sitemap analysis | **on** | Post-crawl: flags missing from sitemap, orphans, sitemap-only, non-200, redirects in sitemap |
| Near-duplicate content | **on** at 90% | Shingle Jaccard on body content; flag pairs ≥ 90% similar (tweak to 80 / 85 / 90 or custom) |
| Bot readability check | **on**, 10 pages | Post-crawl: sample pages requested as a browser and as each crawler, compared with and without JavaScript; about 11 requests per page at the per-host delay |
| Include / exclude patterns | empty | Glob wildcards, e.g. `*?variant=*`, `*/cart/*` |

Optional environment variables (for shared / multi-tool setups):

| Variable | Purpose |
|---|---|
| `SITE_CRAWLER_EXTRA_CRAWL_DIRS` | Colon-separated extra folders to union (read-only) into the saved-crawls list, so one instance shows crawls saved by other tools |
| `SITE_CRAWLER_USER_MAP` | Path to a JSON dict mapping IP → friendly name (default `~/.site-crawler-users.json`), so saved crawls show who ran them instead of an IP |

## Performance

Tested on a Shopify store:

- **10 pages in 3.3 seconds** (5 workers, 0.1 s delay)
- **~3× faster** than a single-threaded crawler with 1 s delay
- **1500-page WordPress site** crawled in under 3 minutes (5 workers, default delay)

Concurrency scales linearly up to about 8 workers before target server rate limits become the bottleneck.

## Privacy

Runs entirely on your machine. No API calls, no accounts, no telemetry. The only HTTP requests made are to the target site you're crawling and to `api.github.com`, which the page asks for the latest commit SHA on this repo (at most once every 10 minutes) to show the update badge. Nothing about your crawls is sent.

The MCP server and `osc.py` talk only to the crawler on your own machine. Once you connect an AI app, whatever the tools return (URLs, titles, headings, issues, some page text) goes to that app and its AI provider under your account with them. Text from crawled sites is labelled as data, not instructions, but it still comes from someone else's website, so keep your AI app's approval prompts on for tools that start crawls or write files.

## Responsible use

You are responsible for the targets you crawl. Before pointing this tool at a site you don't own:

- **Respect `robots.txt`.** It's on by default for a reason. Disabling it on a site you don't own may violate that site's terms of service.
- **Respect rate limits.** The default `0.4 s` per-host delay and 5-worker concurrency are conservative. Keep them, or raise them, when crawling production sites. Hammering a server can be treated as abuse.
- **Honour the target's terms of service.** Some sites explicitly prohibit automated crawling. Read their ToS before scanning.
- **Personal / private data.** If a crawled page contains personal data, applicable privacy law (GDPR / UK GDPR / Australian Privacy Act / CCPA, etc.) may apply to anything you do with it afterwards. This tool stores results only in your local browser / process; what you do next is your responsibility.

The authors accept no liability for misuse. See the LICENSE for the full disclaimer.

## Trademarks

Screaming Frog, Sitebulb, Ahrefs, Shopify, WordPress, Yoast SEO, Rank Math, Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, and Joomla are trademarks of their respective owners. This project is an independent open-source tool and is not affiliated with, endorsed by, or sponsored by any of them. References to these names are descriptive comparisons / compatibility lists only.

## About

Open SEO Crawler is built and maintained by [Puneet Singh](https://au.linkedin.com/in/puneet-singh0), an SEO who uses it on real sites every week. Bug reports go in [GitHub Issues](https://github.com/puneetindersingh/open-seo-crawler/issues). For anything else, connect on [LinkedIn](https://au.linkedin.com/in/puneet-singh0).

More free SEO tools from the same maker, including the SEO Side Panel Chrome extension and a WordPress plugin: **[puneetindersingh.github.io](https://puneetindersingh.github.io/)**

## Licence

MIT. See [LICENSE](./LICENSE).

## Contributing

PRs welcome. The whole crawler is one readable Flask file (`app.py`) plus a minimal frontend, easy to extend.

## FAQ

**Is there a free SEO crawler?**
Yes. Open SEO Crawler is a free, MIT-licensed SEO crawler with no page limit. Clone it, run `python3 app.py`, and crawl any website locally: no account, no API key, no credit card.

**What is the best free Screaming Frog alternative?**
Open SEO Crawler covers the core technical-SEO crawl most people use Screaming Frog for (titles, meta descriptions, H1s, canonicals, redirects, broken links, hreflang, duplicate content, sitemaps and structured data) with unlimited URLs in the free tier and one-click XLSX export. The free Screaming Frog tier caps at 500 URLs; this has no cap.

**Can this SEO crawler handle large websites?**
Yes. It crawls concurrently (1-20 workers) with per-host rate limiting. A 1,500-page site finishes in under three minutes on default settings; set the page cap to Unlimited for bigger sites.

**Does the website crawler work on Shopify, WordPress, and Webflow?**
Yes. It auto-detects 10 CMS platforms (Shopify, WordPress + Yoast / Rank Math, Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, Joomla) and applies sensible crawl presets for each.

**Is it really free and open source?**
Yes: MIT licensed and self-hosted, running entirely on your machine. No telemetry, no phone-home, no per-URL billing.

**Is there a Chrome extension for checking a single page?**
Yes: [SEO Side Panel](https://chromewebstore.google.com/detail/seo-side-panel/npjfeaapfebfgkmcbikigoigojfhcbho), free and from the same maker. The crawler audits the whole site from your machine. The extension checks the page you are on, in a panel beside it, including what AI crawlers can and cannot read.

## Related search terms

SEO crawler, free SEO crawler, website SEO crawler, free SEO crawler tool, open source SEO crawler, free SEO spider, online SEO crawler self-hosted, open source SEO spider, free Screaming Frog alternative, self-hosted SEO audit tool, technical SEO crawler, website crawler for SEO, free site audit tool, SEO site crawler open source, Shopify SEO crawler, WordPress SEO audit tool, Webflow SEO audit, free duplicate content checker, free duplicate title checker, free duplicate meta description checker, free duplicate H1 checker, free broken link checker, free redirect chain finder, free hreflang validator, free XML sitemap analyzer, GDPR-safe SEO crawler, no signup SEO tool, no API key SEO crawler, CMS-aware crawler, concurrent web crawler, local SEO spider, MIT licensed SEO tool, Python SEO crawler, Flask SEO crawler, SEO audit XLSX export, severity-grouped SEO issues, post-crawl SEO summary dashboard, auto-update SEO tool
