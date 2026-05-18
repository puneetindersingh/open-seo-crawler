// Open SEO Crawler — client.

// ─── Refresh / close guard for in-flight crawls ─────────────────────
// Trip the browser's native "Leave site?" dialog if the user hits
// refresh or closes the tab while a crawl is mid-flight. The crawl
// loop is fully client-side — a refresh kills the SSE stream and any
// pages not yet rendered are lost.
window._activeProcesses = window._activeProcesses || new Map();
window.markBusy = function(key, label) {
  if (!key) return;
  window._activeProcesses.set(key, label || key);
};
window.clearBusy = function(key) {
  if (!key) return;
  window._activeProcesses.delete(key);
};
window.addEventListener('beforeunload', function(e) {
  if (window._activeProcesses && window._activeProcesses.size > 0) {
    const msg = 'A process is still running. Leaving now will stop it midway.';
    e.preventDefault();
    e.returnValue = msg;
    return msg;
  }
});

let crawlerAbort = null;
let crawlerTimer = null;
let crawlerStart = 0;
let crawlerResults = [];
let crawlerInlinks = {}; // target URL -> [{source, anchor, placement}]
let crawlerCrawlId = null;
let dockUrl = null;

// crawlerInlinks is keyed by whichever URL form the linker emitted (with or
// without trailing slash, etc). Look up under all the common variants so a
// /foo vs /foo/ mismatch doesn't silently show 0 inlinks.
function _scLookupInlinks(url) {
  if (!url || !crawlerInlinks) return [];
  return crawlerInlinks[url]
      || crawlerInlinks[url.replace(/\/$/, '')]
      || crawlerInlinks[url + '/']
      || [];
}
let activeCategory = 'all';

// Per-category metadata: severity, explanation, cited sources.
// Shown in the info box above the table when a category is clicked.
const ISSUE_META = {
  'Missing meta description': { sev: 'error', why: 'Google falls back to scraping body copy for the SERP snippet — almost always worse CTR than a hand-written description.', sources: [['Ahrefs — Meta Description', 'https://ahrefs.com/blog/meta-description/'], ['Moz — Meta Description', 'https://moz.com/learn/seo/meta-description']] },
  'Meta desc too long': { sev: 'warn', why: 'Google truncates around 155–160 characters on desktop, shorter on mobile. Past that gets ellipsised.', sources: [['Moz — Meta Description', 'https://moz.com/learn/seo/meta-description'], ['Ahrefs — Meta Description', 'https://ahrefs.com/blog/meta-description/']] },
  'Meta desc too short': { sev: 'warn', why: 'Under ~120 characters wastes SERP real estate and gives Google less to match against queries.', sources: [['Ahrefs — Meta Description', 'https://ahrefs.com/blog/meta-description/'], ['Moz — Meta Description', 'https://moz.com/learn/seo/meta-description']] },
  'Missing title': { sev: 'error', why: 'The <title> is the strongest on-page ranking signal and the clickable SERP heading. Missing means Google invents one — usually badly.', sources: [['Moz — Title Tag', 'https://moz.com/learn/seo/title-tag'], ['Ahrefs — Title Tag', 'https://ahrefs.com/blog/title-tag/']] },
  'Title too long': { sev: 'warn', why: 'Google truncates titles at ~600 px (≈60 chars). Lead with the primary keyword, put brand last.', sources: [['Moz — Title Tag', 'https://moz.com/learn/seo/title-tag'], ['Ahrefs — Title Tag', 'https://ahrefs.com/blog/title-tag/']] },
  'Title too short': { sev: 'warn', why: 'Titles under ~30 chars under-use SERP real estate and miss supporting keywords.', sources: [['Moz — Title Tag', 'https://moz.com/learn/seo/title-tag']] },
  'Missing H1': { sev: 'error', why: 'The H1 tells users and search engines what the page is about. Missing H1s hurt accessibility (screen readers) and topical relevance.', sources: [['Ahrefs — H1 Tag', 'https://ahrefs.com/blog/h1-tag/']] },
  'Multiple H1s': { sev: 'warn', why: 'Dilutes topical signal and usually indicates a template issue. One clear H1 per page is the safe pattern.', sources: [['Ahrefs — H1 Tag', 'https://ahrefs.com/blog/h1-tag/']] },
  'H1 same as title': { sev: 'warn', why: 'Title and H1 serve different jobs — title is for SERP CTR (≤60 chars, keyword-first), H1 is for on-page clarity. Identical text wastes a chance to target a second keyword angle.', sources: [['Ahrefs — H1 Tag', 'https://ahrefs.com/blog/h1-tag/'], ['Moz — Title Tag', 'https://moz.com/learn/seo/title-tag']] },
  'Missing canonical': { sev: 'error', why: 'Without a canonical, Google has to guess which URL variant to index. Picks non-deterministically and splits link equity.', sources: [['Ahrefs — Canonical Tags', 'https://ahrefs.com/blog/canonical-tags/'], ['Moz — Canonicalization', 'https://moz.com/learn/seo/canonicalization']] },
  'Canonicalised': { sev: 'warn', why: 'The canonical points elsewhere, so Google will drop this URL from the index and keep the canonical target instead.', sources: [['Ahrefs — Canonical Tags', 'https://ahrefs.com/blog/canonical-tags/'], ['Moz — Canonicalization', 'https://moz.com/learn/seo/canonicalization']] },
  'imgs missing alt': { sev: 'warn', why: 'Alt text is required for accessibility and is how Google Images + AI engines understand visuals.', sources: [['Ahrefs — Image Alt Text', 'https://ahrefs.com/blog/image-alt-text/'], ['Moz — Alt Text', 'https://moz.com/learn/seo/alt-text']] },
  'No schema': { sev: 'warn', why: 'Without JSON-LD, Google can\'t award rich results and AI engines have to parse HTML to figure out entity/relationship signals.', sources: [['Ahrefs — Schema Markup', 'https://ahrefs.com/blog/schema-markup/'], ['Moz — Schema', 'https://moz.com/learn/seo/schema-structured-data']] },
  'Thin content': { sev: 'warn', why: 'Pages under ~200 words rarely rank because they fail to cover intent. Google\'s Helpful Content system penalises pages that don\'t satisfy the query.', sources: [['Ahrefs — Thin Content', 'https://ahrefs.com/blog/thin-content/']] },
  'Slow': { sev: 'warn', why: 'Response time over 3s degrades Core Web Vitals (LCP, INP) and increases bounce. Field LCP ≤2.5s is Google\'s "good" threshold.', sources: [['Ahrefs — Page Speed', 'https://ahrefs.com/blog/page-speed/'], ['Moz — Page Speed', 'https://moz.com/learn/seo/page-speed']] },
  'Redirect': { sev: 'warn', why: 'Real content redirects mean inbound links hit stale URLs. Update internal links to the final destination to preserve crawl budget and link equity.', sources: [['Ahrefs — 301 Redirects', 'https://ahrefs.com/blog/301-redirects/'], ['Moz — Redirection', 'https://moz.com/learn/seo/redirection']] },
  'noindex': { sev: 'error', why: 'The page is explicitly telling Google not to index it. Intentional for staging; catastrophic on money pages.', sources: [['Ahrefs — Noindex', 'https://ahrefs.com/blog/noindex/']] },
  'HTTP': { sev: 'error', why: 'A 4xx/5xx response means users and Googlebot hit an error page. 404s on indexed URLs bleed link equity.', sources: [['Ahrefs — HTTP Status Codes', 'https://ahrefs.com/blog/http-status-codes/'], ['Moz — HTTP Status Codes', 'https://moz.com/learn/seo/http-status-codes']] },
  'Missing viewport': { sev: 'warn', why: 'Without viewport meta, mobile browsers render at desktop width. Google flags the page as not mobile-friendly.', sources: [['Ahrefs — Mobile SEO', 'https://ahrefs.com/blog/mobile-seo/'], ['Moz — Mobile Optimization', 'https://moz.com/learn/seo/mobile-optimization']] },
  'URL:': { sev: 'warn', why: 'URL hygiene issues (uppercase, underscores, spaces, >115 chars, tracking params) create duplicate-URL risk and hurt CTR.', sources: [['Ahrefs — URL Structure', 'https://ahrefs.com/blog/url-structure/'], ['Moz — URL', 'https://moz.com/learn/seo/url']] },
  'Mixed content': { sev: 'error', why: 'HTTPS pages loading HTTP resources break the padlock and modern browsers block active mixed content.', sources: [['Ahrefs — HTTPS Migration', 'https://ahrefs.com/blog/https-migration/']] },
  'Missing Open Graph': { sev: 'warn', why: 'Without og:title/og:description/og:image, Facebook/LinkedIn/Slack previews scrape random page elements. Shares look ugly, CTR drops.', sources: [['Ahrefs — Open Graph Tags', 'https://ahrefs.com/blog/open-graph-meta-tags/']] },
  'Missing og:image': { sev: 'warn', why: 'Without an og:image, shared links render as text-only cards — significantly lower engagement. Recommended size: 1200×630.', sources: [['Ahrefs — Open Graph Tags', 'https://ahrefs.com/blog/open-graph-meta-tags/']] },
  'Missing Twitter Card': { sev: 'info', why: 'Without twitter:card metadata, X falls back to Open Graph or plain text. Summary Large Image card gives the best preview.', sources: [['Ahrefs — Open Graph Tags', 'https://ahrefs.com/blog/open-graph-meta-tags/']] },
  // Bulk Reports — informational panels (no severity). renderIssueInfo()
  // surfaces the why text + sources above the panel so users get context
  // without having to remember what each report is for.
  '__all_titles':     { sev: 'info', why: 'Every crawled page with its title tag — review for keyword coverage, length, and brand consistency across the site. Use the chars column to spot truncation risk.', sources: [['Ahrefs — Title Tag', 'https://ahrefs.com/blog/title-tag/'], ['Moz — Title Tag', 'https://moz.com/learn/seo/title-tag']] },
  '__all_metas':      { sev: 'info', why: 'Every crawled page with its meta description — scan for missing descriptions, duplication, length issues, and brand voice consistency. Google rewrites ~70% of descriptions but a strong starting point still wins CTR.', sources: [['Ahrefs — Meta Description', 'https://ahrefs.com/blog/meta-description/']] },
  '__all_h1s':        { sev: 'info', why: 'Every crawled page with its primary H1 — confirms the page-level topical signal Google sees. Look for H1s that don\'t match the URL/title intent (template misuse).', sources: [['Ahrefs — H1 Tag', 'https://ahrefs.com/blog/h1-tag/']] },
  '__all_canonicals': { sev: 'info', why: 'Every crawled page with its rel=canonical target. Spot self-canonicals (good), cross-canonicals to unrelated URLs (often template bugs), and missing tags.', sources: [['Ahrefs — Canonical Tags', 'https://ahrefs.com/blog/canonical-tags/']] },
  '__dup_titles':     { sev: 'warn', why: 'Pages sharing the same title compete with each other for the same query — Google picks one and ignores the rest. Either canonicalise, consolidate, or rewrite to differentiate.', sources: [['Ahrefs — Duplicate Content', 'https://ahrefs.com/blog/duplicate-content/']] },
  '__dup_metas':      { sev: 'warn', why: 'Duplicate meta descriptions across many pages = generic templated copy. Pages get the same SERP snippet, weakening CTR uplift for whichever page Google picks.', sources: [['Ahrefs — Meta Description', 'https://ahrefs.com/blog/meta-description/']] },
  '__dup_h1s':        { sev: 'warn', why: 'Multiple pages with identical H1s look like duplicate content to Google. Either the pages truly are duplicates (consolidate) or the H1 isn\'t specific enough.', sources: [['Ahrefs — H1 Tag', 'https://ahrefs.com/blog/h1-tag/']] },
  '__dup_bodies':     { sev: 'warn', why: 'Identical body content (MD5 match on stripped text) is hard duplicate content — Google will pick one and drop the rest. Check for template bleed, paginated archives, or cross-domain syndication.', sources: [['Ahrefs — Duplicate Content', 'https://ahrefs.com/blog/duplicate-content/']] },
  '__redir_chains':   { sev: 'warn', why: 'Each redirect hop wastes crawl budget and link equity. Google stops following after ~5 hops, after which the destination gets ignored. Always link directly to the final URL.', sources: [['Ahrefs — 301 Redirects', 'https://ahrefs.com/blog/301-redirects/'], ['Moz — Redirection', 'https://moz.com/learn/seo/redirection']] },
  '__response_codes': { sev: 'info', why: 'Crawl-wide HTTP status code distribution. A healthy site is mostly 2xx with a small tail of 3xx redirects; spikes in 4xx/5xx mean indexable URLs are bleeding link equity to error pages.', sources: [['Ahrefs — HTTP Status Codes', 'https://ahrefs.com/blog/http-status-codes/']] },
  '__deep':           { sev: 'warn', why: 'Pages 4+ clicks from the homepage get crawled less often and receive less PageRank. Surface them via category pages, related-content modules, or footer hub links to flatten depth.', sources: [['Ahrefs — Internal Links', 'https://ahrefs.com/blog/internal-links-for-seo/']] },
  '__hreflang':       { sev: 'info', why: 'Hreflang tells Google which language/region a page targets. Common mistakes that silently break it: invalid lang codes, duplicate x-default, and missing return tags (page A links to B but B doesn\'t link back to A — Google ignores both).', sources: [['Ahrefs — Hreflang Guide', 'https://ahrefs.com/blog/hreflang/'], ['Google — hreflang docs', 'https://developers.google.com/search/docs/specialty/international/localized-versions']] },
};

function sevOf(issue) {
  const l = (issue || '').toLowerCase();
  if (/^missing (title|h1|canonical|meta description)|^http [45]|served over http|^mixed content|^noindex|^canonicalised/.test(l)) return 'error';
  if (/too (long|short)|imgs missing alt|thin content|multiple h1|h1 same as title|missing viewport|no schema|missing open graph|missing og:image|^slow |^url:|trailing slash|^redirect \(|www normalization|http→https/.test(l)) return 'warn';
  return 'info';
}

// Client-side mirror of app.py's _is_third_party_widget_image — used to
// scrub already-cached crawl results so reCAPTCHA / analytics / chat-widget
// images stop polluting any image-related view without forcing a re-crawl.
// Mirrored from seo-tool/static/script.js — keep in sync.
const _THIRD_PARTY_IMG_HOSTS_RE = /(?:^|\.)(gstatic\.com|googletagmanager\.com|google-analytics\.com|googleadservices\.com|doubleclick\.net|hotjar\.com|intercomcdn\.com|intercom\.io|crisp\.chat|cloudflareinsights\.com|tiktok\.com|connect\.facebook\.net|pinimg\.com|pinterest\.com|hs-analytics\.net|hs-scripts\.com)$/i;
const _THIRD_PARTY_IMG_FILE_RE = /(?:\/recaptcha[\/_\-]|recaptcha[_\-](?:black|white|logo)|\/g\.gif$|\/pixel\.gif$|\/spacer\.gif$|\/tracking[_\-]pixel|fbq[_\-]pixel|\/fb-pixel|\/ga-pixel)/i;
function _isThirdPartyWidgetImage(absSrc) {
  if (!absSrc) return false;
  try {
    const u = new URL(absSrc);
    if (_THIRD_PARTY_IMG_HOSTS_RE.test(u.hostname || '')) return true;
  } catch {}
  if (_THIRD_PARTY_IMG_FILE_RE.test(absSrc)) return true;
  return false;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _scCopyIcon(url) {
  const sq = (url||'').replace(/"/g,'&quot;').replace(/'/g,"\\'");
  return `<button type="button" onclick="copyUrl(this,'${sq}')" title="Copy URL" style="background:none;border:none;cursor:pointer;color:var(--text-muted,#94a3b8);padding:3px 5px;vertical-align:middle;line-height:1;border-radius:4px;" onmouseover="this.style.color='var(--accent,#6366f1)';this.style.background='var(--surface2,#f1f5f9)'" onmouseout="this.style.color='var(--text-muted,#94a3b8)';this.style.background='none'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>`;
}
function _scOpenIcon(url) {
  const sh = (url||'').replace(/"/g,'&quot;');
  return `${_scCopyIcon(url)}<a href="${sh}" target="_blank" rel="noopener" title="Open in new tab" style="display:inline-block;color:var(--text-muted,#94a3b8);text-decoration:none;padding:3px 5px;vertical-align:middle;border-radius:4px;" onmouseover="this.style.color='var(--accent,#6366f1)';this.style.background='var(--surface2,#f1f5f9)'" onmouseout="this.style.color='var(--text-muted,#94a3b8)';this.style.background='none'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
}
function _scRefetchIcon(url) {
  const sq = (url||'').replace(/"/g,'&quot;').replace(/'/g,"\\'");
  return `<button type="button" onclick="scRecrawlUrl(this,'${sq}')" title="Re-crawl this URL" style="background:none;border:none;cursor:pointer;color:var(--text-muted,#94a3b8);padding:3px 5px;vertical-align:middle;line-height:1;border-radius:4px;" onmouseover="this.style.color='var(--accent,#6366f1)';this.style.background='var(--surface2,#f1f5f9)'" onmouseout="this.style.color='var(--text-muted,#94a3b8)';this.style.background='none'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5.97"/></svg></button>`;
}

// One-time delegated click on the crawler tbody — clicking anywhere on a
// row (other than a nested link/button) opens the dock for that URL.
let _scRowClickWired = false;
function _scWireRowClick() {
  if (_scRowClickWired) return;
  const tbody = document.getElementById('crawler-tbody');
  if (!tbody) return;
  tbody.addEventListener('click', e => {
    if (e.target.closest('a, button, summary, input, label, .copy-icon')) return;
    const tr = e.target.closest('tr[data-url]');
    if (!tr || !tr.dataset.url) return;
    if (typeof window.openDock === 'function') window.openDock(tr.dataset.url);
  });
  _scRowClickWired = true;
}

function renderRow(d) {
  const tbody = document.getElementById('crawler-tbody');
  if (!_scRowClickWired) _scWireRowClick();
  const tr = document.createElement('tr');
  tr.style.cursor = 'pointer';
  tr.dataset.url = d.url;
  const statusColor = d.status_code >= 400 ? '#ef4444' : d.status_code >= 300 ? '#f59e0b' : '#22c55e';
  // app.py canonicalizes redirect rows so result['url'] is the FINAL URL
  // and result['original_url'] is what we requested. For the URL column
  // we want the user to see the URL they (or an internal link) actually
  // hit — otherwise "URL" and "Redirect To" both show the destination and
  // look identical in the Redirects view.
  const displayUrl = (d.original_url && d.original_url !== d.url) ? d.original_url : d.url;
  const path = displayUrl.replace(/^https?:\/\/[^\/]+/, '') || '/';
  const issues = (d.issues || []).map(i => `<span class="badge ${sevOf(i)}" title="${sevOf(i).toUpperCase()}">${escapeHtml(i)}</span>`).join('');
  const safe = d.url.replace(/"/g, '&quot;').replace(/'/g, "\\'");
  tr.innerHTML = `
    <td data-col="url" title="${escapeHtml(displayUrl)}">
      <span style="display:flex;align-items:center;gap:2px;min-width:0;">
        <span class="url-cell" onclick="openDock('${safe}')" style="flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(path)}</span>
        <span class="cs-cell-actions" style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;">${_scOpenIcon(d.url)}${_scRefetchIcon(d.url)}</span>
      </span>
    </td>
    <td data-col="status" style="color:${statusColor};font-weight:700">${d.status_code}</td>
    ${_scRedirToCell(d)}
    ${_scInlinksCell(d)}
    <td data-col="title" title="${escapeHtml(d.title||'')}">${d.title ? escapeHtml(d.title) : '<em style="color:#ef4444">missing</em>'}</td>
    <td data-col="tlen">${d.title_len || 0}</td>
    <td data-col="meta" title="${escapeHtml(d.meta_description||'')}">${d.meta_description ? escapeHtml(d.meta_description) : '<em style="color:#ef4444">missing</em>'}</td>
    ${_scH1Cells(d)}
    <td data-col="words">${d.word_count || 0}</td>
    <td data-col="speed">${d.response_time || 0}s</td>
    <td data-col="issues">${issues || '<span style="color:#22c55e">OK</span>'}</td>
  `;
  tbody.appendChild(tr);
}

// =============================================================================
// Column resize — drag .th-resize handles to adjust column widths.
// Double-click handle to auto-fit column to content (icons included).
// Widths persist in localStorage.
// =============================================================================
const _SC_COL_KEY = 'sc_crawler_col_widths_v1';
// table-layout:fixed only honours col widths when the table has an explicit
// pixel width. We set table.style.width = sum of visible col widths so
// dragging a handle resizes that column (and the table) without other
// columns expanding to fill content.
// Re-sync on window resize so the cosmetic stretch follows the wrapper.
(function() {
  if (typeof window === 'undefined' || window._scResizeWired) return;
  window._scResizeWired = true;
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { try { _scSyncTableWidth(); } catch {} }, 80);
  });
})();
function _scSyncTableWidth() {
  const tbl = document.getElementById('crawler-table');
  if (!tbl) return;
  const cols = tbl.querySelectorAll('colgroup col');
  // Reset any prior cosmetic stretch — restore each col to its user-saved width.
  // dataset.savedWidth is the source of truth; style.width may carry a stretch.
  cols.forEach(c => {
    if (c.dataset.savedWidth) {
      c.style.width = c.dataset.savedWidth + 'px';
    } else {
      const w = parseInt(c.style.width, 10);
      if (w > 0) c.dataset.savedWidth = String(w);
    }
  });
  const visible = [];
  let sum = 0;
  cols.forEach(c => {
    if (getComputedStyle(c).display === 'none') return;
    const w = parseInt(c.style.width, 10) || 0;
    sum += w;
    visible.push({ col: c, w });
  });
  if (sum <= 0) return;
  const wrap = tbl.parentElement;
  const wrapW = wrap ? wrap.clientWidth : 0;
  if (wrapW > sum + 4 && visible.length > 0) {
    // Stretch last visible col to fill remaining width — cosmetic only.
    const last = visible[visible.length - 1];
    last.col.style.width = (last.w + (wrapW - sum)) + 'px';
    tbl.style.width = wrapW + 'px';
  } else {
    tbl.style.width = sum + 'px';
  }
}
function _scLoadColWidths() {
  try {
    const raw = localStorage.getItem(_SC_COL_KEY);
    if (raw) {
      const widths = JSON.parse(raw);
      document.querySelectorAll('#crawler-table colgroup col').forEach((col, i) => {
        if (typeof widths[i] === 'number' && widths[i] > 20) {
          col.style.width = widths[i] + 'px';
          col.dataset.savedWidth = String(widths[i]);
        }
      });
    }
  } catch {}
  _scSyncTableWidth();
}
function _scSaveColWidths() {
  try {
    const cols = document.querySelectorAll('#crawler-table colgroup col');
    const widths = Array.from(cols).map(c =>
      parseInt(c.dataset.savedWidth, 10) || parseInt(c.style.width, 10) || c.offsetWidth);
    localStorage.setItem(_SC_COL_KEY, JSON.stringify(widths));
  } catch {}
  _scSyncTableWidth();
}
function _scAutoFitColumn(idx) {
  const tbody = document.getElementById('crawler-tbody');
  const thead = document.getElementById('crawler-thead');
  if (!tbody || !thead) return;
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;white-space:nowrap;';
  document.body.appendChild(stage);
  const measure = (sourceCell) => {
    const wrap = document.createElement('div');
    const cs = getComputedStyle(sourceCell);
    wrap.style.cssText = `display:inline-block;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing};padding:${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft};box-sizing:border-box;`;
    wrap.innerHTML = sourceCell.innerHTML;
    wrap.querySelectorAll('*').forEach(el => {
      el.style.overflow = 'visible';
      el.style.textOverflow = 'clip';
      el.style.maxWidth = 'none';
      el.style.width = 'auto';
      el.style.flex = '0 0 auto';
      el.style.minWidth = '0';
    });
    stage.appendChild(wrap);
    const w = wrap.offsetWidth;
    stage.removeChild(wrap);
    return w;
  };
  let max = 0;
  const headerTh = thead.querySelector(`th:nth-child(${idx + 1})`);
  if (headerTh) max = Math.max(max, measure(headerTh));
  tbody.querySelectorAll(`tr td:nth-child(${idx + 1})`).forEach(td => { max = Math.max(max, measure(td)); });
  stage.remove();
  const targetPx = Math.min(1400, Math.max(60, Math.ceil(max) + 14));
  const col = document.querySelectorAll('#crawler-table colgroup col')[idx];
  if (col) col.style.width = targetPx + 'px';
  _scSaveColWidths();
}
function _scInitResizers() {
  const tbl = document.getElementById('crawler-table');
  if (tbl) _initTableResizers(tbl);
}

// Generic resizer wiring — works on any <table> with a <colgroup>, .th-resize
// spans in <thead>, and optionally data-resize-key for localStorage. Lets
// every report panel opt in by emitting class="crawler-grid" + the markup.
// Mirrors seo-tool's helper. Kept identical so future fixes apply to both.
function _initTableResizers(table) {
  if (!table) return;
  const thead = table.querySelector('thead');
  if (!thead || thead.dataset.resizersWired === '1') return;
  thead.dataset.resizersWired = '1';
  const cols = table.querySelectorAll('colgroup col');
  const key = table.dataset.resizeKey || '';
  const lsKey = key ? 'sc_table_col_widths_' + key : '';

  // Restore saved widths. Clamp the first column (always URL/identifier in
  // these reports) to a 220px floor so a stale localStorage entry from a
  // prior accidental over-drag doesn't leave the URL column unreadable.
  if (lsKey) {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        const widths = JSON.parse(raw);
        cols.forEach((col, i) => {
          if (typeof widths[i] !== 'number' || widths[i] <= 20) return;
          const minW = (i === 0) ? 220 : 40;
          col.style.width = Math.max(widths[i], minW) + 'px';
        });
      }
    } catch {}
  }
  if (table.id === 'crawler-table') _scLoadColWidths();

  const save = () => {
    if (table.id === 'crawler-table') { _scSaveColWidths(); return; }
    if (!lsKey) return;
    try {
      const widths = Array.from(cols).map(c => parseInt(c.style.width, 10) || c.offsetWidth);
      localStorage.setItem(lsKey, JSON.stringify(widths));
    } catch {}
  };

  thead.querySelectorAll('.th-resize').forEach(handle => {
    const idx = parseInt(handle.dataset.colIdx, 10);
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (table.id === 'crawler-table') _scAutoFitColumn(idx);
    });
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const col = cols[idx];
      if (!col) return;
      const startX = e.clientX;
      const startWidth = parseInt(col.style.width, 10) || col.offsetWidth;
      handle.classList.add('is-dragging');
      document.body.classList.add('is-col-resizing');
      const onMove = (ev) => {
        const maxW = Math.max(1200, (window.innerWidth || 4000) - 60);
        const w = Math.max(40, Math.min(maxW, startWidth + (ev.clientX - startX)));
        col.style.width = w + 'px';
        if (table.id === 'crawler-table') {
          col.dataset.savedWidth = String(w);
          _scSyncTableWidth();
        }
      };
      const onUp = () => {
        handle.classList.remove('is-dragging');
        document.body.classList.remove('is-col-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        save();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// Helpers for building resizable crawler-grid tables. Call _scWireNestedGrids
// on any container after mounting a panel — it scans for nested resizable
// tables and wires them automatically.
function _scEscapeHtml(s) {
  if (s == null) return '';
  if (typeof s !== 'string') {
    try { s = Array.isArray(s) ? s.join(', ') : String(s); } catch { return ''; }
  }
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _scGridColgroup(cols) {
  return `<colgroup>${cols.map(c => c.width ? `<col style="width:${c.width}px">` : '<col>').join('')}</colgroup>`;
}
function _scGridHead(cols) {
  return `<thead><tr>${cols.map((c, i) =>
    `<th style="position:relative;${c.alignRight ? 'text-align:right;' : ''}">
      <span class="th-label${c.center ? ' th-center' : ''}">${_scEscapeHtml(c.label || '')}</span>
      <span class="th-resize" data-col-idx="${i}"></span>
    </th>`
  ).join('')}</tr></thead>`;
}
function _scGridTable(key, cols, rowsHtml, extraStyle) {
  return `<table class="crawler-grid" data-resize-key="${key}"${extraStyle ? ` style="${extraStyle}"` : ''}>
    ${_scGridColgroup(cols)}
    ${_scGridHead(cols)}
    <tbody>${rowsHtml}</tbody>
  </table>`;
}
function _scWireNestedGrids(container) {
  if (!container) return;
  container.querySelectorAll('table.crawler-grid[data-resize-key]').forEach(t => _initTableResizers(t));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _scInitResizers);
  else _scInitResizers();
}

window.copyUrl = function(btn, url) {
  const done = () => { const t = btn.innerHTML; btn.innerHTML = '✓'; btn.style.color = '#22c55e'; setTimeout(() => { btn.innerHTML = t; btn.style.color = ''; }, 1000); };
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => {});
  else { const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch {} document.body.removeChild(ta); }
};

// =============================================================================
// Detail drawer — click a URL to open a bottom panel with page details,
// issue breakdown, inlinks (pages pointing here), and outlinks (pages this
// one points to).
// =============================================================================
window.openDock = function(url) {
  if (!url) return;
  dockUrl = url;
  document.getElementById('crawler-dock').hidden = false;
  renderDock();
};
window.closeDock = function() {
  dockUrl = null;
  document.getElementById('crawler-dock').hidden = true;
};
window.dockSwitchTab = function(tab) {
  document.querySelectorAll('.dock-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.dock-pane').forEach(p => p.style.display = p.dataset.tab === tab ? '' : 'none');
};

function renderDock() {
  if (!dockUrl) return;
  const page = crawlerResults.find(r => r.url === dockUrl) || {};
  const inlinks = _scLookupInlinks(dockUrl);
  const outs = page.internal_link_urls || [];
  const urlEl = document.getElementById('dock-url');
  const inCount = document.getElementById('dock-in-count');
  const outCount = document.getElementById('dock-out-count');
  if (urlEl) { urlEl.textContent = dockUrl; urlEl.title = dockUrl; }
  if (inCount) inCount.textContent = inlinks.length;
  if (outCount) outCount.textContent = outs.length;

  // Details pane
  const statusColor = page.status_code >= 400 ? '#ef4444' : page.status_code >= 300 ? '#f59e0b' : '#22c55e';
  const sec = page.security || {};
  const og = page.og_tags || {};
  const secBadge = (label, on) => `<span class="badge ${on?'info':'error'}" style="opacity:${on?1:.6}">${on?'✓':'✗'} ${label}</span>`;
  document.getElementById('dock-pane-details').innerHTML = `
    <dl class="kv">
      <dt>Status</dt><dd style="color:${statusColor};font-weight:700">${page.status_code || '—'}</dd>
      <dt>Title</dt><dd>${page.title ? escapeHtml(page.title) : '<em>missing</em>'} <span style="color:var(--text-muted)">(${page.title_len || 0} chars)</span></dd>
      <dt>Meta description</dt><dd>${page.meta_description ? escapeHtml(page.meta_description) : '<em>missing</em>'} <span style="color:var(--text-muted)">(${page.meta_len || 0} chars)</span></dd>
      <dt>H1${(page.h1_list || []).length > 1 ? ` <span style="color:#ef4444">×${page.h1_list.length}</span>` : ''}</dt><dd>${page.h1 ? escapeHtml(page.h1) : '<em>missing</em>'}</dd>
      <dt>H2 count</dt><dd>${page.h2_count || 0}</dd>
      <dt>Word count</dt><dd>${page.word_count || 0}</dd>
      <dt>Canonical</dt><dd>${page.canonical ? escapeHtml(page.canonical) : '<em>none</em>'} ${page.canonical_kind === 'self' ? '<span class="badge info">self</span>' : page.canonical_kind === 'canonicalised' ? '<span class="badge warn">points elsewhere</span>' : ''}</dd>
      <dt>Response time</dt><dd>${page.response_time || 0}s</dd>
      <dt>Depth</dt><dd>${page.depth || 0}</dd>
      <dt>Indexable</dt><dd>${page.indexable ? '<span class="badge info">yes</span>' : '<span class="badge error">no</span>'}</dd>
      ${page.redirect_url ? `<dt>Redirects to</dt><dd>${escapeHtml(page.redirect_url)} <span style="color:var(--text-muted)">(${page.redirect_hops || 1} hop${(page.redirect_hops||1)>1?'s':''})</span></dd>` : ''}
      ${(page.redirect_chain && page.redirect_chain.length) ? `<dt>Redirect chain</dt><dd>
        <ol style="margin:0;padding-left:18px;list-style:decimal;">
          ${page.redirect_chain.map((h, i) => {
            const isLast = i === page.redirect_chain.length - 1;
            const sc = h.status || 0;
            const scCol = sc >= 400 ? '#ef4444' : sc >= 300 ? '#f59e0b' : '#22c55e';
            return `<li style="margin:2px 0;font-size:12px;line-height:1.4;">
              <a href="${escapeHtml(h.url)}" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all;">${escapeHtml(h.url)}</a>
              <span style="color:${scCol};font-weight:700;margin-left:4px;">${sc}</span>${isLast ? ' <span style="color:var(--text-muted);font-size:10px;">final</span>' : ''}
            </li>`;
          }).join('')}
        </ol>
      </dd>` : ''}
      <dt>Images</dt><dd>${page.images_no_alt || 0}/${page.images_total || 0} missing alt</dd>
      <dt>Schema</dt><dd>${(page.schema_types || []).length ? page.schema_types.map(escapeHtml).join(', ') : '<em>none</em>'}</dd>
      <dt>OG tags</dt><dd>${og.title ? '<span class="badge info">title</span>' : '<span class="badge error">no title</span>'} ${og.image ? '<span class="badge info">image</span>' : '<span class="badge error">no image</span>'} ${og.description ? '<span class="badge info">desc</span>' : '<span class="badge error">no desc</span>'}</dd>
      <dt>Security</dt><dd>${secBadge('HTTPS', sec.is_https)} ${secBadge('HSTS', sec.hsts)} ${secBadge('CSP', sec.csp)} ${secBadge('XFO', sec.x_frame_options)}</dd>
    </dl>`;

  // Issues pane
  const issues = page.issues || [];
  document.getElementById('dock-pane-issues').innerHTML = issues.length
    ? issues.map(i => `<div class="issue-row"><span class="badge ${sevOf(i)}">${sevOf(i).toUpperCase()}</span> ${escapeHtml(i)}</div>`).join('')
    : '<div class="empty">✓ No issues detected on this page.</div>';

  // Inlinks pane
  document.getElementById('dock-pane-inlinks').innerHTML = inlinks.length
    ? inlinks.map(e => {
        const src = typeof e === 'string' ? e : e.source;
        const anchor = typeof e === 'string' ? '' : (e.anchor || '');
        const placement = typeof e === 'string' ? '' : (e.placement || '');
        const p = src.replace(/^https?:\/\/[^\/]+/, '') || '/';
        return `<div class="link-row">
          <a href="${escapeHtml(src)}" target="_blank" rel="noopener">${escapeHtml(p)}</a>
          <button class="copy-icon" onclick="copyUrl(this,'${src.replace(/'/g,"\\'")}')">⧉</button>
          ${anchor ? `<span class="anchor">"${escapeHtml(anchor.slice(0,60))}${anchor.length > 60 ? '…' : ''}"</span>` : ''}
          ${placement ? `<span class="placement">${escapeHtml(placement)}</span>` : ''}
        </div>`;
      }).join('')
    : '<div class="empty">No inbound links discovered yet.</div>';

  // Outlinks pane
  document.getElementById('dock-pane-outlinks').innerHTML = outs.length
    ? outs.map(e => {
        const target = Array.isArray(e) ? e[0] : e;
        const anchor = Array.isArray(e) ? (e[1] || '') : '';
        const p = target.replace(/^https?:\/\/[^\/]+/, '') || '/';
        return `<div class="link-row">
          <a href="${escapeHtml(target)}" target="_blank" rel="noopener">${escapeHtml(p)}</a>
          <button class="copy-icon" onclick="copyUrl(this,'${target.replace(/'/g,"\\'")}')">⧉</button>
          ${anchor ? `<span class="anchor">"${escapeHtml(anchor.slice(0,60))}${anchor.length > 60 ? '…' : ''}"</span>` : ''}
        </div>`;
      }).join('')
    : '<div class="empty">No outbound links recorded.</div>';
}

// =============================================================================
// CMS banner
// =============================================================================
function renderCmsBanner(info) {
  const host = document.getElementById('crawler-cms-banner');
  host.innerHTML = '';
  if (!info || !info.cms) return;
  const prof = info.profile || {};
  const tipsHtml = (prof.tips || []).length ? `<ul style="margin:4px 0 0 18px;font-size:11px;color:var(--text-muted)">${prof.tips.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : '';
  const warnsHtml = (prof.schema_warnings || []).length ? `<div style="margin-top:6px;font-size:11px;color:#f59e0b">Schema notes: <ul style="margin:2px 0 0 18px;color:var(--text-muted)">${prof.schema_warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : '';
  const applyBtn = (prof.exclude_patterns || []).length || Object.keys(prof.suggested_settings || {}).length ? `<button onclick="applyCmsRecs()">Apply recommendations</button>` : '';
  host.innerHTML = `
    <div class="cms-banner">
      <strong>Detected: ${escapeHtml(info.label)}</strong>
      <span style="color:var(--text-muted);font-size:11px">(${info.confidence} confidence — ${(info.signals || []).slice(0, 2).map(escapeHtml).join(' · ')})</span>
      ${applyBtn}
      <button onclick="document.getElementById('crawler-cms-banner').innerHTML=''" style="background:transparent;color:var(--text-muted);border:1px solid var(--border)" title="Dismiss">✕</button>
      ${tipsHtml}
      ${warnsHtml}
    </div>`;
  window._cmsInfo = info;
}

window.applyCmsRecs = function() {
  const info = window._cmsInfo;
  if (!info || !info.profile) return;
  const p = info.profile;
  const exEl = document.getElementById('crawler-exclude');
  if (exEl && (p.exclude_patterns || []).length) {
    const existing = new Set(exEl.value.split('\n').map(l => l.trim()).filter(Boolean));
    const merged = [...existing];
    for (const x of p.exclude_patterns) if (!existing.has(x)) merged.push(x);
    exEl.value = merged.join('\n');
    const det = exEl.closest('details'); if (det) det.open = true;
  }
  const s = p.suggested_settings || {};
  if (typeof s.max_workers === 'number') {
    const w = document.getElementById('crawler-workers');
    w.value = s.max_workers; document.getElementById('crawler-workers-label').textContent = s.max_workers;
  }
  if (s.render_js === true) document.getElementById('crawler-render-js').checked = true;
  document.getElementById('crawler-cms-banner').innerHTML = '';
};

// =============================================================================
// Crawl driver
// =============================================================================
// Sticks across crawl finishes so the error banner can offer a Resume option
// targeting the suspended state on the server.
let crawlerLastCrawlId = null;

function startCrawl(opts) {
  opts = opts || {};
  const resumeFromId = opts.resumeFromId || null;
  const url = document.getElementById('crawler-url').value.trim();
  if (!url) { document.getElementById('crawler-url').focus(); return; }

  crawlerAbort = new AbortController();
  markBusy('site-crawler', resumeFromId ? `Resuming crawl of ${url}` : `Crawling ${url}`);
  crawlerStart = Date.now();
  if (!resumeFromId) {
    crawlerResults = [];
    crawlerInlinks = {};
    // Reset sitemap analysis from a previous crawl + hide its sidebar entries.
    if (typeof crawlerSitemap !== 'undefined') crawlerSitemap = null;
    window.sitemapAnalysisSkipped = false;
    // Close the bottom dock if it was left open on a URL from the previous
    // crawl — otherwise it shows stale inlinks for a URL on a different host.
    if (typeof window.closeDock === 'function') window.closeDock();
  }
  if (typeof crawlerDismissErrorBanner === 'function') crawlerDismissErrorBanner();
  if (!resumeFromId) {
    const _smStatus = document.getElementById('sitemap-status');
    if (_smStatus) { _smStatus.style.display = 'none'; _smStatus.innerHTML = ''; }
    ['sm-cat-missing','sm-cat-orphan','sm-cat-only','sm-cat-noindex','sm-cat-non200','sm-cat-redirects','sm-cat-pagination'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; const cnt = el.querySelector('.ci-count'); if (cnt) cnt.textContent = '0'; }
    });
    const _smPanel = document.getElementById('sitemap-panel');
    if (_smPanel) _smPanel.remove();
    activeCategory = 'all';
  }

  document.getElementById('crawler-start-btn').style.display = 'none';
  document.getElementById('crawler-stop-btn').style.display = '';
  document.getElementById('crawler-stats').style.display = 'grid';
  document.getElementById('crawler-empty').style.display = 'none';
  document.getElementById('crawler-results').style.display = '';
  document.getElementById('issues-sidebar').style.display = '';
  { const _smBtn = document.getElementById('crawler-export-sitemap-btn'); if (_smBtn) _smBtn.style.display = 'none'; }
  { const _xBtn = document.getElementById('crawler-export-xlsx-btn'); if (_xBtn) _xBtn.style.display = 'none'; }
  { const _vBtn = document.getElementById('crawler-export-view-btn'); if (_vBtn) _vBtn.style.display = 'none'; }
  if (!resumeFromId) {
    document.getElementById('crawler-tbody').innerHTML = '';
    document.getElementById('crawler-cms-banner').innerHTML = '';
    document.getElementById('issue-info-box').style.display = 'none';
    document.getElementById('issue-info-box').innerHTML = '';
    document.getElementById('detail-title-text').textContent = 'All Pages';
    document.getElementById('cs-crawled').textContent = '0';
    document.getElementById('cs-queued').textContent = '0';
    document.getElementById('cs-errors').textContent = '0';
    // Reset active pill highlights
    document.querySelectorAll('.ci-cat').forEach(el => el.classList.toggle('active', el.dataset.cat === 'all'));
    document.querySelectorAll('.sev-cell').forEach(el => el.classList.remove('active'));
    updateCounts();
    closeDock();
  }

  crawlerTimer = setInterval(() => {
    const s = Math.floor((Date.now() - crawlerStart) / 1000);
    document.getElementById('cs-elapsed').textContent = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }, 1000);

  const reqBody = {
    url,
    max_pages: parseInt(document.getElementById('crawler-max').value) || 500,
    max_workers: parseInt(document.getElementById('crawler-workers').value) || 5,
    crawl_delay: parseFloat(document.getElementById('crawler-speed').value),
    max_depth: parseInt(document.getElementById('crawler-depth').value) || 10,
    render_js: document.getElementById('crawler-render-js').checked,
    compare_no_js: document.getElementById('crawler-render-js').checked && (document.getElementById('crawler-compare-no-js')?.checked || false),
    ignore_robots: document.getElementById('crawler-ignore-robots').checked,
    ignore_noindex: document.getElementById('crawler-ignore-noindex').checked,
    include_patterns: document.getElementById('crawler-include').value.trim(),
    exclude_patterns: document.getElementById('crawler-exclude').value.trim(),
  };
  if (resumeFromId) reqBody.resume_crawl_id = resumeFromId;

  fetch('/crawl', {
    method: 'POST',
    signal: crawlerAbort.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody)
  }).then(r => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) { crawlFinished(); return; }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') { crawlFinished(); return; }
          try {
            const p = JSON.parse(data);
            if (p.type === 'page') {
              crawlerResults.push(p.data);
              if (matchesCategory(p.data, activeCategory)) renderRow(p.data);
              // Build inlinks map client-side
              const src = p.data.url;
              for (const entry of (p.data.internal_link_urls || [])) {
                const target = Array.isArray(entry) ? entry[0] : entry;
                const anchor = Array.isArray(entry) ? (entry[1] || '') : '';
                const placement = Array.isArray(entry) ? (entry[2] || '') : '';
                if (!target) continue;
                const bucket = crawlerInlinks[target] || (crawlerInlinks[target] = []);
                if (!bucket.some(e => e.source === src && e.anchor === anchor)) {
                  bucket.push({ source: src, anchor, placement });
                }
              }
              document.getElementById('cs-crawled').textContent = p.crawled;
              document.getElementById('cs-queued').textContent = p.queued;
              document.getElementById('cs-errors').textContent = p.errors;
              if (p.queue_sample !== undefined) {
                crawlerUpdateQueuePanel(p.queue_sample, p.queued);
              }
              updateCounts();
              // Refresh dock if the open URL got fresh data (new inlinks or its own page row)
              if (dockUrl && (dockUrl === src || (p.data.internal_link_urls || []).some(e => (Array.isArray(e) ? e[0] : e) === dockUrl))) {
                renderDock();
              }
              // Live-refresh the Site Structure sunburst as new URLs arrive.
              // Throttled internally so we don't re-render on every page event.
              if (typeof window._maybeRefreshSiteStructure === 'function') {
                window._maybeRefreshSiteStructure();
              }
            } else if (p.type === 'cms_detected') {
              // CMS-recommendations banner removed — see live robots.txt
              // preview in the URL filters panel instead.
            } else if (p.type === 'start') {
              crawlerCrawlId = p.crawl_id || null;
              if (crawlerCrawlId) crawlerLastCrawlId = crawlerCrawlId;
              const applyBtn = document.getElementById('crawler-apply-rules');
              if (applyBtn) applyBtn.disabled = !crawlerCrawlId;
            } else if (p.type === 'resumed') {
              showToast(`Resumed — picking up ${p.previous_pages} pages, ${p.queued} URLs still in queue`, 'info');
            } else if (p.type === 'limit_reached') {
              crawlerShowLimitBanner(p.fetched, p.queued, p.current_max);
              crawlerUpdateQueuePanel(p.queue_sample, p.queued);
            } else if (p.type === 'crawl_resumed') {
              crawlerHideLimitBanner();
              showToast(`Crawl resumed — page cap raised to ${p.new_max}`, 'info');
            } else if (p.type === 'complete') {
              crawlerLastCrawlId = null;  // crawl finished naturally
              // Server-computed reports (duplicates, redirect chains, response
              // codes, orphans, depth distribution) — needed by Bulk Reports
              // panels. Falls back to client-side computation on saved-crawl
              // loads where this event never fires.
              if (p.reports && typeof p.reports === 'object') {
                window.crawlerReports = p.reports;
              }
            }
          } catch {}
        }
        return pump();
      });
    }
    return pump();
  }).catch(e => {
    if (e.name !== 'AbortError') {
      console.error(e);
      crawlerShowErrorBanner(e && e.message || 'Unknown error', url);
    }
    crawlFinished();
  });
}

function crawlerShowErrorBanner(reason, url) {
  const banner = document.getElementById('crawler-error-banner');
  const msg = document.getElementById('crawler-error-banner-msg');
  if (!banner || !msg) return;
  msg.textContent = reason || 'Unknown error';
  if (url) banner.dataset.failedUrl = url;
  banner.style.display = 'flex';
  const empty = document.getElementById('crawler-empty');
  const results = document.getElementById('crawler-results');
  if (empty)   empty.style.display = 'none';
  if (results) results.style.display = '';
}

function crawlerDismissErrorBanner() {
  const banner = document.getElementById('crawler-error-banner');
  if (banner) { banner.style.display = 'none'; banner.removeAttribute('data-failed-url'); }
}

window.crawlerDismissErrorBanner = crawlerDismissErrorBanner;
window.crawlerShowErrorBanner = crawlerShowErrorBanner;
window.crawlerRetryFromBanner = function() {
  const banner = document.getElementById('crawler-error-banner');
  const url = banner && banner.dataset.failedUrl;
  crawlerDismissErrorBanner();
  if (url) {
    const inp = document.getElementById('crawler-url');
    if (inp) inp.value = url;
  }
  if (typeof startCrawl === 'function') startCrawl();
};

// Lightweight toast — site-crawler doesn't ship a toast system, so use a
// transient overlay div. Stacks if multiple fire close together.
function showToast(message, kind) {
  const stack = document.getElementById('sc-toast-stack') || (() => {
    const s = document.createElement('div');
    s.id = 'sc-toast-stack';
    s.style.cssText = 'position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:10000;pointer-events:none;';
    document.body.appendChild(s);
    return s;
  })();
  const t = document.createElement('div');
  const bg = kind === 'error' ? '#dc2626' : kind === 'warn' ? '#f59e0b' : '#0ea5e9';
  t.style.cssText = `background:${bg};color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500;max-width:380px;box-shadow:0 4px 12px rgba(0,0,0,0.15);pointer-events:auto;`;
  t.textContent = message;
  stack.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
}

function crawlerShowLimitBanner(fetched, queued, currentMax) {
  const banner = document.getElementById('crawler-limit-banner');
  const msg = document.getElementById('crawler-limit-banner-msg');
  if (!banner || !msg) return;
  msg.textContent = `Crawled ${fetched} of ${currentMax} cap — ${queued} URL${queued === 1 ? '' : 's'} still queued. Bump the cap to keep going, or finalize with what we have.`;
  banner.style.display = 'flex';
  const empty = document.getElementById('crawler-empty');
  const results = document.getElementById('crawler-results');
  if (empty)   empty.style.display = 'none';
  if (results) results.style.display = '';
  ['crawler-limit-continue-btn','crawler-limit-continue-1k-btn','crawler-limit-finalize-btn']
    .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; });
}

function crawlerHideLimitBanner() {
  const banner = document.getElementById('crawler-limit-banner');
  if (banner) banner.style.display = 'none';
}

function crawlerContinueCrawl(bump) {
  if (!crawlerCrawlId) return;
  ['crawler-limit-continue-btn','crawler-limit-continue-1k-btn','crawler-limit-finalize-btn']
    .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
  fetch('/crawl/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crawl_id: crawlerCrawlId, action: 'continue', bump: bump || 500 }),
  }).catch(err => {
    showToast('Could not resume crawl: ' + err.message, 'error');
    ['crawler-limit-continue-btn','crawler-limit-continue-1k-btn','crawler-limit-finalize-btn']
      .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; });
  });
}

function crawlerFinalizeCrawl() {
  if (!crawlerCrawlId) return;
  ['crawler-limit-continue-btn','crawler-limit-continue-1k-btn','crawler-limit-finalize-btn']
    .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
  fetch('/crawl/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crawl_id: crawlerCrawlId, action: 'finalize' }),
  }).then(() => {
    crawlerHideLimitBanner();
  }).catch(err => {
    showToast('Could not finalize crawl: ' + err.message, 'error');
  });
}

function crawlerUpdateQueuePanel(sample, totalCount) {
  const panel = document.getElementById('crawler-queue-panel');
  const body = document.getElementById('crawler-queue-body');
  const countEl = document.getElementById('crawler-queue-count');
  const pluralEl = document.getElementById('crawler-queue-plural');
  if (!panel || !body || !countEl) return;
  const count = typeof totalCount === 'number' ? totalCount : (sample || []).length;
  if (count <= 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  countEl.textContent = count;
  if (pluralEl) pluralEl.textContent = count === 1 ? '' : 's';
  panel._lastSample = { sample: sample || [], count: count };
  if (body.style.display === 'none') return;
  const list = sample || [];
  const truncated = count > list.length;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  let html = '';
  for (const url of list) {
    const safe = escapeHtml(url);
    html += `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
      <button onclick="crawlerExcludeFromQueue('${safe.replace(/'/g, "\\'")}')" title="Exclude this URL from the rest of the crawl" style="flex-shrink:0;background:none;border:none;color:#dc2626;cursor:pointer;font-size:13px;line-height:1;padding:0 4px;font-weight:700;">✕</button>
      <span style="color:#0f172a;word-break:break-all;">${safe}</span>
    </div>`;
  }
  if (truncated) {
    html += `<div style="padding:6px 0 0 0;color:#64748b;font-style:italic;">…and ${count - list.length} more not shown</div>`;
  }
  body.innerHTML = html;
}

function crawlerToggleQueuePanel() {
  const body = document.getElementById('crawler-queue-body');
  const chev = document.getElementById('crawler-queue-chevron');
  if (!body) return;
  const opening = body.style.display === 'none';
  body.style.display = opening ? 'block' : 'none';
  if (chev) chev.style.transform = opening ? 'rotate(90deg)' : 'rotate(0deg)';
  if (opening) {
    const panel = document.getElementById('crawler-queue-panel');
    const cached = panel && panel._lastSample;
    if (cached) crawlerUpdateQueuePanel(cached.sample, cached.count);
  }
}

function crawlerExcludeFromQueue(url) {
  if (!url || !crawlerCrawlId) return;
  const excludeBox = document.getElementById('crawler-exclude');
  if (!excludeBox) return;
  const existing = excludeBox.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (existing.includes(url)) {
    showToast('Already in exclude list', 'info');
    return;
  }
  existing.push(url);
  excludeBox.value = existing.join('\n');
  if (typeof applyCrawlRules === 'function') {
    applyCrawlRules();
  } else {
    const includePatterns = (document.getElementById('crawler-include')?.value || '').trim();
    fetch('/crawl/update-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crawl_id: crawlerCrawlId, include_patterns: includePatterns, exclude_patterns: excludeBox.value })
    });
  }
  showToast(`Excluded: ${url}`, 'info');
}

function crawlerHideQueuePanel() {
  const panel = document.getElementById('crawler-queue-panel');
  const body = document.getElementById('crawler-queue-body');
  if (panel) {
    panel.style.display = 'none';
    panel._lastSample = null;
  }
  if (body) body.innerHTML = '';
}

function crawlerShowAllCrawled() {
  if (typeof selectCategory === 'function') selectCategory('all');
  const empty = document.getElementById('crawler-empty');
  const results = document.getElementById('crawler-results');
  if (empty) empty.style.display = 'none';
  if (results) results.style.display = '';
  const table = document.getElementById('crawler-table');
  if (table && table.scrollIntoView) table.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function crawlerShowQueue() {
  const panel = document.getElementById('crawler-queue-panel');
  const body = document.getElementById('crawler-queue-body');
  if (!panel || panel.style.display === 'none') {
    showToast('Queue is empty — nothing waiting to crawl.', 'info');
    return;
  }
  if (body && body.style.display === 'none') crawlerToggleQueuePanel();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

window.crawlerToggleQueuePanel = crawlerToggleQueuePanel;
window.crawlerExcludeFromQueue = crawlerExcludeFromQueue;
window.crawlerContinueCrawl = crawlerContinueCrawl;
window.crawlerFinalizeCrawl = crawlerFinalizeCrawl;
window.crawlerShowAllCrawled = crawlerShowAllCrawled;
window.crawlerShowQueue = crawlerShowQueue;

// =============================================================================
// Issue category selection + per-category counts
// =============================================================================
function matchesCategory(page, cat) {
  if (cat === 'all') return true;
  const issues = page.issues || [];
  const sev = (i) => {
    const l = i.toLowerCase();
    if (/^missing (title|h1|canonical|meta description)|^http [45]|served over http|^mixed content|^noindex|^canonicalised/.test(l)) return 'error';
    if (/too (long|short)|imgs missing alt|images missing alt|thin content|multiple h1|h1 same as title|h1 identical|missing viewport|no schema|missing open graph|missing og:image|^slow |^url:|trailing slash|^redirect \(|www normalization|http→https/.test(l)) return 'warn';
    return 'info';
  };
  // Severity filters are inclusive: a page with any issue at that severity
  // appears in that filter. A page with both errors and warnings appears in
  // BOTH the Errors and Warnings filters — that matches Screaming Frog and
  // what users expect when they want to see "all pages with warnings".
  if (cat === '__err') return issues.some(i => sev(i) === 'error');
  if (cat === '__warn') return issues.some(i => sev(i) === 'warn');
  if (cat === '__info') return issues.some(i => sev(i) === 'info');
  if (cat === 'HTTP') return (page.status_code >= 400 && page.status_code < 600);
  if (cat === 'Redirect') return !!page.redirect_url;
  if (cat === 'noindex') return issues.some(i => i.toLowerCase() === 'noindex' || i.toLowerCase().startsWith('page set to noindex'));
  if (cat === 'Canonicalised') return issues.some(i => i.toLowerCase().startsWith('canonicalised'));
  // Default: substring match against concatenated issues
  const joined = issues.join(' ').toLowerCase();
  return joined.includes(cat.toLowerCase());
}

window.selectCategory = function(cat) {
  activeCategory = cat;
  document.querySelectorAll('.ci-cat').forEach(el => el.classList.toggle('active', el.dataset.cat === cat));
  document.querySelectorAll('.sev-cell').forEach(el => el.classList.toggle('active', el.dataset.cat === cat));

  // Update title
  const titleMap = {
    'all': 'All Pages', '__err': 'Pages with Errors (must fix)', '__warn': 'Pages with Warnings (should fix)', '__info': 'Pages with Info Issues',
    'Missing meta description': 'Pages Missing Meta Description', 'Meta desc too long': 'Meta Description Too Long', 'Meta desc too short': 'Meta Description Too Short',
    'Missing title': 'Pages Missing Title', 'Title too long': 'Title Too Long', 'Title too short': 'Title Too Short',
    'Missing H1': 'Pages Missing H1', 'Multiple H1s': 'Pages with Multiple H1s', 'H1 identical to title tag': 'H1 Same as Title',
    'Missing canonical': 'Pages Missing Canonical', 'Canonicalised': 'Canonicalised Pages',
    'images missing alt': 'Pages with Images Missing Alt Text', 'No schema': 'Pages Without Schema Markup',
    'Thin content': 'Pages with Thin Content', 'Slow': 'Slow Pages (>3s)', 'Redirect': 'Redirected Pages',
    'HTTP': 'HTTP Errors (4xx / 5xx)', 'noindex': 'Noindex Pages',
    'Missing Open Graph': 'Pages Missing Open Graph Tags', 'Missing og:image': 'Pages Missing og:image',
    'Missing Twitter Card': 'Pages Missing Twitter Card', 'Missing viewport': 'Pages Missing Viewport Meta',
    'Mixed content': 'HTTPS Pages Loading HTTP Resources', 'URL:': 'URL Hygiene Issues',
    '__sm_missing': 'Missing from Sitemap', '__sm_orphan': 'Orphan in Sitemap',
    '__sm_only': 'Orphan Pages — No Internal Links', '__sm_noindex': 'Non-Indexable in Sitemap',
    '__sm_non200': 'Non-200 in Sitemap', '__sm_redirects': 'Redirects in Sitemap',
    '__sm_pagination': 'Pagination in Sitemap',
    '__nd_content': 'Near-Duplicate Content — pairs above the similarity threshold',
    '__schema_by_page': 'Schema by Page — every crawled page with the schema types it emits',
    '__sitemap_viz': 'Site Structure — sunburst, hierarchy and anchor-text cloud',
    '__all_images': 'All Images — every image across the crawl with alt text and the page(s) it appears on',
    '__external_links': 'External Links — every off-domain link with rel/target attributes. Filter by follow / nofollow / same-window. Risky = follow + same-window (leaks link equity AND loses the visitor).',
    '__js_diff': 'JS vs non-JS Diff — pages whose content differs between rendered and raw HTML',
    '__all_titles':    'All Titles — every crawled page with its title tag',
    '__all_metas':     'All Meta Descriptions — every crawled page with its meta description',
    '__all_h1s':       'All H1s — every crawled page with its primary H1',
    '__all_canonicals':'All Canonicals — every crawled page with its rel=canonical target',
    '__dup_titles':    'Duplicate Titles — groups of pages sharing a title',
    '__dup_metas':     'Duplicate Meta Descriptions — groups of pages sharing a meta description',
    '__dup_h1s':       'Duplicate H1s — groups of pages sharing an H1',
    '__dup_bodies':    'Duplicate Body Content — groups of pages with identical body hash',
    '__redir_chains':  'Redirect Chains (2+ hops)',
    '__response_codes':'Response Code Distribution',
    '__deep':          'Deep Pages (4+ clicks from home)',
    '__hreflang':      'Hreflang Implementation',
  };
  document.getElementById('detail-title-text').textContent = titleMap[cat] || cat;

  // Report-style categories (sitemap analysis, schema-by-page) render
  // their own panel. Hide the entire table-wrap (not just the table)
  // because the wrap has flex:1 and would keep the empty layout space.
  // Also hide the "double-click to expand" hint — doesn't apply.
  const _tableWrap = document.querySelector('.table-wrap');
  const _expandHint = document.querySelector('.cs-expand-hint');
  const _isReportPanel = (typeof cat === 'string') &&
    (cat.startsWith('__sm_') || cat === '__schema_by_page' || cat === '__nd_content' || cat === '__sitemap_viz' || cat === '__all_images' || cat === '__external_links' || cat === '__js_diff' || cat === '__all_titles' || cat === '__all_metas' || cat === '__all_h1s' || cat === '__all_canonicals' || cat === '__dup_titles' || cat === '__dup_metas' || cat === '__dup_h1s' || cat === '__dup_bodies' || cat === '__redir_chains' || cat === '__response_codes' || cat === '__deep' || cat === '__hreflang');
  if (_isReportPanel) {
    renderIssueInfo(cat);
    const tbody = document.getElementById('crawler-tbody');
    tbody.innerHTML = '';
    _scApplyMultiH1Columns(0);
    if (_tableWrap) _tableWrap.style.display = 'none';
    if (_expandHint) _expandHint.style.display = 'none';
    // Strip any previously-rendered special panel so we don't stack them.
    // Each renderer removes only its own ID; switching between special tabs
    // without this would leave stale Schema/Images/etc. panels in the DOM.
    ['sitemap-panel','schema-by-page-panel','near-dup-panel','sitestructure-panel',
     'all-images-panel','external-links-panel','js-diff-panel',
     'all-values-panel','duplicates-panel',
     'redir-chains-panel','response-codes-panel','deep-pages-panel','hreflang-panel']
      .forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
    if (cat === '__schema_by_page') {
      _renderSchemaByPagePanel();
    } else if (cat === '__nd_content') {
      _renderNearDupPanel();
    } else if (cat === '__sitemap_viz') {
      _scRenderSiteStructurePanel();
    } else if (cat === '__all_images') {
      _scRenderAllImagesPanel();
    } else if (cat === '__external_links') {
      _scRenderExternalLinksPanel();
    } else if (cat === '__js_diff') {
      _scRenderJsDiffPanel();
    } else if (cat === '__all_titles' || cat === '__all_metas' || cat === '__all_h1s' || cat === '__all_canonicals') {
      _scRenderAllValuesPanel(cat);
    } else if (cat === '__dup_titles' || cat === '__dup_metas' || cat === '__dup_h1s' || cat === '__dup_bodies') {
      _scRenderDuplicatesPanel(cat);
    } else if (cat === '__redir_chains') {
      _scRenderRedirChainsPanel();
    } else if (cat === '__response_codes') {
      _scRenderResponseCodesPanel();
    } else if (cat === '__deep') {
      _scRenderDeepPagesPanel();
    } else if (cat === '__hreflang') {
      _scRenderHreflangPanel();
    } else {
      _renderSitemapPanel(cat);
    }
    const bulkBtn = document.getElementById('crawler-bulk-recrawl-btn');
    if (bulkBtn) bulkBtn.style.display = 'none';
    if (typeof _refreshCrawlerExportViewBtn === 'function') _refreshCrawlerExportViewBtn();
    return;
  }
  // Drop any report-style panel content when switching back to a normal
  // table category. Missing IDs here cause the panel to leak below the
  // new view (e.g. External Links lingering under Redirects).
  ['sitemap-panel','schema-by-page-panel','near-dup-panel','sitestructure-panel',
   'all-images-panel','external-links-panel','js-diff-panel',
   'all-values-panel','duplicates-panel',
   'redir-chains-panel','response-codes-panel','deep-pages-panel','hreflang-panel']
    .forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  if (_tableWrap) _tableWrap.style.display = '';
  if (_expandHint) _expandHint.style.display = '';

  // Info box
  renderIssueInfo(cat);
  _scSetColumns(cat);

  // Re-render the table with the filtered rows. Apply current sort if any.
  const tbody = document.getElementById('crawler-tbody');
  tbody.innerHTML = '';
  let rows = crawlerResults.filter(r => matchesCategory(r, cat));
  if (typeof _scSortCol === 'number') rows = _scSortRows(rows);
  // Multiple H1s view: expand the single H1 column into H1 (1), H1 (2)…
  // one per H1 found on the worst page. Restored on every other view.
  if (cat === 'Multiple H1s') {
    const maxH1 = rows.reduce((m, r) => Math.max(m, (r.h1_list || []).length), 0);
    _scApplyMultiH1Columns(maxH1);
  } else {
    _scApplyMultiH1Columns(0);
  }
  let _matched = 0;
  for (const r of rows) { renderRow(r); _matched++; }
  // Show the bulk-recrawl button for any category that has rows. Lets the
  // user fix a batch in WP, then verify with one click that the fix landed.
  const bulkBtn = document.getElementById('crawler-bulk-recrawl-btn');
  if (bulkBtn) {
    bulkBtn.style.display = _matched ? 'inline-flex' : 'none';
    bulkBtn.disabled = false;
    const lbl = document.getElementById('crawler-bulk-recrawl-label');
    if (lbl) lbl.textContent = `Re-crawl ${_matched} URL${_matched === 1 ? '' : 's'}`;
  }
  if (typeof _refreshCrawlerExportViewBtn === 'function') _refreshCrawlerExportViewBtn();
};

// In-memory result of the last sitemap analysis. Cleared on every new crawl.
let crawlerSitemap = null;

window.sitemapAnalysisSkipped = false;

function _smEscape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _smSetStatus(state, payload) {
  const el = document.getElementById('sitemap-status');
  if (!el) return;
  el.className = 'sitemap-status';
  el.style.display = '';
  if (state === 'loading') {
    el.classList.add('is-loading');
    el.innerHTML = `<div class="ss-row"><div class="ss-spinner"></div><span>Analysing sitemap…</span></div>`;
  } else if (state === 'success') {
    const t = payload || {};
    el.innerHTML = `<div class="ss-row"><span style="color:#22c55e;">✓</span><span><b>${t.urls_in_sitemap || 0}</b> URLs in sitemap · <b>${t.urls_in_crawl || 0}</b> crawled</span></div>`;
  } else if (state === 'prompt') {
    const reason = payload && payload.reason ? payload.reason : "Couldn't find a sitemap.";
    const prefill = (payload && payload.prefill) || '';
    el.classList.add('is-error');
    el.innerHTML = `
      <div style="margin-bottom:4px;">${_smEscape(reason)} Enter the sitemap URL or skip.</div>
      <input class="ss-input" id="ss-input" type="text" placeholder="https://example.com/sitemap.xml" value="${_smEscape(prefill)}" />
      <div class="ss-btn-row">
        <button class="ss-btn ss-btn-primary" onclick="_smSubmitManual()">Analyse</button>
        <button class="ss-btn ss-btn-secondary" onclick="_smSkip()">Skip</button>
      </div>`;
    setTimeout(() => { const i = document.getElementById('ss-input'); if (i) i.focus(); }, 30);
  } else if (state === 'skipped') {
    el.classList.add('is-skipped');
    el.innerHTML = `Skipped. <a href="#" onclick="event.preventDefault();window.sitemapAnalysisSkipped=false;analyseSitemap();" style="color:var(--accent);">Re-run</a>`;
  } else {
    el.style.display = 'none';
  }
}

window._smSkip = function() {
  window.sitemapAnalysisSkipped = true;
  ['sm-cat-missing','sm-cat-orphan','sm-cat-only','sm-cat-noindex','sm-cat-non200','sm-cat-redirects','sm-cat-pagination'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  _smSetStatus('skipped');
};

window._smSubmitManual = function() {
  const i = document.getElementById('ss-input');
  const url = (i && i.value || '').trim();
  if (!url) { if (i) i.focus(); return; }
  analyseSitemap({ sitemap_url: url });
};

window.analyseSitemap = async function(opts) {
  if (!Array.isArray(crawlerResults) || !crawlerResults.length) return;
  if (window.sitemapAnalysisSkipped && !(opts && opts.sitemap_url)) return;
  let domain = '';
  try { domain = new URL(crawlerResults[0].url).origin; }
  catch { _smSetStatus('prompt', { reason: 'Could not detect domain from crawl results.' }); return; }
  _smSetStatus('loading');
  const body = { domain, results: crawlerResults, inlinks: crawlerInlinks || {} };
  if (opts && opts.sitemap_url) body.sitemap_url = opts.sitemap_url;
  try {
    const r = await fetch('/sitemap-analyse', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    let d = null; try { d = await r.json(); } catch {}
    if (!r.ok) {
      _smSetStatus('prompt', { reason: `Server returned ${r.status}` + (d && d.error ? ` — ${d.error}` : '') });
      return;
    }
    if (!d || !d.sitemaps_found || !d.sitemaps_found.length) {
      _smSetStatus('prompt', { reason: 'No sitemap discovered (tried robots.txt + common paths).', prefill: domain.replace(/\/$/, '') + '/sitemap.xml' });
      return;
    }
    crawlerSitemap = d;
    const r0 = d.reports || {};
    const setCat = (id, key) => {
      const el = document.getElementById(id);
      const cnt = (el || {}).querySelector ? el.querySelector('.ci-count') : null;
      const count = (r0[key] || []).length;
      if (el) el.style.display = '';
      if (cnt) cnt.textContent = String(count);
    };
    setCat('sm-cat-missing',    'missing_from_sitemap');
    setCat('sm-cat-orphan',     'orphan_in_sitemap');
    setCat('sm-cat-only',       'sitemap_only');
    setCat('sm-cat-noindex',    'non_indexable_in_sitemap');
    setCat('sm-cat-non200',     'non_200_in_sitemap');
    setCat('sm-cat-redirects',  'redirects_in_sitemap');
    setCat('sm-cat-pagination', 'pagination_in_sitemap');
    _smSetStatus('success', d.totals || {});
  } catch (e) {
    _smSetStatus('prompt', { reason: 'Network error: ' + (e && e.message || 'fetch failed') + '.', prefill: domain.replace(/\/$/, '') + '/sitemap.xml' });
  }
};

// All Images panel — every meaningful <img> seen during the crawl, grouped
// by canonical src so a logo used on every page is one row with a "N pages"
// expander. Filter chips (All / Missing alt / Empty alt in link / Decorative
// / Has alt) toggle row visibility. Pure crawler data — no AI — so it lives
// in the public site-crawler. Mirrors seo-tool's _renderAllImagesPanel but
// without the "Generate in Bulk Image Alt" button (Claude-only feature).
// =============================================================================
// JS vs non-JS Diff panel — for crawls run with `Compare with non-JS HTML`.
// Mirrors seo-tool/_renderJsDiffPanel; pure parsing, no Claude/AI.
// Severity ladder: critical (title/meta/schema), high (h1/word_count),
// medium (links/images), none (page is server-rendered correctly).
// =============================================================================
window._scJsDiffFilter = window._scJsDiffFilter || 'all';

function _scJsDiffSetFilter(v) {
  window._scJsDiffFilter = v;
  document.querySelectorAll('#js-diff-panel [data-jsdiff-sev]').forEach(el => {
    const s = el.dataset.jsdiffSev;
    const show = (v === 'all') || (s === v);
    el.style.display = show ? '' : 'none';
  });
  document.querySelectorAll('#js-diff-panel .jsdiff-chip').forEach(b => {
    const active = b.dataset.sev === v;
    b.style.background = active ? 'var(--text)' : 'var(--surface,#fff)';
    b.style.color = active ? 'var(--surface,#fff)' : 'var(--text)';
  });
}
window._scJsDiffSetFilter = _scJsDiffSetFilter;

function _scRenderJsDiffPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('js-diff-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'js-diff-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  const allPages = (crawlerResults || []).filter(r => r && r.js_diff);
  if (!allPages.length) {
    panel.innerHTML = `<div style="padding:20px;color:var(--text-muted);">
      This crawl didn't run a JS-vs-non-JS comparison. Re-crawl with
      <b>Render JS</b> + <b>Compare with non-JS HTML</b> both checked.
    </div>`;
    main.appendChild(panel);
    return;
  }
  const withDiff = allPages.filter(r => r.js_diff.severity !== 'none');
  const counts = {
    critical: withDiff.filter(r => r.js_diff.severity === 'critical').length,
    high:     withDiff.filter(r => r.js_diff.severity === 'high').length,
    medium:   withDiff.filter(r => r.js_diff.severity === 'medium').length,
  };
  const total = allPages.length;
  const clean = total - withDiff.length;

  if (!withDiff.length) {
    panel.innerHTML = `<div style="padding:14px 16px;background:var(--surface2,#f8fafc);border-bottom:1px solid var(--border,#e5e7eb);">
      <div style="font-size:.85rem;font-weight:600;color:#166534;">✓ All ${total} compared pages render the same with and without JS.</div>
      <div style="font-size:.72rem;color:var(--text-muted);margin-top:4px;line-height:1.5;">
        Title, meta, H1, schema, word count, link counts and image counts all match. AI crawlers without JS execution see the same content as Google's full renderer. Server-side rendering is doing its job.
      </div>
    </div>`;
    main.appendChild(panel);
    return;
  }

  const sevRank = {critical: 0, high: 1, medium: 2};
  const sorted = withDiff.slice().sort((a, b) => {
    const ra = sevRank[a.js_diff.severity] ?? 3;
    const rb = sevRank[b.js_diff.severity] ?? 3;
    return ra - rb || (a.url || '').localeCompare(b.url || '');
  });

  const sevColor = (s) => ({
    critical: { bg:'#fee2e2', fg:'#991b1b', bd:'#fca5a5' },
    high:     { bg:'#fef3c7', fg:'#92400e', bd:'#fcd34d' },
    medium:   { bg:'#dbeafe', fg:'#1e40af', bd:'#93c5fd' },
  }[s] || { bg:'var(--surface,#fff)', fg:'var(--text-muted,#777)', bd:'var(--border,#e5e7eb)' });

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtVal = (v) => {
    if (v == null || v === '') return '<span style="color:var(--text-muted);font-style:italic;">— empty</span>';
    if (Array.isArray(v)) return v.length ? v.map(x => `<code style="font-size:10.5px;background:var(--surface2,#f8fafc);padding:1px 5px;border-radius:3px;margin-right:3px;">${esc(x)}</code>`).join('') : '<span style="color:var(--text-muted);font-style:italic;">— none</span>';
    return esc(v);
  };
  const fieldRow = (label, jsVal, nojsVal, differs) => {
    const bg = differs ? '#fef3c7' : 'transparent';
    const bdL = differs ? '3px solid #f59e0b' : '3px solid transparent';
    return `<tr style="background:${bg};">
      <td style="padding:6px 10px;border-left:${bdL};font-weight:600;font-size:.72rem;color:var(--text-muted);width:170px;">${label}${differs?' ⚠':''}</td>
      <td style="padding:6px 10px;font-size:.74rem;border-left:1px solid var(--border,#e5e7eb);">${fmtVal(jsVal)}</td>
      <td style="padding:6px 10px;font-size:.74rem;border-left:1px solid var(--border,#e5e7eb);">${fmtVal(nojsVal)}</td>
    </tr>`;
  };

  const card = (r) => {
    const sev = r.js_diff.severity;
    const c = sevColor(sev);
    const fields = new Set(r.js_diff.fields || []);
    const nojs = r.non_js || {};
    return `<div data-jsdiff-sev="${sev}" style="border:1px solid var(--border,#e5e7eb);border-radius:6px;margin:10px 14px;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface2,#f8fafc);border-bottom:1px solid var(--border,#e5e7eb);">
        <span style="display:inline-block;padding:3px 9px;border-radius:999px;border:1px solid ${c.bd};background:${c.bg};color:${c.fg};font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">${sev}</span>
        <a href="${esc(r.url || '')}" target="_blank" style="color:var(--accent,#6366f1);font-size:.78rem;font-weight:600;text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.url || '')}</a>
        <span style="font-size:.7rem;color:var(--text-muted);">${(r.js_diff.fields || []).length} field${((r.js_diff.fields || []).length)===1?'':'s'} differ</span>
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:var(--surface,#fff);">
          <th style="padding:5px 10px;font-size:.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;text-align:left;border-bottom:1px solid var(--border,#e5e7eb);"></th>
          <th style="padding:5px 10px;font-size:.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;text-align:left;border-bottom:1px solid var(--border,#e5e7eb);border-left:1px solid var(--border,#e5e7eb);">Rendered (with JS)</th>
          <th style="padding:5px 10px;font-size:.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;text-align:left;border-bottom:1px solid var(--border,#e5e7eb);border-left:1px solid var(--border,#e5e7eb);">Raw HTML (no JS)</th>
        </tr></thead>
        <tbody>
          ${fieldRow('Title',           r.title,            nojs.title,            fields.has('title'))}
          ${fieldRow('Meta description',r.meta_description, nojs.meta_description, fields.has('meta_description'))}
          ${fieldRow('H1',              r.h1,               nojs.h1,               fields.has('h1'))}
          ${fieldRow('Word count',      r.word_count,       nojs.word_count,       fields.has('word_count'))}
          ${fieldRow('Schema types',    r.schema_types,     nojs.schema_types,     fields.has('schema_types'))}
          ${fieldRow('Internal links',  r.internal_links,   nojs.internal_links_count, fields.has('internal_links'))}
          ${fieldRow('External links',  r.external_links,   nojs.external_links_count, fields.has('external_links'))}
          ${fieldRow('Image count',     r.images_total,     nojs.images_count,     fields.has('images_total'))}
          ${fieldRow('Missing alts',    r.images_no_alt,    nojs.images_no_alt,    fields.has('images_no_alt'))}
        </tbody>
      </table>
    </div>`;
  };

  const chipBtn = (sev, label, n, color) => `
    <button type="button" class="jsdiff-chip" data-sev="${sev}" onclick="_scJsDiffSetFilter('${sev}')" style="padding:4px 12px;border-radius:14px;border:1px solid ${color.bd};background:${color.bg};color:${color.fg};font-size:11.5px;cursor:pointer;font-weight:600;">${label} <span style="opacity:.75;font-weight:400;">${n}</span></button>`;

  panel.innerHTML = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border,#e5e7eb);background:var(--surface2,#f8fafc);">
      <div style="font-size:.85rem;font-weight:600;color:var(--text);margin-bottom:4px;">JS vs non-JS HTML diff</div>
      <div style="font-size:.72rem;color:var(--text-muted);margin-bottom:8px;line-height:1.55;">
        Compared <b>${total}</b> pages in both modes. <b style="color:#991b1b;">${withDiff.length}</b> have content invisible to AI crawlers (ChatGPT, Claude, Perplexity, Google-Extended) which mostly don't execute JS. <b style="color:#166534;">${clean}</b> render the same in both modes.
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <button type="button" class="jsdiff-chip" data-sev="all" onclick="_scJsDiffSetFilter('all')" style="padding:4px 12px;border-radius:14px;border:1px solid var(--text);background:var(--text);color:var(--surface,#fff);font-size:11.5px;cursor:pointer;font-weight:600;">All ${withDiff.length}</button>
        ${counts.critical ? chipBtn('critical', '⚠ Critical', counts.critical, sevColor('critical')) : ''}
        ${counts.high     ? chipBtn('high',     'High',       counts.high,     sevColor('high'))     : ''}
        ${counts.medium   ? chipBtn('medium',   'Medium',     counts.medium,   sevColor('medium'))   : ''}
      </div>
    </div>
    ${sorted.map(card).join('')}`;
  main.appendChild(panel);
  window._scJsDiffFilter = 'all';
}
window._scRenderJsDiffPanel = _scRenderJsDiffPanel;

function _scRenderAllImagesPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('all-images-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'all-images-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  if (!Array.isArray(crawlerResults) || !crawlerResults.length) {
    panel.innerHTML = '<div style="padding:20px;color:var(--text-muted);">No pages crawled yet.</div>';
    main.appendChild(panel);
    return;
  }

  // Group images by canonical src; filter widget images at render time too,
  // so already-cached crawls get a clean view without a re-crawl.
  const bySrc = new Map();
  for (const r of crawlerResults) {
    const data = Array.isArray(r.images_all_data) ? r.images_all_data : [];
    for (const img of data) {
      if (!img || !img.src) continue;
      if (typeof _isThirdPartyWidgetImage === 'function' && _isThirdPartyWidgetImage(img.src)) continue;
      let entry = bySrc.get(img.src);
      if (!entry) { entry = { src: img.src, pages: [] }; bySrc.set(img.src, entry); }
      entry.pages.push({
        url: r.url || '',
        page_title: r.title || '',
        h1: r.h1 || '',
        alt: img.alt === undefined ? null : img.alt,
        classification: img.classification || 'present',
      });
    }
  }
  const groups = Array.from(bySrc.values());

  // Sort: missing first, then empty-in-link, then empty (decorative), then present.
  // Within each bucket, most-used first.
  const altState = (g) => {
    const cls = g.pages[0]?.classification || 'present';
    if (cls === 'missing') return 0;
    if (cls === 'empty in link') return 1;
    if (cls === 'empty') return 2;
    return 3;
  };
  groups.sort((a, b) => altState(a) - altState(b) || b.pages.length - a.pages.length);

  const totalImgs = groups.reduce((n, g) => n + g.pages.length, 0);
  const uniq = groups.length;
  const _firstCls = (g) => (g.pages[0] && g.pages[0].classification) || 'present';
  const missing   = groups.filter(g => _firstCls(g) === 'missing').length;
  const emptyLink = groups.filter(g => _firstCls(g) === 'empty in link').length;
  const emptyDeco = groups.filter(g => _firstCls(g) === 'empty').length;
  const present   = groups.filter(g => _firstCls(g) === 'present').length;
  const problems  = missing + emptyLink;

  if (!uniq) {
    panel.innerHTML = '<div style="padding:20px;color:var(--text-muted);">No images captured in this crawl. Re-crawl to populate (older crawls predate the All Images capture).</div>';
    main.appendChild(panel);
    return;
  }

  // Friendly summary card with built-in legend.
  const _altCellHtml = (cls, alt) => {
    if (cls === 'missing') return `<span style="color:#ef4444;font-style:italic;">— missing</span>`;
    if (cls === 'empty')   return `<span style="color:#f59e0b;font-style:italic;">— empty (decorative)</span>`;
    if (cls === 'empty in link') return `<span style="color:#ef4444;font-style:italic;">— empty alt on a link (no accessible name)</span>`;
    return escapeHtml(alt || '');
  };

  panel.innerHTML = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">All images found across the crawl</div>
      <div style="font-size:.75rem;color:var(--text-muted);margin-bottom:8px;line-height:1.55;">
        <b>${uniq}</b> different image${uniq === 1 ? '' : 's'} used <b>${totalImgs}</b> time${totalImgs === 1 ? '' : 's'} across the site (a logo on every page is one image used many times).
        ${problems
          ? ` <b style="color:#991b1b;">${problems} need${problems===1?'s':''} fixing</b>`
          : ` <b style="color:#166534;">No images need fixing.</b>`}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
        <button type="button" class="sc-ai-chip sc-ai-chip-active" data-filter="all" onclick="_scAllImagesFilter('all')" style="padding:4px 12px;border-radius:14px;border:1px solid var(--text);background:var(--text);color:var(--surface);font-size:11.5px;cursor:pointer;font-weight:600;">All <span style="opacity:.75;font-weight:400;">${uniq}</span></button>
        ${missing ? `<button type="button" class="sc-ai-chip" data-filter="missing" onclick="_scAllImagesFilter('missing')" title="No alt attribute at all — Google + screen readers can't read these. Real problem." style="padding:4px 12px;border-radius:14px;border:1px solid #fca5a5;background:#fee2e2;color:#991b1b;font-size:11.5px;cursor:pointer;font-weight:600;">⚠ Missing alt <span style="font-weight:400;">${missing}</span></button>` : ''}
        ${emptyLink ? `<button type="button" class="sc-ai-chip" data-filter="empty in link" onclick="_scAllImagesFilter('empty in link')" title="alt=&quot;&quot; on a clickable image — screen reader has nothing to announce. Real problem." style="padding:4px 12px;border-radius:14px;border:1px solid #fca5a5;background:#fee2e2;color:#991b1b;font-size:11.5px;cursor:pointer;font-weight:600;">⚠ Empty alt in link <span style="font-weight:400;">${emptyLink}</span></button>` : ''}
        ${emptyDeco ? `<button type="button" class="sc-ai-chip" data-filter="empty" onclick="_scAllImagesFilter('empty')" title="alt=&quot;&quot; on a non-link image — CORRECT pattern for purely decorative images. Not a problem." style="padding:4px 12px;border-radius:14px;border:1px solid #fcd34d;background:#fef3c7;color:#92400e;font-size:11.5px;cursor:pointer;font-weight:600;">Decorative (alt="") <span style="font-weight:400;">${emptyDeco}</span></button>` : ''}
        ${present ? `<button type="button" class="sc-ai-chip" data-filter="present" onclick="_scAllImagesFilter('present')" title="Has meaningful alt text. Already fine — review the wording." style="padding:4px 12px;border-radius:14px;border:1px solid #bbf7d0;background:#dcfce7;color:#166534;font-size:11.5px;cursor:pointer;font-weight:600;">Has alt <span style="font-weight:400;">${present}</span></button>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;">
          <button type="button" onclick="_scCopyAllImages()" title="Copy Image src → Alt → Page URLs as TSV (paste into Sheets/Excel)" style="padding:5px 12px;font-size:11.5px;background:var(--surface);border:1px solid var(--border);border-radius:6px;cursor:pointer;color:var(--text);">Copy as TSV</button>
        </div>
      </div>
      <details style="font-size:.72rem;color:var(--text-muted);margin-top:4px;">
        <summary style="cursor:pointer;user-select:none;">What's the difference between "missing alt" and "empty alt"?</summary>
        <div style="padding:6px 0 0 14px;line-height:1.55;">
          <div><b style="color:#991b1b;">Missing alt</b> — the <code>&lt;img&gt;</code> has no <code>alt</code> attribute at all. HTML5 violation. Google can't read the image, screen readers announce the filename. <b>Always fix.</b></div>
          <div style="margin-top:4px;"><b style="color:#92400e;">Empty alt (decorative)</b> — <code>alt=""</code> on a non-link image. <b>This is the CORRECT pattern</b> for purely decorative images. Tells screen readers to skip. Listed so you can spot ones that should actually have alt text.</div>
          <div style="margin-top:4px;"><b style="color:#991b1b;">Empty alt in link</b> — <code>alt=""</code> on an <code>&lt;a&gt;</code>/<code>&lt;button&gt;</code> with no other text. The link has no accessible name at all. <b>Always fix.</b></div>
        </div>
      </details>
    </div>
    <table id="sc-all-images-table" style="width:100%;border-collapse:collapse;font-size:.78rem;">
      <colgroup>
        <col style="width:90px"><col style="width:340px"><col style="width:380px"><col>
      </colgroup>
      <thead>
        <tr style="background:var(--surface);position:sticky;top:0;">
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">Preview</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">Image src</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">Alt text</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">Page${groups.some(g => g.pages.length > 1) ? '(s)' : ''} where used</th>
        </tr>
      </thead>
      <tbody>
        ${groups.map(g => {
          const first = g.pages[0];
          const safeSrc = escapeHtml(g.src);
          const altHtml = _altCellHtml(first.classification, first.alt);
          const pagesHtml = g.pages.length === 1
            ? `<a href="${escapeHtml(first.url)}" target="_blank" style="color:var(--accent);">${escapeHtml(first.url)}</a>${typeof _scOpenIcon === 'function' ? _scOpenIcon(first.url) : ''}`
            : `<details style="margin:0;"><summary style="cursor:pointer;color:var(--text);"><b>${g.pages.length}</b> pages — <span style="color:var(--text-muted);">click to expand</span></summary>${g.pages.map(p => `<div style="font-size:.72rem;padding:3px 0;border-top:1px dashed var(--border);margin-top:4px;"><a href="${escapeHtml(p.url)}" target="_blank" style="color:var(--accent);">${escapeHtml(p.url)}</a><div style="color:var(--text-muted);margin-top:2px;">alt: ${_altCellHtml(p.classification, p.alt)}</div></div>`).join('')}</details>`;
          return `
            <tr data-src="${safeSrc}" data-cls="${escapeHtml(first.classification || 'present')}" style="border-bottom:1px solid var(--border);">
              <td style="text-align:center;padding:4px;"><img src="${safeSrc}" alt="" loading="lazy" style="max-width:80px;max-height:80px;border-radius:3px;border:1px solid var(--border);background:#fff;" onerror="this.style.opacity='.3';this.title='Failed to load';" /></td>
              <td title="${safeSrc}" style="padding:6px 10px;word-break:break-all;white-space:normal;"><a href="${safeSrc}" target="_blank" style="color:var(--accent);">${safeSrc}</a></td>
              <td title="${escapeHtml(first.alt || '')}" style="padding:6px 10px;white-space:normal;">${altHtml}</td>
              <td style="padding:6px 10px;white-space:normal;">${pagesHtml}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  main.appendChild(panel);
}

// Toggle row visibility on the All Images panel by alt classification.
function _scAllImagesFilter(want) {
  const tbody = document.querySelector('#sc-all-images-table tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr[data-cls]').forEach(tr => {
    tr.style.display = (want === 'all' || tr.dataset.cls === want) ? '' : 'none';
  });
  document.querySelectorAll('.sc-ai-chip').forEach(b => {
    const isActive = b.dataset.filter === want;
    b.classList.toggle('sc-ai-chip-active', isActive);
    if (isActive) {
      b.style.background = 'var(--text)';
      b.style.color = 'var(--surface)';
      b.style.borderColor = 'var(--text)';
    } else {
      const f = b.dataset.filter;
      const restore = {
        'all':           { bg:'var(--surface)', fg:'var(--text)', bd:'var(--border)' },
        'missing':       { bg:'#fee2e2', fg:'#991b1b', bd:'#fca5a5' },
        'empty in link': { bg:'#fee2e2', fg:'#991b1b', bd:'#fca5a5' },
        'empty':         { bg:'#fef3c7', fg:'#92400e', bd:'#fcd34d' },
        'present':       { bg:'#dcfce7', fg:'#166534', bd:'#bbf7d0' },
      }[f] || { bg:'var(--surface)', fg:'var(--text)', bd:'var(--border)' };
      b.style.background = restore.bg;
      b.style.color = restore.fg;
      b.style.borderColor = restore.bd;
    }
  });
}

// =============================================================================
// External Links panel — every off-domain link with rel + target attributes.
// Two SEO concerns surfaced separately:
//   - dofollow links (no rel=nofollow) leak link equity to third parties
//   - same-window links (no target=_blank) push the visitor off your site
// "Risky" = both at once on the same link. The data is descriptive, not
// auto-flagged — dofollow is correct for genuine citations, and same-window
// is fine for some relationships. The user filters to find what to fix.
// =============================================================================
function _scRenderExternalLinksPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('external-links-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'external-links-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  const allLinks = [];
  for (const r of (crawlerResults || [])) {
    const list = Array.isArray(r.external_link_urls) ? r.external_link_urls : [];
    for (const entry of list) {
      const url = entry[0] || '';
      if (!url) continue;
      const anchor    = entry[1] || '';
      const placement = entry[2] || '';
      const rel       = (entry[3] || '').toString();
      const target    = (entry[4] || '').toString();
      const nofollow  = /\bnofollow\b/.test(rel);
      const newTab    = target === '_blank';
      const risk = (!nofollow && !newTab) ? 'high'
                 : (!nofollow ? 'follow'
                 : (!newTab  ? 'samewindow' : 'ok'));
      allLinks.push({source: r.url || '', url, anchor, rel, target, placement, nofollow, newTab, risk});
    }
  }

  if (!allLinks.length) {
    panel.innerHTML = '<div style="padding:20px;color:var(--text-muted);">No external links captured in this crawl. Re-crawl to populate (older crawls predate the External Links capture, which records rel + target per off-domain link).</div>';
    main.appendChild(panel);
    return;
  }

  const counts = {
    all:        allLinks.length,
    high:       allLinks.filter(l => l.risk === 'high').length,
    follow:     allLinks.filter(l => !l.nofollow).length,
    nofollow:   allLinks.filter(l => l.nofollow).length,
    samewindow: allLinks.filter(l => !l.newTab).length,
    newtab:     allLinks.filter(l => l.newTab).length,
  };

  const domains = new Set();
  for (const l of allLinks) {
    try { const d = new URL(l.url).hostname.replace(/^www\./, ''); if (d) domains.add(d); } catch (e) {}
  }

  panel.innerHTML = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">External links found across the crawl</div>
      <div style="font-size:.75rem;color:var(--text-muted);margin-bottom:8px;line-height:1.55;">
        <b>${allLinks.length}</b> external link${allLinks.length === 1 ? '' : 's'} pointing to <b>${domains.size}</b> domain${domains.size === 1 ? '' : 's'}.
        ${counts.high
          ? ` <b style="color:#991b1b;">${counts.high} risky</b> <span>(follow + same-window — leaks SEO equity AND loses the visitor)</span>`
          : ` <b style="color:#166534;">No risky links found.</b>`}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
        <button type="button" class="sc-el-chip sc-el-chip-active" data-filter="all" onclick="_scExternalLinksFilter('all')" style="padding:4px 12px;border-radius:14px;border:1px solid var(--text);background:var(--text);color:var(--surface);font-size:11.5px;cursor:pointer;font-weight:600;">All <span style="opacity:.75;font-weight:400;">${counts.all}</span></button>
        ${counts.high ? `<button type="button" class="sc-el-chip" data-filter="high" onclick="_scExternalLinksFilter('high')" title="Follow + same-window — leaks link equity AND pushes the visitor off your site." style="padding:4px 12px;border-radius:14px;border:1px solid #fca5a5;background:#fee2e2;color:#991b1b;font-size:11.5px;cursor:pointer;font-weight:600;">⚠ Risky <span style="font-weight:400;">${counts.high}</span></button>` : ''}
        ${counts.follow ? `<button type="button" class="sc-el-chip" data-filter="follow" onclick="_scExternalLinksFilter('follow')" title="No rel=nofollow. Passes SEO equity to the destination." style="padding:4px 12px;border-radius:14px;border:1px solid #fcd34d;background:#fef3c7;color:#92400e;font-size:11.5px;cursor:pointer;font-weight:600;">Follow <span style="font-weight:400;">${counts.follow}</span></button>` : ''}
        ${counts.nofollow ? `<button type="button" class="sc-el-chip" data-filter="nofollow" onclick="_scExternalLinksFilter('nofollow')" title="Has rel=nofollow / ugc / sponsored. Doesn't pass equity." style="padding:4px 12px;border-radius:14px;border:1px solid #bbf7d0;background:#dcfce7;color:#166534;font-size:11.5px;cursor:pointer;font-weight:600;">Nofollow <span style="font-weight:400;">${counts.nofollow}</span></button>` : ''}
        ${counts.samewindow ? `<button type="button" class="sc-el-chip" data-filter="samewindow" onclick="_scExternalLinksFilter('samewindow')" title="No target=_blank. Visitor leaves your site on click." style="padding:4px 12px;border-radius:14px;border:1px solid #fcd34d;background:#fef3c7;color:#92400e;font-size:11.5px;cursor:pointer;font-weight:600;">Same window <span style="font-weight:400;">${counts.samewindow}</span></button>` : ''}
        ${counts.newtab ? `<button type="button" class="sc-el-chip" data-filter="newtab" onclick="_scExternalLinksFilter('newtab')" title="target=_blank set. Opens in a new tab; your page stays open." style="padding:4px 12px;border-radius:14px;border:1px solid #93c5fd;background:#dbeafe;color:#1e40af;font-size:11.5px;cursor:pointer;font-weight:600;">New tab <span style="font-weight:400;">${counts.newtab}</span></button>` : ''}
      </div>
      <details style="font-size:.72rem;color:var(--text-muted);margin-top:4px;">
        <summary style="cursor:pointer;user-select:none;">What does each filter mean?</summary>
        <div style="padding:6px 0 0 14px;line-height:1.55;">
          <div><b style="color:#991b1b;">Risky</b> — link has neither <code>rel=nofollow</code> nor <code>target=_blank</code>. Passes link equity to a third-party domain AND opens in the same tab so the visitor leaves your site.</div>
          <div style="margin-top:4px;"><b style="color:#92400e;">Follow / dofollow</b> — no <code>rel=nofollow</code>. Passes SEO equity to the destination. Fine for trusted citations; problematic on user-generated content, sponsored posts, or untrusted sources.</div>
          <div style="margin-top:4px;"><b style="color:#166534;">Nofollow</b> — has <code>rel=nofollow</code>, <code>ugc</code>, or <code>sponsored</code>. Doesn't pass equity. Right for paid links and untrusted content.</div>
          <div style="margin-top:4px;"><b style="color:#92400e;">Same window</b> — no <code>target=_blank</code>. Visitor leaves your site on click. Usually bad UX on external links.</div>
          <div style="margin-top:4px;"><b style="color:#1e40af;">New tab</b> — <code>target=_blank</code> set. External link opens in a new tab; your page stays open.</div>
        </div>
      </details>
    </div>
    <table id="sc-external-links-table" style="width:100%;border-collapse:collapse;font-size:.78rem;">
      <colgroup>
        <col style="width:280px"><col style="width:340px"><col style="width:220px"><col style="width:140px"><col style="width:90px"><col style="width:80px">
      </colgroup>
      <thead>
        <tr style="background:var(--surface);position:sticky;top:0;">
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">Source page</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">External URL</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">Anchor</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">rel</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">target</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border);">Risk</th>
        </tr>
      </thead>
      <tbody>
        ${allLinks.map(l => {
          const riskBadge = {
            high:       '<span style="color:#991b1b;font-weight:600;">⚠ risky</span>',
            follow:     '<span style="color:#92400e;">follow</span>',
            samewindow: '<span style="color:#92400e;">same window</span>',
            ok:         '<span style="color:#166534;">ok</span>',
          }[l.risk] || '';
          return `
            <tr data-risk="${l.risk}" data-follow="${l.nofollow ? 'nofollow' : 'follow'}" data-window="${l.newTab ? 'newtab' : 'samewindow'}" style="border-bottom:1px solid var(--border);">
              <td style="padding:6px 10px;word-break:break-all;white-space:normal;"><a href="${escapeHtml(l.source)}" target="_blank" rel="noopener" style="color:var(--accent);">${escapeHtml(l.source)}</a></td>
              <td style="padding:6px 10px;word-break:break-all;white-space:normal;"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">${escapeHtml(l.url)}</a></td>
              <td title="${escapeHtml(l.anchor)}" style="padding:6px 10px;white-space:normal;">${escapeHtml(l.anchor)}</td>
              <td style="padding:6px 10px;"><code style="font-size:.7rem;color:var(--text-muted);">${escapeHtml(l.rel || '(none)')}</code></td>
              <td style="padding:6px 10px;"><code style="font-size:.7rem;color:var(--text-muted);">${escapeHtml(l.target || '(none)')}</code></td>
              <td style="padding:6px 10px;">${riskBadge}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  main.appendChild(panel);
}

function _scExternalLinksFilter(want) {
  const tbody = document.querySelector('#sc-external-links-table tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr[data-risk]').forEach(tr => {
    let show = false;
    if (want === 'all')             show = true;
    else if (want === 'high')       show = tr.dataset.risk === 'high';
    else if (want === 'follow')     show = tr.dataset.follow === 'follow';
    else if (want === 'nofollow')   show = tr.dataset.follow === 'nofollow';
    else if (want === 'samewindow') show = tr.dataset.window === 'samewindow';
    else if (want === 'newtab')     show = tr.dataset.window === 'newtab';
    tr.style.display = show ? '' : 'none';
  });
  document.querySelectorAll('.sc-el-chip').forEach(b => {
    const isActive = b.dataset.filter === want;
    b.classList.toggle('sc-el-chip-active', isActive);
    if (isActive) {
      b.style.background = 'var(--text)';
      b.style.color = 'var(--surface)';
      b.style.borderColor = 'var(--text)';
    } else {
      const restore = {
        'all':        { bg:'var(--surface)', fg:'var(--text)', bd:'var(--border)' },
        'high':       { bg:'#fee2e2', fg:'#991b1b', bd:'#fca5a5' },
        'follow':     { bg:'#fef3c7', fg:'#92400e', bd:'#fcd34d' },
        'nofollow':   { bg:'#dcfce7', fg:'#166534', bd:'#bbf7d0' },
        'samewindow': { bg:'#fef3c7', fg:'#92400e', bd:'#fcd34d' },
        'newtab':     { bg:'#dbeafe', fg:'#1e40af', bd:'#93c5fd' },
      }[b.dataset.filter] || { bg:'var(--surface)', fg:'var(--text)', bd:'var(--border)' };
      b.style.background = restore.bg;
      b.style.color = restore.fg;
      b.style.borderColor = restore.bd;
    }
  });
}

// Copy "src \t alt \t classification \t pages" TSV — pastes cleanly into Sheets.
function _scCopyAllImages() {
  const lines = ['Image src\tAlt\tClassification\tPage URLs'];
  const bySrc = new Map();
  for (const r of (crawlerResults || [])) {
    const data = Array.isArray(r.images_all_data) ? r.images_all_data : [];
    for (const img of data) {
      if (!img || !img.src) continue;
      if (typeof _isThirdPartyWidgetImage === 'function' && _isThirdPartyWidgetImage(img.src)) continue;
      let e = bySrc.get(img.src);
      if (!e) { e = { src: img.src, alt: img.alt, cls: img.classification, pages: [] }; bySrc.set(img.src, e); }
      e.pages.push(r.url || '');
    }
  }
  for (const e of bySrc.values()) {
    const altCell = e.alt == null ? '' : String(e.alt).replace(/\t/g, ' ').replace(/\n/g, ' ');
    lines.push(`${e.src}\t${altCell}\t${e.cls || ''}\t${e.pages.join(' | ')}`);
  }
  navigator.clipboard.writeText(lines.join('\n')).then(
    () => { try { showToast(`Copied ${bySrc.size} image rows as TSV.`, 'success'); } catch {} },
    () => { try { showToast('Clipboard write failed.', 'error'); } catch {} }
  );
}

// "All Titles / Metas / H1s / Canonicals" bulk-report panel.
// One row per crawled page (pagination filtered out — same value as the
// parent archive). Sortable by URL or value. Copy-as-TSV and copy-values-only
// helpers below. No Bulk Meta / AI rewrite affordances here — site-crawler
// stays pure-crawler.
function _scRenderAllValuesPanel(cat) {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('all-values-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'all-values-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  if (!Array.isArray(crawlerResults) || !crawlerResults.length) {
    panel.innerHTML = '<div style="padding:20px;color:var(--text-muted);">No pages crawled yet.</div>';
    main.appendChild(panel);
    return;
  }

  const spec = {
    '__all_titles':    { field: 'title',            len: 'title_len', label: 'Title',            limit: 60,  minLen: 30, emptyClass: 'Missing title' },
    '__all_metas':     { field: 'meta_description', len: 'meta_len',  label: 'Meta description', limit: 150, minLen: 70, emptyClass: 'Missing meta description' },
    '__all_h1s':       { field: 'h1',               len: null,        label: 'H1',               limit: null,minLen: 0,  emptyClass: 'Missing H1' },
    '__all_canonicals':{ field: 'canonical',        len: null,        label: 'Canonical',        limit: null,minLen: 0,  emptyClass: 'Missing canonical' },
  }[cat];
  if (!spec) return;

  const filtered = crawlerResults.filter(r => !r.is_pagination);
  const rows = filtered.slice().sort((a, b) => {
    const av = (a[spec.field] || '').toLowerCase();
    const bv = (b[spec.field] || '').toLowerCase();
    if (!av && bv) return 1;
    if (av && !bv) return -1;
    return av.localeCompare(bv) || (a.url || '').localeCompare(b.url || '');
  });

  const total = rows.length;
  const filled = rows.filter(r => r[spec.field]).length;
  const empty  = total - filled;
  const overLimit = spec.limit ? rows.filter(r => r[spec.field] && (r[spec.len] ? r[spec.len] : r[spec.field].length) > spec.limit).length : 0;

  const summary = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.78rem;align-items:center;">
        <span><b style="color:var(--text);font-size:1.05rem;font-variant-numeric:tabular-nums;">${total}</b> <span style="color:var(--text-muted);">pages</span></span>
        <span><b style="color:var(--text);font-size:1.05rem;font-variant-numeric:tabular-nums;">${filled}</b> <span style="color:var(--text-muted);">with ${escapeHtml(spec.label.toLowerCase())}</span></span>
        ${empty ? `<span><b style="color:#ef4444;font-size:1.05rem;font-variant-numeric:tabular-nums;">${empty}</b> <span style="color:var(--text-muted);">missing</span></span>` : ''}
        ${spec.limit ? `<span><b style="color:${overLimit ? '#ef4444' : 'var(--text)'};font-size:1.05rem;font-variant-numeric:tabular-nums;">${overLimit}</b> <span style="color:var(--text-muted);">over ${spec.limit} chars</span></span>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;">
          <button class="export-btn" type="button" onclick="_scCopyAllValues('${cat}')" title="Copy URL → ${escapeHtml(spec.label)} as TSV (paste into Sheets/Excel)" style="padding:5px 12px;font-size:11.5px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;color:#0f172a;font-weight:600;cursor:pointer;">Copy as TSV</button>
          <button class="export-btn" type="button" onclick="_scCopyValuesOnly('${cat}')" title="Copy just the ${escapeHtml(spec.label.toLowerCase())} values, one per line" style="padding:5px 12px;font-size:11.5px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;color:#0f172a;font-weight:600;cursor:pointer;">Copy values only</button>
        </div>
      </div>
    </div>`;

  const hasChars = !!spec.limit;
  const valueColW = (cat === '__all_metas') ? ' style="width:780px"' : ' style="width:680px"';
  const body = `
    <table class="crawler-grid" data-resize-key="all-values-${cat}" style="font-size:.78rem;">
      <colgroup>
        <col style="width:520px">
        <col${valueColW}>
        ${hasChars ? '<col style="width:80px">' : ''}
      </colgroup>
      <thead>
        <tr>
          <th style="position:relative;"><span class="th-label">URL</span><span class="th-resize" data-col-idx="0"></span></th>
          <th style="position:relative;"><span class="th-label">${escapeHtml(spec.label)}</span><span class="th-resize" data-col-idx="1"></span></th>
          ${hasChars ? '<th style="position:relative;"><span class="th-label th-center">Chars</span><span class="th-resize" data-col-idx="2"></span></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const v = r[spec.field] || '';
          const n = spec.len ? (r[spec.len] || (v ? v.length : 0)) : (v ? v.length : 0);
          const over  = spec.limit && v && n > spec.limit;
          const under = spec.limit && v && spec.minLen && n < spec.minLen;
          const u = r.url || '';
          const safeU = escapeHtml(u);
          const safeV = v ? escapeHtml(v) : `<span style="color:#ef4444;font-style:italic;">— ${escapeHtml(spec.emptyClass)}</span>`;
          const cellStyle = over ? 'color:#ef4444;' : (under ? 'color:#f59e0b;' : '');
          return `
            <tr data-url="${safeU}">
              <td title="${safeU}"><a href="${safeU}" target="_blank" style="color:var(--accent);">${safeU}</a></td>
              <td title="${escapeHtml(v)}" style="${cellStyle}">${safeV}</td>
              ${hasChars ? `<td style="text-align:right;${cellStyle}">${v ? n : ''}</td>` : ''}
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  panel.innerHTML = summary + body;
  main.appendChild(panel);
  if (typeof _scWireNestedGrids === 'function') _scWireNestedGrids(panel);
}

function _scAllValuesField(cat) {
  return {'__all_titles':'title','__all_metas':'meta_description','__all_h1s':'h1','__all_canonicals':'canonical'}[cat];
}
window._scCopyAllValues = function(cat) {
  const f = _scAllValuesField(cat);
  if (!f) return;
  const lbl = {title:'Title',meta_description:'Meta Description',h1:'H1',canonical:'Canonical'}[f];
  const lines = ['URL\t' + lbl];
  crawlerResults.forEach(r => lines.push((r.url || '') + '\t' + (r[f] || '').replace(/\t/g, ' ').replace(/\n/g, ' ')));
  navigator.clipboard.writeText(lines.join('\n')).then(
    () => showToast(`Copied ${crawlerResults.length} rows as TSV.`, 'success'),
    () => showToast('Clipboard write failed.', 'error')
  );
};
window._scCopyValuesOnly = function(cat) {
  const f = _scAllValuesField(cat);
  if (!f) return;
  const lines = crawlerResults.map(r => (r[f] || '').replace(/\n/g, ' ')).filter(Boolean);
  navigator.clipboard.writeText(lines.join('\n')).then(
    () => showToast(`Copied ${lines.length} values.`, 'success'),
    () => showToast('Clipboard write failed.', 'error')
  );
};

// Duplicate values panel — groups of pages sharing an identical
// title / meta / H1 / body hash. Server-computed in app.py and
// shipped on the 'complete' event; falls back to client-side
// grouping for saved crawls missing the reports payload.
function _scRenderDuplicatesPanel(cat) {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('duplicates-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'duplicates-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  const spec = {
    '__dup_titles': { key: 'duplicate_titles', field: 'title',            label: 'title' },
    '__dup_metas':  { key: 'duplicate_metas',  field: 'meta_description', label: 'meta description' },
    '__dup_h1s':    { key: 'duplicate_h1s',    field: 'h1',               label: 'H1' },
    '__dup_bodies': { key: 'duplicate_bodies', field: 'body_hash',        label: 'body content (MD5)' },
  }[cat];
  if (!spec) return;

  let groups = ((window.crawlerReports || {})[spec.key]) || [];
  // Fallback: compute from crawlerResults when the server payload is absent
  // (saved crawls predating the reports field, or in-progress views).
  if (!groups.length && Array.isArray(crawlerResults) && crawlerResults.length) {
    const m = new Map();
    for (const r of crawlerResults) {
      if (r.is_pagination) continue;
      const v = (r[spec.field] || '').trim();
      if (!v) continue;
      const k = (cat === '__dup_bodies') ? v : v.toLowerCase();
      const list = m.get(k) || [];
      list.push(r.url || '');
      m.set(k, list);
    }
    groups = Array.from(m.entries())
      .filter(([, urls]) => urls.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k, urls]) => ({ value: (cat === '__dup_bodies') ? k.slice(0, 8) : k, urls }));
  }

  const pageCount = groups.reduce((n, g) => n + (g.urls || []).length, 0);

  if (!groups.length) {
    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
        <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">No duplicate ${escapeHtml(spec.label)}s found</div>
        <div style="font-size:.75rem;color:var(--text-muted);">Every crawled page has a unique ${escapeHtml(spec.label)}.</div>
      </div>`;
    main.appendChild(panel);
    return;
  }

  const summary = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">Duplicate ${escapeHtml(spec.label)}s</div>
      <div style="font-size:.75rem;color:var(--text-muted);line-height:1.55;">
        <b>${groups.length}</b> duplicate group${groups.length === 1 ? '' : 's'} covering <b>${pageCount}</b> page${pageCount === 1 ? '' : 's'}.
        Pages sharing the same ${escapeHtml(spec.label)} compete with each other for the same query — pick one canonical version or rewrite to differentiate.
      </div>
    </div>`;

  const body = `
    <div style="padding:0 16px 16px;">
      ${groups.map((g, i) => {
        const head = (cat === '__dup_bodies')
          ? `<span style="color:var(--text-muted);font-family:'SF Mono','Menlo',monospace;font-size:.7rem;">hash ${escapeHtml(g.value || '')}…</span>`
          : escapeHtml(g.value || '<empty>');
        return `
          <div style="margin-top:12px;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface);">
            <div style="padding:8px 12px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:.78rem;">
              <b>#${i + 1}</b> · ${head}
              <span style="color:var(--text-muted);margin-left:8px;">${g.urls.length} pages share this ${escapeHtml(spec.label)}</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:.76rem;">
              <tbody>
                ${g.urls.map(u => {
                  const safe = escapeHtml(u);
                  return `<tr data-url="${safe}"><td style="padding:5px 12px;border-top:1px solid var(--border);"><a href="${safe}" target="_blank" style="color:var(--accent);">${safe}</a></td></tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
      }).join('')}
    </div>`;

  panel.innerHTML = summary + body;
  main.appendChild(panel);
}

// Redirect Chains (2+ hops). Each chain wastes crawl budget and link
// equity — Google follows up to ~5 hops, after which the destination
// gets ignored. Fix by linking directly to the final URL.
function _scRenderRedirChainsPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('redir-chains-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'redir-chains-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  let chains = ((window.crawlerReports || {}).redirect_chains) || [];
  if (!chains.length) {
    chains = (crawlerResults || [])
      .filter(r => (r.redirect_hops || 0) >= 2)
      .map(r => ({ url: r.url, chain: r.redirect_chain || [], hops: r.redirect_hops || 0 }));
  }

  if (!chains.length) {
    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
        <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">No redirect chains detected</div>
        <div style="font-size:.75rem;color:var(--text-muted);">Every redirected URL goes to its destination in a single hop.</div>
      </div>`;
    main.appendChild(panel);
    return;
  }

  const summary = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">Redirect chains (2+ hops)</div>
      <div style="font-size:.75rem;color:var(--text-muted);line-height:1.55;">
        <b>${chains.length}</b> URL${chains.length === 1 ? '' : 's'} require multiple redirect hops to reach the final destination.
        Update internal links to point directly to the final URL — Google stops following after ~5 hops, and every hop wastes link equity.
      </div>
    </div>`;

  const body = `
    <div style="padding:0 16px 16px;">
      ${chains.map((c, i) => {
        const hops = (c.chain || []).map((step, idx) => {
          const url = (step && (step.url || step)) || '';
          const status = (step && step.status) || '';
          const safe = escapeHtml(url);
          return `<div style="display:flex;gap:8px;padding:4px 0;font-family:'SF Mono','Menlo',monospace;font-size:.72rem;">
            <span style="color:var(--text-muted);min-width:24px;">${idx + 1}.</span>
            <a href="${safe}" target="_blank" style="color:var(--accent);flex:1;word-break:break-all;">${safe}</a>
            ${status ? `<span style="color:${status >= 400 ? '#ef4444' : status >= 300 ? '#f59e0b' : '#22c55e'};font-weight:700;">${status}</span>` : ''}
          </div>`;
        }).join('');
        return `
          <div style="margin-top:12px;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface);">
            <div style="padding:8px 12px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:.78rem;">
              <b>#${i + 1}</b> · <span style="color:var(--text-muted);">starting URL</span>
              <a href="${escapeHtml(c.url || '')}" target="_blank" style="color:var(--accent);margin-left:6px;">${escapeHtml(c.url || '')}</a>
              <span style="color:var(--text-muted);margin-left:8px;">${c.hops} hop${c.hops === 1 ? '' : 's'}</span>
            </div>
            <div style="padding:8px 14px;">${hops || '<span style="color:var(--text-muted);font-size:.72rem;">no chain detail captured</span>'}</div>
          </div>`;
      }).join('')}
    </div>`;

  panel.innerHTML = summary + body;
  main.appendChild(panel);
}

// Response Codes — distribution across the crawl. Click a bucket to see
// the matching URLs (deferred for now: opens a filtered table view).
function _scRenderResponseCodesPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('response-codes-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'response-codes-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  const pages = crawlerResults || [];
  const byCode = new Map();
  for (const r of pages) {
    const c = r.status_code || 0;
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push(r.url || '');
  }
  const buckets = Array.from(byCode.entries()).sort((a, b) => a[0] - b[0]);
  const total = pages.length;
  const ok = pages.filter(r => r.status_code >= 200 && r.status_code < 300).length;
  const redir = pages.filter(r => r.status_code >= 300 && r.status_code < 400).length;
  const err4 = pages.filter(r => r.status_code >= 400 && r.status_code < 500).length;
  const err5 = pages.filter(r => r.status_code >= 500 && r.status_code < 600).length;

  const summary = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:6px;">Response code distribution</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:.78rem;align-items:center;">
        <span><b style="color:#22c55e;font-size:1.05rem;font-variant-numeric:tabular-nums;">${ok}</b> <span style="color:var(--text-muted);">2xx OK</span></span>
        <span><b style="color:#f59e0b;font-size:1.05rem;font-variant-numeric:tabular-nums;">${redir}</b> <span style="color:var(--text-muted);">3xx redirect</span></span>
        <span><b style="color:#ef4444;font-size:1.05rem;font-variant-numeric:tabular-nums;">${err4}</b> <span style="color:var(--text-muted);">4xx client error</span></span>
        <span><b style="color:#ef4444;font-size:1.05rem;font-variant-numeric:tabular-nums;">${err5}</b> <span style="color:var(--text-muted);">5xx server error</span></span>
        <span style="color:var(--text-muted);margin-left:auto;">${total} URLs total</span>
      </div>
    </div>`;

  const body = `
    <div style="padding:14px 16px;">
      <table class="crawler-grid" style="font-size:.78rem;">
        <colgroup><col style="width:120px"><col style="width:120px"><col style="width:120px"><col></colgroup>
        <thead><tr>
          <th><span class="th-label">Status code</span></th>
          <th><span class="th-label">Pages</span></th>
          <th><span class="th-label">% of crawl</span></th>
          <th><span class="th-label">Example URLs (first 3)</span></th>
        </tr></thead>
        <tbody>
          ${buckets.map(([code, urls]) => {
            const color = code >= 500 ? '#ef4444' : code >= 400 ? '#ef4444' : code >= 300 ? '#f59e0b' : '#22c55e';
            const pct = total ? (urls.length / total * 100).toFixed(1) : '0.0';
            const examples = urls.slice(0, 3).map(u => `<a href="${escapeHtml(u)}" target="_blank" style="color:var(--accent);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u)}</a>`).join('');
            return `<tr>
              <td style="color:${color};font-weight:700;">${code || '—'}</td>
              <td style="font-variant-numeric:tabular-nums;">${urls.length}</td>
              <td style="font-variant-numeric:tabular-nums;color:var(--text-muted);">${pct}%</td>
              <td style="overflow:hidden;">${examples}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  panel.innerHTML = summary + body;
  main.appendChild(panel);
}

// Deep Pages — pages 4+ clicks from the homepage. Hard for crawlers to
// discover, and a sign of weak internal linking. Suggests adding a link
// from a higher-traffic page to flatten the depth.
function _scRenderDeepPagesPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('deep-pages-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'deep-pages-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  const deep = (crawlerResults || []).filter(r => (r.depth || 0) >= 4)
    .sort((a, b) => (b.depth || 0) - (a.depth || 0));
  if (!deep.length) {
    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
        <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">No deep pages</div>
        <div style="font-size:.75rem;color:var(--text-muted);">Every crawled page is within 3 clicks of the homepage.</div>
      </div>`;
    main.appendChild(panel);
    return;
  }
  const summary = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">Deep pages (4+ clicks from home)</div>
      <div style="font-size:.75rem;color:var(--text-muted);line-height:1.55;">
        <b>${deep.length}</b> page${deep.length === 1 ? '' : 's'} buried 4 or more clicks deep. Search engines crawl deep pages less often
        and pass less PageRank to them. Add internal links from higher-traffic pages to flatten the site structure.
      </div>
    </div>`;
  const body = `
    <table class="crawler-grid" style="font-size:.78rem;">
      <colgroup><col style="width:90px"><col><col style="width:240px"></colgroup>
      <thead><tr>
        <th><span class="th-label">Depth</span></th>
        <th><span class="th-label">URL</span></th>
        <th><span class="th-label">Title</span></th>
      </tr></thead>
      <tbody>
        ${deep.map(r => {
          const u = escapeHtml(r.url || '');
          return `<tr data-url="${u}">
            <td style="text-align:center;font-weight:700;color:${r.depth >= 6 ? '#ef4444' : '#f59e0b'};">${r.depth || 0}</td>
            <td><a href="${u}" target="_blank" style="color:var(--accent);">${u}</a></td>
            <td style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.title || '')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  panel.innerHTML = summary + body;
  main.appendChild(panel);
}

// Hreflang implementation report — per-page declarations + validation.
// Checks the common mistakes that silently break international SEO:
//   • return tags (page A links to B with hreflang X, but B doesn't link
//     back to A — Google ignores both)
//   • duplicate or missing x-default
//   • invalid lang/region codes
//   • mismatched canonical (alt URL canonicals to itself, not to the cluster)
function _scRenderHreflangPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('hreflang-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'hreflang-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0;font-size:12px;';

  const pages = (crawlerResults || []).filter(r => Array.isArray(r.hreflang) && r.hreflang.length);
  if (!pages.length) {
    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
        <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">No hreflang declarations found</div>
        <div style="font-size:.75rem;color:var(--text-muted);line-height:1.55;">
          None of the crawled pages declare <code>&lt;link rel="alternate" hreflang="…"&gt;</code>.
          If this site is intentionally single-language, that's fine — hreflang is only required for multi-language / multi-region content.
        </div>
      </div>`;
    main.appendChild(panel);
    return;
  }

  // Validation pass
  const validCode = /^(x-default|[a-z]{2,3}(-[A-Z]{2})?)$/;
  const allDecls = new Map();   // url -> Set of (lang -> href)
  for (const r of pages) {
    const m = new Map();
    for (const e of r.hreflang) {
      if (e && e.lang && e.href) m.set(e.lang, e.href);
    }
    allDecls.set(r.url, m);
  }
  const issues = [];
  for (const r of pages) {
    const langs = new Set();
    let xDefault = 0;
    for (const e of r.hreflang) {
      if (!e || !e.lang) continue;
      if (e.lang === 'x-default') xDefault++;
      else langs.add(e.lang);
      if (!validCode.test(e.lang)) {
        issues.push({ url: r.url, kind: 'invalid_code', detail: `Invalid hreflang code: ${e.lang}` });
      }
    }
    if (xDefault > 1) issues.push({ url: r.url, kind: 'dup_x_default', detail: `${xDefault} x-default tags (should be exactly 0 or 1)` });
    // Return-tag check: every alternate URL we also crawled should list us back.
    for (const e of r.hreflang) {
      if (!e || !e.href || e.lang === 'x-default') continue;
      const other = allDecls.get(e.href);
      if (other && !Array.from(other.values()).includes(r.url)) {
        issues.push({ url: r.url, kind: 'no_return_tag', detail: `${e.href} (${e.lang}) doesn't link back to this URL` });
      }
    }
  }

  const summary = `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2);">
      <div style="font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;">Hreflang implementation</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:.78rem;align-items:center;line-height:1.55;">
        <span><b style="color:var(--text);font-size:1.05rem;font-variant-numeric:tabular-nums;">${pages.length}</b> <span style="color:var(--text-muted);">pages with hreflang</span></span>
        <span><b style="color:${issues.length ? '#ef4444' : '#22c55e'};font-size:1.05rem;font-variant-numeric:tabular-nums;">${issues.length}</b> <span style="color:var(--text-muted);">validation issues</span></span>
      </div>
    </div>`;

  const issuesBlock = issues.length ? `
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);">
      <div style="font-size:.8rem;font-weight:600;color:#991b1b;margin-bottom:8px;">Validation issues</div>
      <table style="width:100%;border-collapse:collapse;font-size:.74rem;">
        <thead><tr style="background:var(--surface2);">
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);">URL</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);">Issue</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);">Detail</th>
        </tr></thead>
        <tbody>
          ${issues.slice(0, 200).map(it => {
            const u = escapeHtml(it.url);
            const kindLabel = ({invalid_code:'Invalid code', dup_x_default:'Duplicate x-default', no_return_tag:'Missing return tag'}[it.kind]) || it.kind;
            return `<tr><td style="padding:5px 10px;border-bottom:1px solid var(--border);"><a href="${u}" target="_blank" style="color:var(--accent);">${u}</a></td><td style="padding:5px 10px;border-bottom:1px solid var(--border);color:#991b1b;font-weight:600;">${kindLabel}</td><td style="padding:5px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);">${escapeHtml(it.detail)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '';

  const declsBlock = `
    <div style="padding:14px 16px;">
      <div style="font-size:.8rem;font-weight:600;color:var(--text);margin-bottom:8px;">All hreflang declarations</div>
      ${pages.map(r => {
        const u = escapeHtml(r.url || '');
        return `
          <div style="margin-bottom:10px;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface);">
            <div style="padding:6px 12px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:.74rem;">
              <a href="${u}" target="_blank" style="color:var(--accent);">${u}</a>
              <span style="color:var(--text-muted);margin-left:8px;">${r.hreflang.length} alternate${r.hreflang.length === 1 ? '' : 's'}</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:.72rem;">
              <tbody>
                ${r.hreflang.map(e => {
                  const lang = escapeHtml(e.lang || '');
                  const href = escapeHtml(e.href || '');
                  const bad = !validCode.test(e.lang || '');
                  return `<tr>
                    <td style="padding:4px 12px;border-top:1px solid var(--border);font-family:'SF Mono','Menlo',monospace;width:120px;${bad?'color:#ef4444;font-weight:700;':''}">${lang}</td>
                    <td style="padding:4px 12px;border-top:1px solid var(--border);"><a href="${href}" target="_blank" style="color:var(--accent);">${href}</a></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
      }).join('')}
    </div>`;

  panel.innerHTML = summary + issuesBlock + declsBlock;
  main.appendChild(panel);
}

// Per-page schema breakdown: every crawled page with its schema-type
// chips, plus an aggregate "type X appears on Y pages" header. Helps
// spot missing-but-expected types (no Product on a WC product page,
// no LocalBusiness on a contact page, etc.). Pure crawler data — no
// AI calls — so it's fine to live in the public site-crawler.
function _renderSchemaByPagePanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('schema-by-page-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'schema-by-page-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0 14px 14px;font-size:12px;';
  const rows = (crawlerResults || []).filter(r => !r.error);
  if (!rows.length) {
    panel.innerHTML = '<div style="padding:20px;color:var(--text-muted);">No crawled pages yet.</div>';
    main.appendChild(panel);
    return;
  }
  // Reset filter state on every render
  window._scSchemaPageFilter = { types: new Set(), q: '' };
  const withSchema = rows.filter(r => Array.isArray(r.schema_types) && r.schema_types.length);
  const withoutSchema = rows.length - withSchema.length;
  const typeCounts = {};
  withSchema.forEach(r => r.schema_types.forEach(t => { typeCounts[t] = (typeCounts[t] || 0) + 1; }));
  const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const escapeHtml = _scEscapeHtml;
  // Clickable chips — toggle the type in window._scSchemaPageFilter.types
  const typeChip = (t, n) =>
    `<button type="button" data-schema-chip="${escapeHtml(t)}" onclick="_scSchemaPageToggleChip('${(t || '').replace(/'/g, "\\'")}')" style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;background:var(--surface);border:1px solid var(--border);border-radius:999px;font-size:11px;cursor:pointer;font-family:inherit;">
       <code style="font-size:10.5px;font-weight:600;color:var(--text);">${escapeHtml(t)}</code>
       <span style="color:var(--text-muted);">×${n}</span>
     </button>`;
  const summary = `
    <div style="padding:14px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;align-items:center;margin-bottom:10px;">
        <span><b style="color:#22c55e;font-size:16px;font-variant-numeric:tabular-nums;">${withSchema.length}</b> <span style="color:var(--text-muted);">with schema</span></span>
        <span><b style="color:#f59e0b;font-size:16px;font-variant-numeric:tabular-nums;">${withoutSchema}</b> <span style="color:var(--text-muted);">without</span></span>
        <span style="color:var(--text-muted);">·</span>
        <span><b style="color:var(--text);font-size:16px;font-variant-numeric:tabular-nums;">${Object.keys(typeCounts).length}</b> <span style="color:var(--text-muted);">unique type${Object.keys(typeCounts).length === 1 ? '' : 's'}</span></span>
        <span style="color:var(--text-muted);">·</span>
        <span style="color:var(--text-muted);">Showing <b id="sc-schema-page-count" style="color:var(--text);">${rows.length}</b> of ${rows.length}</span>
        <input id="sc-schema-page-url-filter" type="search" placeholder="Filter by URL…" oninput="_scSchemaPageSetQuery(this.value)"
               style="margin-left:auto;padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg, #fff);color:var(--text);font-size:12px;min-width:220px;" />
      </div>
      ${sortedTypes.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;color:var(--text-muted);margin-right:4px;">Click to filter:</span>
        ${sortedTypes.map(([t, n]) => typeChip(t, n)).join('')}
        <button type="button" id="sc-schema-chip-clear" onclick="_scSchemaPageClearFilters()" style="display:none;margin-left:6px;padding:2px 8px;background:none;border:1px solid var(--border);border-radius:999px;font-size:10.5px;color:var(--text-muted);cursor:pointer;">Clear filters</button>
      </div>` : ''}
    </div>`;
  const rowsHtml = rows.map(r => {
    const types = Array.isArray(r.schema_types) ? r.schema_types : [];
    const path = (r.url || '').replace(/^https?:\/\/[^\/]+/, '') || '/';
    const cells = types.length
      ? types.map(t => `<code style="display:inline-block;font-size:10.5px;background:var(--surface2);color:var(--text);padding:2px 7px;border-radius:4px;margin:1px;border:1px solid var(--border);">${escapeHtml(t)}</code>`).join(' ')
      : '<span style="color:#f59e0b;font-style:italic;font-size:11px;">no schema</span>';
    return `<tr data-types="${escapeHtml(types.join('|'))}" data-url-lower="${escapeHtml((r.url || '').toLowerCase())}">
      <td title="${escapeHtml(r.url)}"><a href="${r.url}" target="_blank" style="color:#4f46e5;">${escapeHtml(path)}</a></td>
      <td>${cells}</td>
    </tr>`;
  }).join('');
  panel.innerHTML = summary + _scGridTable('schema-by-page', [
    {label:'URL', width:520},
    {label:'Schema types'},
  ], rowsHtml, 'font-size:.78rem;');
  main.appendChild(panel);
  _scWireNestedGrids(panel);
}

// Schema-by-Page filter handlers — chips OR-filter by type, URL input
// substring-filters; both AND together. Mirrors seo-tool exactly so the
// behaviour is consistent across both crawlers.
window._scSchemaPageFilter = window._scSchemaPageFilter || { types: new Set(), q: '' };

window._scSchemaPageApplyFilter = function() {
  const state = window._scSchemaPageFilter;
  const tbody = document.querySelector('table.crawler-grid[data-resize-key="schema-by-page"] tbody');
  if (!tbody) return;
  const q = (state.q || '').toLowerCase().trim();
  let visible = 0;
  tbody.querySelectorAll('tr').forEach(tr => {
    const types = (tr.dataset.types || '').split('|').filter(Boolean);
    const url = tr.dataset.urlLower || '';
    let show = true;
    if (state.types.size > 0) show = Array.from(state.types).some(t => types.includes(t));
    if (show && q) show = url.includes(q);
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const countEl = document.getElementById('sc-schema-page-count');
  if (countEl) countEl.textContent = visible;
  const clearBtn = document.getElementById('sc-schema-chip-clear');
  if (clearBtn) clearBtn.style.display = (state.types.size > 0 || q) ? 'inline-block' : 'none';
};

window._scSchemaPageToggleChip = function(type) {
  const state = window._scSchemaPageFilter;
  if (state.types.has(type)) state.types.delete(type);
  else state.types.add(type);
  document.querySelectorAll('[data-schema-chip]').forEach(c => {
    const active = state.types.has(c.dataset.schemaChip);
    if (active) {
      c.style.background = 'var(--accent, #6366f1)';
      c.style.borderColor = 'var(--accent, #6366f1)';
      c.querySelectorAll('code, span').forEach(el => el.style.color = '#fff');
    } else {
      c.style.background = 'var(--surface)';
      c.style.borderColor = 'var(--border)';
      c.querySelectorAll('code').forEach(el => el.style.color = 'var(--text)');
      c.querySelectorAll('span').forEach(el => el.style.color = 'var(--text-muted)');
    }
  });
  window._scSchemaPageApplyFilter();
};

window._scSchemaPageSetQuery = function(q) {
  window._scSchemaPageFilter.q = q || '';
  window._scSchemaPageApplyFilter();
};

window._scSchemaPageClearFilters = function() {
  window._scSchemaPageFilter = { types: new Set(), q: '' };
  document.querySelectorAll('[data-schema-chip]').forEach(c => {
    c.style.background = 'var(--surface)';
    c.style.borderColor = 'var(--border)';
    c.querySelectorAll('code').forEach(el => el.style.color = 'var(--text)');
    c.querySelectorAll('span').forEach(el => el.style.color = 'var(--text-muted)');
  });
  const inp = document.getElementById('sc-schema-page-url-filter');
  if (inp) inp.value = '';
  window._scSchemaPageApplyFilter();
};

// =============================================================================
// Near-duplicate content detection (mirrors seo-tool, no Claude/AI).
// =============================================================================
function _scToggleNearDupCfg(checked) {
  const cfg = document.getElementById('crawler-neardup-cfg');
  if (cfg) cfg.style.display = checked ? '' : 'none';
}
window._scToggleNearDupCfg = _scToggleNearDupCfg;

// Show "Compare with non-JS HTML" sub-checkbox only when Render JS is on.
// Mirrors the seo-tool helper.
function _scToggleCompareNoJs(checked) {
  const row = document.getElementById('crawler-compare-no-js-row');
  if (row) row.style.display = checked ? '' : 'none';
  if (!checked) {
    const cb = document.getElementById('crawler-compare-no-js');
    if (cb) cb.checked = false;
  }
}
window._scToggleCompareNoJs = _scToggleCompareNoJs;

window.runNearDupAnalysis = async function() {
  const thresholdEl = document.getElementById('crawler-neardup-threshold');
  const excludeEl = document.getElementById('crawler-neardup-exclude');
  let threshold = parseFloat((thresholdEl && thresholdEl.value) || '90');
  if (!isFinite(threshold)) threshold = 90;
  threshold = Math.max(50, Math.min(99, threshold)) / 100;
  const excludeSelectors = (excludeEl && excludeEl.value) || '';
  const pages = (crawlerResults || [])
    .filter(r => r && r.body_text && !r.error)
    .map(r => ({
      url: r.url,
      body_text: r.body_text,
      canonical: r.canonical || '',
      indexable: r.indexable !== false,
    }));
  if (!pages.length) return;
  try {
    const resp = await fetch('/near-dup-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages, threshold, exclude_selectors: excludeSelectors }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'failed');
    window._ndPairs = data.pairs || [];
    window._ndStats = data.stats || {};
    const header = document.getElementById('nd-section-header');
    const cat = document.getElementById('nd-cat-content');
    const cnt = document.querySelector('#nd-cat-content [data-count="__nd_content"]');
    const n = window._ndPairs.length;
    if (header) header.style.display = (n > 0) ? '' : 'none';
    if (cat) cat.style.display = (n > 0) ? '' : 'none';
    if (cnt) cnt.textContent = String(n);
  } catch (e) {
    console.warn('[near-dup] analysis failed:', e);
  }
};

function _renderNearDupPanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  document.getElementById('near-dup-panel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'near-dup-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;';
  const pairs = window._ndPairs || [];
  const stats = window._ndStats || {};
  if (!pairs.length) {
    panel.innerHTML = `<div style="padding:20px;color:var(--text-muted,#64748b);font-size:13px;">
      Tick <b>Near-duplicate content</b> in the sidebar before crawling, or
      <button type="button" onclick="runNearDupAnalysis().then(() => selectCategory('__nd_content'))" style="background:var(--accent,#6366f1);color:#fff;border:none;border-radius:5px;padding:5px 12px;font-size:12px;cursor:pointer;margin:0 4px;">Run analysis now</button>
      against the current crawl.
    </div>`;
    main.appendChild(panel);
    return;
  }
  const tPct = Math.round((stats.threshold || 0.9) * 100);
  const rowsHtml = pairs.map(p => {
    const safeA = (p.url_a || '').replace(/'/g, "\\'");
    const safeB = (p.url_b || '').replace(/'/g, "\\'");
    const sim = Math.round((p.similarity || 0) * 100);
    const simColor = sim >= 95 ? '#dc2626' : sim >= 90 ? '#ea580c' : sim >= 85 ? '#d97706' : '#65a30d';
    const pathA = (p.url_a || '').replace(/^https?:\/\/[^\/]+/, '') || '/';
    const pathB = (p.url_b || '').replace(/^https?:\/\/[^\/]+/, '') || '/';
    const sample = p.shared_phrase_sample || '—';
    return `<tr>
      <td style="font-variant-numeric:tabular-nums;font-weight:700;color:${simColor};">${sim}%</td>
      <td title="${_scEscapeHtml(p.url_a)}"><a href="${p.url_a}" target="_blank" style="color:var(--accent,#6366f1);">${_scEscapeHtml(pathA)}</a></td>
      <td title="${_scEscapeHtml(p.url_b)}"><a href="${p.url_b}" target="_blank" style="color:var(--accent,#6366f1);">${_scEscapeHtml(pathB)}</a></td>
      <td style="color:var(--text-muted,#64748b);font-family:monospace;font-size:.7rem;" title="${_scEscapeHtml(sample)}">${_scEscapeHtml(sample)}</td>
      <td style="text-align:right;"><button type="button" onclick="openNdDiff('${safeA}','${safeB}')" style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:5px;padding:3px 9px;font-size:11px;color:var(--accent,#6366f1);cursor:pointer;">Compare →</button></td>
    </tr>`;
  }).join('');
  panel.innerHTML = `
    <div style="padding:12px 16px;border-bottom:1px solid var(--border,#e2e8f0);background:var(--surface2,#f8fafc);display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:12px;">
      <span><b style="font-size:16px;font-variant-numeric:tabular-nums;">${pairs.length}</b> <span style="color:var(--text-muted,#64748b);">pair${pairs.length === 1 ? '' : 's'} ≥ ${tPct}%</span></span>
      <span style="color:var(--text-muted,#64748b);">·</span>
      <span><b>${stats.docs_analysed || 0}</b> <span style="color:var(--text-muted,#64748b);">analysed</span></span>
      <span><b>${stats.docs_skipped || 0}</b> <span style="color:var(--text-muted,#64748b);">skipped</span></span>
      <span style="color:var(--text-muted,#64748b);">· took ${stats.took_ms || 0} ms</span>
      <button type="button" onclick="runNearDupAnalysis().then(() => selectCategory('__nd_content'))" style="margin-left:auto;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;">Re-run</button>
    </div>
    ${_scGridTable('near-dup', [
      {label:'Sim',           width:70},
      {label:'Page A',        width:340},
      {label:'Page B',        width:340},
      {label:'Shared sample'},
      {label:'',              width:100, alignRight:true},
    ], rowsHtml, 'font-size:.78rem;')}`;
  main.appendChild(panel);
  _scWireNestedGrids(panel);
}

window.openNdDiff = function(urlA, urlB) {
  const findRow = (u) => (crawlerResults || []).find(r => r.url === u);
  const a = findRow(urlA);
  const b = findRow(urlB);
  if (!a || !b) return;
  const pair = (window._ndPairs || []).find(p =>
    (p.url_a === urlA && p.url_b === urlB) || (p.url_a === urlB && p.url_b === urlA));
  const sim = pair ? Math.round((pair.similarity || 0) * 100) : 0;
  const ND_STOP = new Set(('a an the and or but is are was were be been being have has had do does did will would should could can to of in on at by for with about as into through this that these those i we you they it he she our your their its his her my not no so if than then too very just over under before after between from up down out off all any each most some other such only own same us me them who what where when why how').split(' '));
  const tokenise = (s) => (s || '').toLowerCase().match(/[a-z][a-z'\-]{1,}/g) || [];
  const tokensA = tokenise(a.body_text);
  const tokensB = tokenise(b.body_text);
  const counts = {};
  [...new Set(tokensA)].forEach(t => counts[t] = (counts[t] || 0) + 1);
  [...new Set(tokensB)].forEach(t => counts[t] = (counts[t] || 0) + 1);
  const filt = (toks) => toks.filter(t => !ND_STOP.has(t) && t.length > 1 && counts[t] >= 2);
  const fa = filt(tokensA);
  const fb = filt(tokensB);
  const shing = (toks, n=5) => {
    const s = new Set();
    for (let i = 0; i + n <= toks.length; i++) s.add(toks.slice(i, i + n).join(' '));
    return s;
  };
  const sa = shing(fa);
  const sb = shing(fb);
  const shared = new Set([...sa].filter(s => sb.has(s)));
  const sharedTokens = new Set();
  shared.forEach(g => g.split(' ').forEach(t => sharedTokens.add(t)));
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const renderBody = (text) => {
    if (!text) return '<em style="color:var(--text-muted,#64748b);">(no body text captured)</em>';
    const sentences = text.split(/(?<=[.!?])\s+/);
    return sentences.map(sent => {
      const words = (sent.toLowerCase().match(/[a-z][a-z'\-]{1,}/g) || []).filter(t => sharedTokens.has(t));
      const isShared = words.length >= 4;
      return isShared
        ? `<span style="background:rgba(34,197,94,0.18);color:#15803d;padding:0 2px;border-radius:2px;">${escapeHtml(sent)}</span>`
        : escapeHtml(sent);
    }).join(' ');
  };
  document.getElementById('nd-diff-similarity').textContent = `${sim}% similar`;
  document.getElementById('nd-diff-url-a').textContent = a.url;
  document.getElementById('nd-diff-url-b').textContent = b.url;
  document.getElementById('nd-diff-link-a').href = a.url;
  document.getElementById('nd-diff-link-b').href = b.url;
  document.getElementById('nd-diff-body-a').innerHTML = renderBody(a.body_text);
  document.getElementById('nd-diff-body-b').innerHTML = renderBody(b.body_text);
  document.getElementById('nd-diff-modal').style.display = 'flex';
};

window.closeNdDiff = function() {
  const modal = document.getElementById('nd-diff-modal');
  if (modal) modal.style.display = 'none';
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('nd-diff-modal');
    if (modal && modal.style.display === 'flex') closeNdDiff();
  }
});

function _renderSitemapPanel(cat) {
  const d = crawlerSitemap;
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  // Remove prior panel if any.
  const old = document.getElementById('sitemap-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'sitemap-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:0 14px 14px;font-size:12px;';
  if (!d) {
    panel.innerHTML = '<div style="padding:20px;color:#64748b;">Click <b>Analyse</b> in the sidebar to run sitemap analysis.</div>';
    main.appendChild(panel);
    return;
  }
  const reports = d.reports || {};
  const map = {
    '__sm_missing':    { key: 'missing_from_sitemap',     hint: 'These pages are indexable, return 200, and were reached by the crawl, but are NOT in the sitemap. Add them.' },
    '__sm_orphan':     { key: 'orphan_in_sitemap',        hint: 'In the sitemap and crawled, but no internal links point to them. Link to them from related pages.' },
    '__sm_only':       { key: 'sitemap_only',             label: 'Orphan Pages',  hint: 'These pages are in your sitemap but no internal links point to them anywhere on the site — visitors and Google\'s crawler can\'t reach them by clicking through. For each one, decide: <b>(1)</b> Not needed? Add <code>noindex</code> or delete the page (and remove from sitemap). <b>(2)</b> Needed? Add an internal link from a relevant page, or include it in your header/footer navigation.' },
    '__sm_noindex':    { key: 'non_indexable_in_sitemap', hint: 'In sitemap but flagged noindex. Remove from sitemap OR remove the noindex.' },
    '__sm_non200':     { key: 'non_200_in_sitemap',       hint: 'In sitemap but the URL returns 4xx/5xx. Remove from sitemap or fix the page.' },
    '__sm_redirects':  { key: 'redirects_in_sitemap',     hint: 'Replace with the canonical destination URL — having a 301/302 in the sitemap wastes crawl budget.' },
    '__sm_pagination': { key: 'pagination_in_sitemap',    hint: 'Google explicitly says do not include pagination URLs (/page/2/) in sitemaps.' },
  };
  const info = map[cat] || { key: '', hint: '' };
  const items = reports[info.key] || [];
  const sources = (d.sitemaps_found || []).map(s => `<a href="${s.url}" target="_blank" style="color:#4f46e5;">${s.url}</a> <span style="color:#64748b;">(${s.source})</span>`).join(' · ');
  const totals = d.totals || {};
  const warns = (d.warnings || []).map(w => `<div style="font-size:11px;color:#d97706;padding:4px 0;">⚠ ${w}</div>`).join('');
  const header = `
    <div style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:11px;">
      <div><b>Sitemap(s):</b> ${sources || '(none)'}</div>
      <div><b>Totals:</b> ${totals.urls_in_sitemap || 0} URLs in sitemap · ${totals.urls_in_crawl || 0} crawled · ${totals.sitemaps_walked || 0} sitemap files walked</div>
      ${warns}
    </div>
    <div style="padding:10px 0 4px;font-size:13px;font-weight:600;">${info.label || cat.replace('__sm_','').replace(/^./, c => c.toUpperCase())} (${items.length})</div>
    <div style="padding-bottom:8px;font-size:11px;color:#64748b;line-height:1.5;">${info.hint}</div>
  `;
  if (!items.length) {
    panel.innerHTML = header + '<div style="padding:14px 0;color:#16a34a;">✓ Nothing in this category.</div>';
    main.appendChild(panel);
    return;
  }
  const rows = items.map(it => {
    if (typeof it === 'string') return { url: it, meta: '' };
    const u = it.url || '';
    const meta = [
      it.lastmod      ? `lastmod ${it.lastmod}` : '',
      it.status_code  ? `${it.status_code}` : '',
      it.redirects_to ? `→ ${it.redirects_to}` : '',
      it.reason       ? it.reason : '',
    ].filter(Boolean).join(' · ');
    return { url: u, meta };
  });
  const hasMeta = rows.some(r => r.meta);
  const rowHtml = rows.map(r => `
    <tr data-url="${_scEscapeHtml(r.url)}">
      <td title="${_scEscapeHtml(r.url)}"><a href="${r.url}" target="_blank" style="color:#4f46e5;">${_scEscapeHtml(r.url)}</a></td>
      ${hasMeta ? `<td style="color:#94a3b8;" title="${_scEscapeHtml(r.meta)}">${_scEscapeHtml(r.meta)}</td>` : ''}
    </tr>
  `).join('');
  const cols = hasMeta
    ? [{label:'URL', width:560}, {label:'Details'}]
    : [{label:'URL', width:720}];
  panel.innerHTML = header + _scGridTable(`sitemap-${cat}`, cols, rowHtml, 'font-size:11px;');
  main.appendChild(panel);
  _scWireNestedGrids(panel);
}

function renderIssueInfo(cat) {
  const box = document.getElementById('issue-info-box');
  const meta = ISSUE_META[cat];
  if (!meta) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const sourcesHtml = meta.sources.length
    ? `<div class="sources">Sources: ${meta.sources.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${escapeHtml(t)}</a>`).join(' · ')}</div>`
    : '';
  box.innerHTML = `<div class="info-box" style="display:flex;align-items:flex-start;gap:9px;">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px;opacity:.7;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    <div style="flex:1;min-width:0;">
      <div style="font-weight:700;font-size:.73rem;margin-bottom:3px;">${escapeHtml(cat)}</div>
      <div>${escapeHtml(meta.why)}</div>
      ${sourcesHtml}
    </div>
  </div>`;
  box.style.display = '';
}

function updateCounts() {
  const counts = { all: crawlerResults.length, __err: 0, __warn: 0, __info: 0 };
  const sev = (i) => {
    const l = i.toLowerCase();
    if (/^missing (title|h1|canonical|meta description)|^http [45]|served over http|^mixed content|^noindex|^canonicalised/.test(l)) return 'error';
    if (/too (long|short)|imgs missing alt|images missing alt|thin content|multiple h1|h1 same as title|h1 identical|missing viewport|no schema|missing open graph|missing og:image|^slow |^url:|trailing slash|^redirect \(|www normalization|http→https/.test(l)) return 'warn';
    return 'info';
  };
  // Initialise category counts
  document.querySelectorAll('.ci-count, .sev-num').forEach(el => {
    const k = el.dataset.count;
    if (k && k !== 'all' && !counts.hasOwnProperty(k)) counts[k] = 0;
  });

  for (const page of crawlerResults) {
    const issues = page.issues || [];
    // Inclusive severity counts: a page contributes to every severity bucket
    // for which it has at least one issue. Matches the filter behaviour so
    // "Warnings: N" always equals the number of rows shown when clicked.
    if (issues.some(i => sev(i) === 'error')) counts.__err++;
    if (issues.some(i => sev(i) === 'warn')) counts.__warn++;
    if (issues.some(i => sev(i) === 'info')) counts.__info++;

    // Per-category counts: check each key against matchesCategory
    for (const key of Object.keys(counts)) {
      if (key === 'all' || key.startsWith('__')) continue;
      if (matchesCategory(page, key)) counts[key]++;
    }
  }
  // __schema_by_page count: pages that emit at least one schema type.
  // Lives outside the matchesCategory loop because it's a report view,
  // not a per-page filter.
  if ('__schema_by_page' in counts) {
    counts.__schema_by_page = (crawlerResults || []).filter(
      r => !r.error && Array.isArray(r.schema_types) && r.schema_types.length
    ).length;
  }
  // __all_images count: total unique image srcs across the crawl, with
  // third-party widget images filtered out. Mirrors the panel's row count.
  if ('__all_images' in counts) {
    const seen = new Set();
    for (const r of (crawlerResults || [])) {
      const data = Array.isArray(r.images_all_data) ? r.images_all_data : [];
      for (const img of data) {
        if (!img || !img.src) continue;
        if (typeof _isThirdPartyWidgetImage === 'function' && _isThirdPartyWidgetImage(img.src)) continue;
        seen.add(img.src);
      }
    }
    counts.__all_images = seen.size;
  }
  // __external_links count: total external link references (NOT unique URLs
  // — same Twitter share-URL in 50 footers is 50 audit decisions, not 1).
  // Tolerates older saved crawls where external_link_urls was the 3-tuple
  // [url, anchor, placement] without rel/target.
  if ('__external_links' in counts) {
    counts.__external_links = (crawlerResults || []).reduce(
      (n, r) => n + ((r.external_link_urls || []).filter(e => e && e[0]).length), 0);
  }
  // Bulk Reports counts. "All *" = pages with a value present (so the
  // tab badge tells you how many rows the report will have, not page count).
  // "Dup *" = number of duplicate GROUPS (matches the panel header), preferring
  // the server-computed reports payload and falling back to client-side
  // grouping so the sidebar isn't stuck at 0 on older saved crawls.
  const _pages = (crawlerResults || []).filter(r => !r.is_pagination);
  if ('__all_titles' in counts)     counts.__all_titles     = _pages.filter(r => r.title).length;
  if ('__all_metas' in counts)      counts.__all_metas      = _pages.filter(r => r.meta_description).length;
  if ('__all_h1s' in counts)        counts.__all_h1s        = _pages.filter(r => r.h1).length;
  if ('__all_canonicals' in counts) counts.__all_canonicals = _pages.filter(r => r.canonical).length;
  const _reps = window.crawlerReports || {};
  const _dupCount = (serverKey, field, ci) => {
    const fromServer = (_reps[serverKey] || []).length;
    if (fromServer) return fromServer;
    const m = new Map();
    for (const r of _pages) {
      const v = (r[field] || '').trim();
      if (!v) continue;
      const k = ci ? v.toLowerCase() : v;
      m.set(k, (m.get(k) || 0) + 1);
    }
    let n = 0;
    for (const v of m.values()) if (v > 1) n++;
    return n;
  };
  if ('__dup_titles' in counts) counts.__dup_titles = _dupCount('duplicate_titles', 'title',            true);
  if ('__dup_metas'  in counts) counts.__dup_metas  = _dupCount('duplicate_metas',  'meta_description', true);
  if ('__dup_h1s'    in counts) counts.__dup_h1s    = _dupCount('duplicate_h1s',    'h1',               true);
  if ('__dup_bodies' in counts) counts.__dup_bodies = _dupCount('duplicate_bodies', 'body_hash',        false);

  // Redirects & Status report counts. Redirect Chains and Response Codes
  // come straight from the server reports payload; Deep Pages and Hreflang
  // are derived per-page client-side so they work without server reports.
  if ('__redir_chains'   in counts) counts.__redir_chains   = (_reps.redirect_chains || (_pages.filter(r => (r.redirect_hops || 0) >= 2))).length;
  if ('__response_codes' in counts) counts.__response_codes = (_pages.filter(r => r.status_code)).length;
  if ('__deep'           in counts) counts.__deep           = _pages.filter(r => (r.depth || 0) >= 4).length;
  if ('__hreflang' in counts) {
    counts.__hreflang = _pages.filter(r => Array.isArray(r.hreflang) && r.hreflang.length).length;
    // Hide the Hreflang sidebar entry on sites that don't use it at all —
    // a permanent 0 is just noise. Show as soon as any page declares one.
    const cat = document.getElementById('hreflang-cat');
    if (cat) cat.style.display = counts.__hreflang ? '' : 'none';
  }

  // __js_diff count: pages with a meaningful diff (severity != 'none').
  // The sidebar entry stays hidden until the crawl actually compared, so
  // a "0" entry doesn't permanently sit in the list.
  if ('__js_diff' in counts) {
    const compared = (crawlerResults || []).filter(r => r && r.js_diff);
    const withDiff = compared.filter(r => r.js_diff.severity && r.js_diff.severity !== 'none');
    counts.__js_diff = withDiff.length;
    const cat = document.getElementById('js-diff-cat');
    if (cat) cat.style.display = compared.length ? '' : 'none';
  }

  document.querySelectorAll('.ci-count, .sev-num').forEach(el => {
    const k = el.dataset.count;
    if (k in counts) el.textContent = counts[k];
  });
  // Re-sort the sidebar so red errors with hits float to the top of each
  // section, amber warnings next, then "all clear ✓" rows last.
  _sortIssueSidebar();
}

// Re-order .ci-cat rows within each section of the Issues sidebar so the user
// sees actionable items first. Section labels (.cat-label, .ci-section-header,
// or inline-styled <div>) act as boundaries; rows are shuffled WITHIN each
// run, preserving the section structure.
//
// Sort tiers (lower = earlier):
//   0  err   + count > 0   (sorted desc by count)
//   1  warn  + count > 0   (sorted desc by count)
//   2  neutral + count > 0  (preserve original order)
//   3  err/warn + count = 0  (preserve order, marked data-clean for green tick)
//   4  neutral + count = 0  (preserve original order)
//
// Inline display:none stays sticky — sitemap/near-dup rows that aren't
// applicable yet are excluded so they don't shuffle when toggled later.
function _sortIssueSidebar() {
  const root = document.getElementById('issues-sidebar');
  if (!root) return;
  const isSectionLabel = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.classList.contains('cat-label')) return true;
    if (el.classList.contains('ci-section-header')) return true;
    // Inline-styled section heading: a <div> with no .ci-cat / .sev-grid.
    if (el.tagName === 'DIV' &&
        !el.classList.contains('ci-cat') &&
        !el.classList.contains('sev-grid') &&
        !el.classList.contains('sitemap-status') &&
        !el.querySelector('input, button, .sev-cell')) {
      const txt = (el.textContent || '').trim();
      return !!txt && !el.querySelector('.ci-cat');
    }
    return false;
  };
  const sevOf = (catEl) => {
    const c = catEl.querySelector('.ci-count');
    if (!c) return 'neutral';
    if (c.classList.contains('err'))  return 'red';
    if (c.classList.contains('warn')) return 'amber';
    return 'neutral';
  };
  const countOf = (catEl) => {
    const c = catEl.querySelector('.ci-count');
    const t = c ? (c.textContent || '').trim() : '';
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const kids = Array.from(root.children);
  const runs = [];
  let current = null;
  kids.forEach((el, i) => {
    if (isSectionLabel(el)) {
      if (current) runs.push(current);
      current = { afterIdx: i, items: [] };
      return;
    }
    if (!el.classList || !el.classList.contains('ci-cat')) {
      if (current) runs.push(current);
      current = null;
      return;
    }
    if (el.style && el.style.display === 'none') return;
    if (el.dataset.cat === 'all') return;
    if (!current) current = { afterIdx: -1, items: [] };
    current.items.push(el);
  });
  if (current) runs.push(current);

  for (const run of runs) {
    if (!run.items || run.items.length < 2) {
      (run.items || []).forEach(el => {
        const sev = sevOf(el);
        const n = countOf(el);
        if (n === 0 && (sev === 'red' || sev === 'amber')) el.dataset.clean = 'true';
        else delete el.dataset.clean;
      });
      continue;
    }
    const decorated = run.items.map((el, origIdx) => {
      const sev = sevOf(el);
      const n = countOf(el);
      let tier;
      if (n > 0 && sev === 'red')   tier = 0;
      else if (n > 0 && sev === 'amber') tier = 1;
      else if (n > 0)               tier = 2;
      else if (sev === 'red' || sev === 'amber') tier = 3;
      else                          tier = 4;
      if (n === 0 && (sev === 'red' || sev === 'amber')) el.dataset.clean = 'true';
      else delete el.dataset.clean;
      return { el, tier, count: n, origIdx };
    });
    decorated.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier <= 1) return b.count - a.count;
      return a.origIdx - b.origIdx;
    });
    const anchor = run.afterIdx >= 0 ? root.children[run.afterIdx] : null;
    let cursor = anchor;
    for (const { el } of decorated) {
      if (cursor && cursor.nextSibling !== el) {
        root.insertBefore(el, cursor.nextSibling);
      } else if (!cursor && root.firstChild !== el) {
        root.insertBefore(el, root.firstChild);
      }
      cursor = el;
    }
  }
}

function stopCrawl() {
  if (crawlerAbort) crawlerAbort.abort();
}

// =============================================================================
// Per-tab Export view + multi-sheet .xlsx workbook export.
// =============================================================================
// Mirrors seo-tool's _buildExportForCategory dispatcher: every supported
// crawler tab gets a CSV that's shaped for that tab. Categories absent from
// site-crawler's UI (no __inlinks/__anchors/__all_titles/__all_metas/
// __all_h1s/__all_canonicals/__redir_chains/__orphans/__response_codes) are
// not handled — the dispatcher falls through to the page-level summary.

function _scCsvCell(v) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function _scExportFilename(prefix, domain, ext) {
  const safeDomain = (domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/[^a-zA-Z0-9.-]/g, '');
  const today = new Date();
  const ts = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}-${String(today.getHours()).padStart(2,'0')}${String(today.getMinutes()).padStart(2,'0')}`;
  return [prefix, safeDomain, ts].filter(Boolean).join('-') + '.' + ext;
}

function _buildExportForCategory(cat) {
  if (!Array.isArray(crawlerResults) || !crawlerResults.length) return null;

  // All Images — every meaningful <img>, one row per (page, image)
  if (cat === '__all_images') {
    const rows = [];
    for (const r of crawlerResults) {
      const data = Array.isArray(r.images_all_data) ? r.images_all_data : [];
      for (const img of data) {
        if (!img || !img.src) continue;
        if (typeof _isThirdPartyWidgetImage === 'function' && _isThirdPartyWidgetImage(img.src)) continue;
        rows.push([
          r.url || '',
          img.src || '',
          (img.alt === undefined || img.alt === null) ? '' : img.alt,
          img.classification || '',
          r.title || '',
          r.h1 || '',
        ]);
      }
    }
    return { header: ['Page URL', 'Image Src', 'Alt', 'Classification', 'Page Title', 'Page H1'], rows };
  }

  // External Links — every off-domain link with rel + target.
  if (cat === '__external_links') {
    const rows = [];
    for (const r of crawlerResults) {
      const list = Array.isArray(r.external_link_urls) ? r.external_link_urls : [];
      for (const entry of list) {
        const url = entry[0] || '';
        if (!url) continue;
        const anchor    = entry[1] || '';
        const placement = entry[2] || '';
        const rel       = (entry[3] || '').toString();
        const target    = (entry[4] || '').toString();
        const nofollow  = /\bnofollow\b/.test(rel);
        const newTab    = target === '_blank';
        const noopener  = /\bnoopener\b/.test(rel);
        const risk = (!nofollow && !newTab) ? 'high'
                   : (!nofollow ? 'follow'
                   : (!newTab  ? 'samewindow' : 'ok'));
        rows.push([
          r.url || '',
          url,
          anchor,
          rel || '(none)',
          target || '(same window)',
          nofollow ? 'nofollow' : 'follow',
          newTab ? '_blank' : 'same window',
          noopener ? 'noopener' : '(no noopener)',
          risk,
          placement,
        ]);
      }
    }
    return {
      header: ['Source Page', 'External URL', 'Anchor', 'rel', 'target',
               'Follow status', 'Window', 'noopener', 'Risk', 'Placement'],
      rows,
    };
  }

  // Sitemap reports
  if (cat.startsWith('__sm_')) {
    const map = {
      '__sm_missing':   'missing_from_sitemap',
      '__sm_orphan':    'orphan_in_sitemap',
      '__sm_only':      'sitemap_only',
      '__sm_noindex':   'non_indexable_in_sitemap',
      '__sm_non200':    'non_200_in_sitemap',
      '__sm_redirects': 'redirects_in_sitemap',
      '__sm_pagination':'pagination_in_sitemap',
    };
    const reports = (crawlerSitemap && crawlerSitemap.reports) || {};
    const items = reports[map[cat]] || [];
    const rows = items.map(it => {
      if (typeof it === 'string') return [it, '', '', ''];
      return [
        it.url || '',
        it.status_code || '',
        it.lastmod || '',
        it.redirects_to || it.reason || '',
      ];
    });
    return { header: ['URL', 'Status', 'Lastmod', 'Notes'], rows };
  }

  // Near-duplicate content pairs
  if (cat === '__nd_content') {
    const pairs = window._ndPairs || [];
    const rows = pairs.map(p => [
      p.url_a || '',
      p.url_b || '',
      Math.round((p.similarity || 0) * 100),
      p.shared_phrase_sample || '',
    ]);
    return { header: ['URL A', 'URL B', 'Similarity %', 'Shared Sample'], rows };
  }

  // Schema by page
  if (cat === '__schema_by_page') {
    const rows = crawlerResults
      .filter(r => !r.error)
      .map(r => [
        r.url || '',
        Array.isArray(r.schema_types) ? r.schema_types.join(', ') : '',
        Array.isArray(r.schema_types) ? r.schema_types.length : 0,
        r.status_code || '',
      ]);
    return { header: ['URL', 'Schema Types', 'Count', 'Status'], rows };
  }

  // Sitemap visualisation is a tree, not tabular — caller already hides btn.
  if (cat === '__sitemap_viz') return null;

  // Inlinks-rich problem reports — one row per (source page, broken/redirected
  // target) so the user knows WHICH page to edit AND what anchor text to look
  // for. Without this, a 4xx export is just a list of URLs with no fix path.
  if (cat === 'HTTP' || cat === 'Redirect') {
    const filtered = crawlerResults.filter(d => matchesCategory(d, cat));
    const header = ['Source URL', 'Anchor Text', 'Target URL', 'Target Status', 'Target Title', 'Issue'];
    const rows = [];
    filtered.forEach(d => {
      const inlinks = (typeof getInlinksFor === 'function')
        ? getInlinksFor(d.url)
        : ((crawlerInlinks && (crawlerInlinks[d.url] || crawlerInlinks[d.url.replace(/\/$/, '')] || crawlerInlinks[d.url + '/'])) || []);
      const issueLabel = cat === 'HTTP'
        ? `Broken (${d.status_code || ''})`
        : (d.redirect_kind || 'Redirect');
      if (!inlinks.length) {
        rows.push(['', '', d.url, d.status_code || '', d.title || '', issueLabel]);
      } else {
        inlinks.forEach(e => {
          const src    = (typeof e === 'string') ? e : (e.source || '');
          const anchor = (typeof e === 'string') ? '' : (e.anchor || '');
          rows.push([src, anchor, d.url, d.status_code || '', d.title || '', issueLabel]);
        });
      }
    });
    return { header, rows };
  }

  // Default: page-level summary using matchesCategory.
  const filtered = (cat === 'all')
    ? crawlerResults.slice()
    : crawlerResults.filter(d => (typeof matchesCategory === 'function') ? matchesCategory(d, cat) : true);
  const header = ['URL', 'Status', 'Title', 'Title Length', 'Meta Description', 'Meta Length', 'H1', 'Word Count', 'Response (s)', 'Issues'];
  const rows = filtered.map(d => [
    d.url || '',
    d.status_code || '',
    d.title || '',
    d.title_len || 0,
    d.meta_description || '',
    d.meta_len || 0,
    d.h1 || '',
    d.word_count || 0,
    d.response_time || '',
    (d.issues || []).join(' | '),
  ]);
  return { header, rows };
}

function _crawlerExportViewLabel(cat, n) {
  const labels = {
    '__all_images':    `Export view (${n} image${n===1?'':'s'})`,
    '__external_links':`Export view (${n} external link${n===1?'':'s'})`,
    '__sm_missing':    `Export view (${n} missing-from-sitemap)`,
    '__sm_orphan':     `Export view (${n} orphan-in-sitemap)`,
    '__sm_only':       `Export view (${n} sitemap-only orphan${n===1?'':'s'})`,
    '__sm_noindex':    `Export view (${n} noindex in sitemap)`,
    '__sm_non200':     `Export view (${n} non-200 in sitemap)`,
    '__sm_redirects':  `Export view (${n} redirect${n===1?'':'s'} in sitemap)`,
    '__sm_pagination': `Export view (${n} pagination URL${n===1?'':'s'} in sitemap)`,
    '__nd_content':    `Export view (${n} near-dup pair${n===1?'':'s'})`,
    '__schema_by_page':`Export view (${n} schema row${n===1?'':'s'})`,
    'HTTP':            `Export view (${n} 4xx/5xx inlink${n===1?'':'s'})`,
    'Redirect':        `Export view (${n} redirect inlink${n===1?'':'s'})`,
  };
  return labels[cat] || `Export view (${n} row${n===1?'':'s'})`;
}

function _refreshCrawlerExportViewBtn() {
  const btn = document.getElementById('crawler-export-view-btn');
  if (!btn) return;
  if (!Array.isArray(crawlerResults) || !crawlerResults.length) {
    btn.style.display = 'none';
    return;
  }
  const cat = (typeof activeCategory === 'string') ? activeCategory : 'all';
  if (cat === 'all') { btn.style.display = 'none'; return; } // covered by .xlsx
  if (cat === '__sitemap_viz') { btn.style.display = 'none'; return; }
  const built = _buildExportForCategory(cat);
  if (!built || !built.rows.length) { btn.style.display = 'none'; return; }
  btn.style.display = 'inline-flex';
  const label = btn.querySelector('span') || btn;
  label.textContent = _crawlerExportViewLabel(cat, built.rows.length);
}

async function exportCrawlerView() {
  if (!crawlerResults.length) return;
  const btn = document.getElementById('crawler-export-view-btn');
  const lbl = btn ? btn.querySelector('span') : null;
  const orig = lbl ? lbl.textContent : '';
  if (btn) { btn.disabled = true; if (lbl) lbl.textContent = 'Exporting…'; }
  try {
    const cat = (typeof activeCategory === 'string') ? activeCategory : 'all';
    const built = _buildExportForCategory(cat);
    if (!built || !built.rows.length) {
      try { showToast('Nothing to export on this view.', 'info'); } catch {}
      return;
    }
    const csv = [built.header, ...built.rows].map(r => r.map(_scCsvCell).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const slug = (cat || 'view').replace(/^_+/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'view';
    let domain = '';
    try { domain = new URL(crawlerResults[0].url).hostname.replace(/^www\./, ''); } catch {}
    a.download = _scExportFilename('crawl-' + slug, domain, 'csv');
    a.click();
    URL.revokeObjectURL(a.href);
    try { showToast(`Exported ${built.rows.length} row${built.rows.length===1?'':'s'}`, 'success'); } catch {}
  } catch (e) {
    console.error('[exportCrawlerView]', e);
    try { showToast('Export failed', 'error'); } catch {}
  } finally {
    if (btn) { btn.disabled = false; if (lbl) lbl.textContent = orig; }
  }
}

async function exportCrawlerXlsx() {
  if (!crawlerResults.length) return;
  const btn = document.getElementById('crawler-export-xlsx-btn');
  const lbl = btn ? btn.querySelector('span') : null;
  if (btn) { btn.disabled = true; if (lbl) lbl.textContent = 'Exporting…'; }
  try {
    // Build extra sheets for every supported tab. Mirrors seo-tool's
    // exportCrawlerXlsx but only with categories site-crawler exposes.
    const extraSheets = [];
    const cats = [
      ['__all_images',    'All Images'],
      ['__external_links','External Links'],
      ['__schema_by_page','Schema by Page'],
      ['__nd_content',    'Near-Duplicate Pairs'],
      // Inlinks-rich problem reports — one row per (source page, broken/
      // redirected target) so users can fix the link AND know the anchor text.
      ['HTTP',            '4xx-5xx Inlinks'],
      ['Redirect',        'Redirect Inlinks'],
    ];
    for (const [cat, name] of cats) {
      try {
        const built = _buildExportForCategory(cat);
        if (built && built.rows && built.rows.length) {
          extraSheets.push({ name, header: built.header, rows: built.rows });
        }
      } catch (e) { console.warn('[xlsx] skipping', cat, e); }
    }
    // Sitemap sub-reports collapse into a single "Sitemap Issues" sheet.
    if (crawlerSitemap && crawlerSitemap.reports) {
      const smCats = [
        ['__sm_missing',    'Missing from sitemap'],
        ['__sm_orphan',     'Orphan in sitemap'],
        ['__sm_only',       'Sitemap-only orphan'],
        ['__sm_noindex',    'Noindex in sitemap'],
        ['__sm_non200',     'Non-200 in sitemap'],
        ['__sm_redirects',  'Redirect in sitemap'],
        ['__sm_pagination', 'Pagination in sitemap'],
      ];
      const smRows = [];
      for (const [cat, label] of smCats) {
        try {
          const b = _buildExportForCategory(cat);
          if (b && b.rows.length) b.rows.forEach(r => smRows.push([label, ...r]));
        } catch {}
      }
      if (smRows.length) {
        extraSheets.push({
          name: 'Sitemap Issues',
          header: ['Issue', 'URL', 'Status', 'Lastmod', 'Notes'],
          rows: smRows,
        });
      }
    }

    let domain = '';
    try { domain = new URL(crawlerResults[0].url).hostname.replace(/^www\./, ''); } catch {}

    const resp = await fetch('/export-crawl-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        results: crawlerResults,
        domain,
        extra_sheets: extraSheets,
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = _scExportFilename('crawl', domain, 'xlsx');
    a.click();
    URL.revokeObjectURL(a.href);
    const totalRows = extraSheets.reduce((n, s) => n + s.rows.length, 0);
    try { showToast(`Exported crawl — ${extraSheets.length} extra sheet${extraSheets.length===1?'':'s'} (${totalRows} rows)`, 'success'); } catch {}
  } catch (e) {
    console.error('[exportCrawlerXlsx]', e);
    try { showToast('Export failed: ' + e.message, 'error'); } catch {}
  } finally {
    if (btn) { btn.disabled = false; if (lbl) lbl.textContent = '.xlsx'; }
  }
}

// Export an XML sitemap of every 200-status indexable URL the crawl found.
// Mirrors the backend filter at /export-crawl-sitemap so the user sees an
// accurate URL count *before* the download triggers.
async function exportCrawlerSitemap() {
  if (!Array.isArray(crawlerResults) || !crawlerResults.length) return;
  const btn = document.getElementById('crawler-export-sitemap-btn');
  if (!btn) return;
  let domain = '';
  try { domain = new URL(crawlerResults[0].url).origin; } catch {}
  const eligible = crawlerResults.filter(r => {
    if (r.status_code !== 200) return false;
    if (r.error) return false;
    if (r.redirect_url) return false;
    if (r.indexable === false) return false;
    if (r.canonical_kind === 'canonicalised') return false;
    if (r.is_pagination) return false;
    const ct = (r.content_type || '').toLowerCase();
    if (ct && !ct.includes('html') && !ct.includes('xml')) return false;
    const u = (r.url || '').trim();
    if (!u || !(u.startsWith('http://') || u.startsWith('https://'))) return false;
    return true;
  });
  if (!eligible.length) {
    if (typeof showToast === 'function') showToast('No indexable 200 pages to include in sitemap', 'warning');
    else alert('No indexable 200 pages to include in sitemap');
    return;
  }
  const labelSpan = btn.querySelector('span');
  const origLabel = labelSpan ? labelSpan.textContent : '';
  if (labelSpan) labelSpan.textContent = `Exporting ${eligible.length}…`;
  btn.disabled = true;
  try {
    const resp = await fetch('/export-crawl-sitemap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: crawlerResults, domain })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    // Server returns either application/xml (single file) or application/zip
    // (>50K URLs split across child sitemaps + index). Pick the right
    // extension from the response's Content-Type.
    const ct = (resp.headers.get('Content-Type') || '').toLowerCase();
    const ext = ct.includes('zip') ? 'zip' : 'xml';
    const safeDomain = (domain || '').replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '');
    const ts = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ['sitemap', safeDomain, ts].filter(Boolean).join('-') + '.' + ext;
    a.click();
    URL.revokeObjectURL(a.href);
    if (typeof showToast === 'function') showToast(`Exported sitemap with ${eligible.length} URLs`, 'success');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Sitemap export failed', 'error');
    else alert('Sitemap export failed: ' + (e && e.message));
  }
  if (labelSpan) labelSpan.textContent = origLabel;
  btn.disabled = false;
}

function crawlFinished() {
  if (crawlerTimer) { clearInterval(crawlerTimer); crawlerTimer = null; }
  document.getElementById('crawler-start-btn').style.display = '';
  document.getElementById('crawler-stop-btn').style.display = 'none';
  const applyBtn = document.getElementById('crawler-apply-rules');
  if (applyBtn) applyBtn.disabled = true;
  crawlerCrawlId = null;
  clearBusy('site-crawler');
  if (typeof crawlerHideLimitBanner === 'function') crawlerHideLimitBanner();
  if (typeof crawlerHideQueuePanel === 'function') crawlerHideQueuePanel();
  const queuedEl = document.getElementById('cs-queued');
  if (queuedEl) queuedEl.textContent = '0';
  // Show sitemap export button now that the crawl has produced results.
  if (Array.isArray(crawlerResults) && crawlerResults.length) {
    const _smBtn = document.getElementById('crawler-export-sitemap-btn');
    if (_smBtn) _smBtn.style.display = 'inline-flex';
    const _xBtn = document.getElementById('crawler-export-xlsx-btn');
    if (_xBtn) _xBtn.style.display = 'inline-flex';
  }
  // Sitemap analysis is opt-in via the 'Sitemap analysis' checkbox.
  if (Array.isArray(crawlerResults) && crawlerResults.length) {
    const _smCheckbox = document.getElementById('crawler-run-sitemap');
    if (_smCheckbox && _smCheckbox.checked && typeof window.analyseSitemap === 'function') {
      setTimeout(() => {
        try { window.analyseSitemap(); } catch (e) { console.warn('auto-analyseSitemap failed:', e); }
      }, 1500);
    }
    // Near-duplicate content analysis — opt-in via 'Near-duplicate content' checkbox.
    const _ndCheckbox = document.getElementById('crawler-run-neardup');
    if (_ndCheckbox && _ndCheckbox.checked && typeof window.runNearDupAnalysis === 'function') {
      setTimeout(() => {
        try { window.runNearDupAnalysis(); } catch (e) { console.warn('auto-runNearDup failed:', e); }
      }, 1800);
    }
  }
}

// Auto-fetch the live robots.txt for the URL the user typed and show it
// in the URL filters panel. Replaces the old CMS-detection banner —
// instead of guessing exclude patterns from the platform, just SHOW what
// robots.txt says so the user can see and add their own rules below.
let _crawlerRobotsLast = '';
async function crawlerFetchRobots() {
  const inp = document.getElementById('crawler-url');
  const out = document.getElementById('crawler-robots-preview');
  const status = document.getElementById('crawler-robots-status');
  if (!inp || !out) return;
  const url = (inp.value || '').trim();
  if (!url) {
    out.value = '';
    if (status) status.textContent = '';
    _crawlerRobotsLast = '';
    return;
  }
  let origin = '';
  try { origin = new URL(url.startsWith('http') ? url : 'https://' + url).origin; } catch { return; }
  if (origin === _crawlerRobotsLast) return;
  _crawlerRobotsLast = origin;
  if (status) status.textContent = 'fetching…';
  try {
    const r = await fetch('/fetch-robots-txt?url=' + encodeURIComponent(origin));
    const d = await r.json();
    if (d.error) {
      out.value = '';
      if (status) status.textContent = `error: ${d.error}`;
      return;
    }
    if (d.status >= 400) {
      out.value = `# ${d.url} returned HTTP ${d.status} — site has no robots.txt or it's blocked.`;
      if (status) status.textContent = `HTTP ${d.status}`;
      return;
    }
    out.value = d.content || '# (empty robots.txt)';
    if (status) status.textContent = `${d.length} chars · HTTP ${d.status}`;
  } catch (e) {
    out.value = '';
    if (status) status.textContent = 'fetch failed';
  }
}

(function _wireRobotsAutoFetch() {
  const inp = document.getElementById('crawler-url');
  if (!inp) return;
  let t = null;
  inp.addEventListener('input', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => crawlerFetchRobots(), 600);
  });
  inp.addEventListener('blur', crawlerFetchRobots);
  if (inp.value && inp.value.trim()) setTimeout(crawlerFetchRobots, 200);
})();

function applyCrawlRules() {
  const msg = document.getElementById('crawler-apply-rules-msg');
  if (!crawlerCrawlId) {
    if (msg) { msg.textContent = 'No active crawl.'; msg.style.color = '#dc2626'; }
    return;
  }
  const includePatterns = (document.getElementById('crawler-include')?.value || '').trim();
  const excludePatterns = (document.getElementById('crawler-exclude')?.value || '').trim();
  if (msg) { msg.textContent = 'Applying…'; msg.style.color = ''; }
  fetch('/crawl/update-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crawl_id: crawlerCrawlId, include_patterns: includePatterns, exclude_patterns: excludePatterns })
  }).then(r => r.json().then(j => ({ ok: r.ok, body: j }))).then(({ ok, body }) => {
    if (!ok || !body.ok) {
      if (msg) { msg.textContent = body.error || 'Failed to apply.'; msg.style.color = '#dc2626'; }
      return;
    }
    const ex = (body.exclude || []).length;
    const inc = (body.include || []).length;
    if (msg) { msg.textContent = `Applied — ${ex} exclude, ${inc} include rule${(ex+inc)===1?'':'s'} active.`; msg.style.color = '#059669'; }
  }).catch(() => {
    if (msg) { msg.textContent = 'Network error.'; msg.style.color = '#dc2626'; }
  });
}

// Slider hook — updates the label and toggles the under-0.4s warning.
// While a crawl is running, also pushes the new delay to /crawl/update-rules
// (debounced 250ms) so the host throttler picks it up before the next request.
let _crawlerSpeedPushTimer = null;
function crawlerOnSpeedChange(v) {
  const lbl = document.getElementById('crawler-speed-label');
  if (lbl) lbl.textContent = v + 's';
  const warn = document.getElementById('crawler-delay-warn');
  if (warn) warn.style.display = parseFloat(v) < 0.4 ? 'block' : 'none';
  if (!crawlerCrawlId) return;  // not crawling — start payload will carry it
  if (_crawlerSpeedPushTimer) clearTimeout(_crawlerSpeedPushTimer);
  _crawlerSpeedPushTimer = setTimeout(() => {
    const msg = document.getElementById('crawler-apply-rules-msg');
    fetch('/crawl/update-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crawl_id: crawlerCrawlId, crawl_delay: parseFloat(v) }),
    }).then(r => r.json().then(j => ({ ok: r.ok, body: j }))).then(({ ok, body }) => {
      if (!ok || !body.ok) return;  // silent — slider is informational, not modal
      if (msg) { msg.textContent = `Delay updated → ${body.crawl_delay}s (live).`; msg.style.color = '#059669'; }
    }).catch(() => {});
  }, 250);
}

function scFilterByUrl(q) {
  const term = (q || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#crawler-tbody tr[data-url]');
  rows.forEach(row => {
    const match = !term || (row.dataset.url || '').toLowerCase().includes(term);
    row.style.display = match ? '' : 'none';
    const next = row.nextElementSibling;
    if (next && !next.dataset.url) next.style.display = match ? '' : 'none';
  });
  const clearBtn = document.getElementById('sc-url-search-clear');
  if (clearBtn) clearBtn.style.display = term ? '' : 'none';
}

// Bulk re-crawl every URL currently visible in the detail panel — i.e.
// every row that matches the active category AND survives the URL filter.
let _scBulkRecrawlRunning = false;
window.scBulkRecrawlVisible = async function(btn) {
  if (_scBulkRecrawlRunning) return;
  const rows = Array.from(document.querySelectorAll('#crawler-tbody tr[data-url]'))
    .filter(r => r.style.display !== 'none');
  const urls = [...new Set(rows.map(r => r.dataset.url).filter(Boolean))];
  if (!urls.length) { alert('No rows to re-crawl.'); return; }
  if (!confirm(`Re-crawl ${urls.length} URL${urls.length === 1 ? '' : 's'} now?\n\nEach page is fetched fresh from the live site, so this can take a while on large batches.`)) return;

  _scBulkRecrawlRunning = true;
  const label = document.getElementById('crawler-bulk-recrawl-label');
  const startedAt = performance.now();
  let ok = 0, errors = 0;
  if (btn) btn.disabled = true;
  rows.forEach(r => { r.style.opacity = '0.55'; });

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (label) label.textContent = `Re-crawling ${i + 1}/${urls.length}…`;
      const tr = document.querySelector(`#crawler-tbody tr[data-url="${(window.CSS && CSS.escape) ? CSS.escape(url) : url.replace(/"/g, '\\"')}"]`);
      if (tr) {
        tr.style.opacity = '1';
        tr.style.background = 'rgba(234,179,8,0.18)';
        try { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
      }
      try {
        const resp = await fetch('/recrawl-url', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ url })
        });
        const fresh = await resp.json();
        if (fresh.error) { errors++; }
        else {
          const idx = (crawlerResults || []).findIndex(r => r.url === url);
          if (idx >= 0) {
            fresh.depth = crawlerResults[idx].depth;
            crawlerResults[idx] = fresh;
          }
          ok++;
        }
      } catch (e) { errors++; }
    }
  } finally {
    _scBulkRecrawlRunning = false;
    if (btn) btn.disabled = false;
    // Re-render the active category — fixed pages drop out automatically.
    const activeCat = document.querySelector('.ci-cat.active');
    if (activeCat && activeCat.dataset.cat && typeof window.selectCategory === 'function') {
      window.selectCategory(activeCat.dataset.cat);
    }
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const note = document.createElement('div');
    note.textContent = `Re-crawled ${ok}/${urls.length} in ${elapsed}s${errors ? ` · ${errors} errors` : ''}.`;
    note.style.cssText = `position:fixed;bottom:80px;right:20px;background:${errors ? '#ef4444' : '#22c55e'};color:#fff;padding:8px 14px;border-radius:6px;font-size:.8rem;z-index:9999;pointer-events:none;`;
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 3500);
  }
};

// Column sort: click any header to sort ASC, click again to flip DESC.
let _scSortCol = null;
let _scSortAsc = true;
const _SC_SORT_KEYS = ['url','status_code','redirect_url','__inlinks_count','title','title_len','meta_description','h1','word_count','response_time','issues'];
function _scSortRows(rows) {
  const key = _SC_SORT_KEYS[_scSortCol];
  if (!key) return rows;
  return rows.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'issues') { va = (va||[]).length; vb = (vb||[]).length; }
    if (key === '__inlinks_count') { va = _scLookupInlinks(a.url).length; vb = _scLookupInlinks(b.url).length; }
    if (typeof va === 'string') return _scSortAsc ? (va||'').localeCompare(vb||'') : (vb||'').localeCompare(va||'');
    return _scSortAsc ? (va||0) - (vb||0) : (vb||0) - (va||0);
  });
}
window.scSortTable = function(col) {
  if (_scSortCol === col) _scSortAsc = !_scSortAsc;
  else { _scSortCol = col; _scSortAsc = true; }
  // Re-render the active category with the new sort applied.
  if (typeof activeCategory !== 'undefined' && activeCategory && typeof window.selectCategory === 'function') {
    window.selectCategory(activeCategory);
  }
  document.querySelectorAll('.sc-sort-ind').forEach(el => {
    if (parseInt(el.dataset.col, 10) === col) el.textContent = _scSortAsc ? '↑' : '↓';
    else el.textContent = '';
  });
};

async function scRecrawlUrl(btn, url) {
  if (btn) { btn.style.opacity = '0.35'; btn.disabled = true; }
  try {
    const resp = await fetch('/recrawl-url', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ url })
    });
    const fresh = await resp.json();
    if (fresh.error) { console.warn('Recrawl error:', fresh.error); return; }
    const idx = (crawlerResults || []).findIndex(r => r.url === url);
    if (idx >= 0) {
      fresh.depth = crawlerResults[idx].depth;
      crawlerResults[idx] = fresh;
    }
    const activeCat = document.querySelector('.cat-item.active');
    if (activeCat) activeCat.click();
    const note = document.createElement('div');
    note.textContent = '✓ Re-crawled: ' + (url.replace(/^https?:\/\/[^/]+/, '') || url);
    note.style.cssText = 'position:fixed;bottom:80px;right:20px;background:#22c55e;color:#fff;padding:8px 14px;border-radius:6px;font-size:.8rem;z-index:9999;pointer-events:none;';
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 3000);
  } catch(e) {
    console.error('Recrawl failed:', e);
  } finally {
    if (btn) { btn.style.opacity = '1'; btn.disabled = false; }
  }
}

// Multiple H1s view expands the single H1 column into one column per H1
// found on the worst-offending page so users can see every conflicting
// heading inline instead of clicking each row. Active only in that view;
// passing n<=1 restores the single-column layout.
let _scMultiH1N = 0;
function _scApplyMultiH1Columns(n) {
  const want = (n > 1) ? n : 0;
  if (want === _scMultiH1N) return;
  _scMultiH1N = want;
  const tbl = document.getElementById('crawler-table');
  if (!tbl) return;
  const colgroup = tbl.querySelector('colgroup');
  const headerRow = tbl.querySelector('thead tr');
  if (!colgroup || !headerRow) return;
  // Drop any prior dynamic H1 cols/ths
  colgroup.querySelectorAll('col[data-h1-extra="1"]').forEach(el => el.remove());
  headerRow.querySelectorAll('th[data-h1-extra="1"]').forEach(el => el.remove());
  const h1Col = colgroup.querySelector('col[data-col="h1"]');
  const h1Th = headerRow.querySelector('th[data-col-idx="7"]');
  if (!h1Col || !h1Th) return;
  if (want > 1) {
    h1Th.querySelector('.th-label').innerHTML = 'H1 (1) <span class="sc-sort-ind" data-col="7"></span>';
    for (let i = 2; i <= want; i++) {
      const col = document.createElement('col');
      col.setAttribute('data-col', 'h1');
      col.setAttribute('data-h1-extra', '1');
      col.style.width = '170px';
      h1Col.insertAdjacentElement('afterend', col);
      const th = document.createElement('th');
      th.setAttribute('data-col', 'h1');
      th.setAttribute('data-h1-extra', '1');
      th.innerHTML = `<span class="th-label">H1 (${i})</span>`;
      h1Th.insertAdjacentElement('afterend', th);
    }
  } else {
    h1Th.querySelector('.th-label').innerHTML = 'H1 <span class="sc-sort-ind" data-col="7"></span>';
  }
  if (typeof _scSyncTableWidth === 'function') _scSyncTableWidth();
}
// Redirect destination cell. Shows the full target URL of a 3xx redirect.
// Default-hidden for most categories; shown in the Redirect view.
function _scRedirToCell(d) {
  const to = d.redirect_url || '';
  const hops = d.redirect_hops || 0;
  if (!to) return '<td data-col="redirto"><em style="color:#94a3b8">—</em></td>';
  const safe = escapeHtml(to);
  const hopBadge = hops > 1 ? ` <span style="color:var(--text-muted);font-size:.7rem">(${hops} hops)</span>` : '';
  return `<td data-col="redirto" title="${safe}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safe}${hopBadge}</td>`;
}
// Inlinks count cell — number of internal pages linking to this URL.
// Useful in Redirect view to show which redirects still have inbound link debt.
function _scInlinksCell(d) {
  const n = (typeof _scLookupInlinks === 'function') ? _scLookupInlinks(d.url).length : 0;
  if (!n) return '<td data-col="inlinks" style="text-align:center;color:#94a3b8">0</td>';
  return `<td data-col="inlinks" style="text-align:center;font-weight:600">${n}</td>`;
}
function _scH1Cells(d) {
  if (_scMultiH1N > 1) {
    const list = d.h1_list || (d.h1 ? [d.h1] : []);
    const cells = [];
    for (let i = 0; i < _scMultiH1N; i++) {
      const v = list[i];
      cells.push(`<td data-col="h1" title="${escapeHtml(v||'')}">${v ? escapeHtml(v) : '<em style="color:#94a3b8">—</em>'}</td>`);
    }
    return cells.join('');
  }
  return `<td data-col="h1" title="${escapeHtml(d.h1||'')}">${d.h1 ? escapeHtml(d.h1) : '<em style="color:#ef4444">missing</em>'}</td>`;
}

function _scSetColumns(cat) {
  const table = document.getElementById('crawler-table');
  if (!table) return;
  const all = ['redirto','inlinks','title','tlen','meta','h1','words','speed'];
  table.classList.remove(...all.map(c => 'hide-col-' + c));
  const show = (cols) => {
    table.classList.add(...all.filter(c => !cols.includes(c)).map(c => 'hide-col-' + c));
    _scSyncTableWidth();
  };
  if (cat === 'Missing meta description') return show(['url','status','title','meta','issues']);
  if (cat === 'Meta desc too long' || cat === 'Meta desc too short') return show(['url','status','meta','issues']);
  if (cat === 'Missing title') return show(['url','status','title','tlen','h1','issues']);
  if (cat === 'Title too long' || cat === 'Title too short') return show(['url','status','title','tlen','issues']);
  if (cat === 'Missing H1' || cat === 'Multiple H1s') return show(['url','status','h1','issues']);
  if (cat === 'H1 identical to title tag') return show(['url','status','title','h1','issues']);
  if (cat === 'Thin content') return show(['url','status','words','issues']);
  if (cat === 'Slow') return show(['url','status','speed','issues']);
  if (cat === 'Redirect') return show(['url','status','redirto','inlinks','issues']);
  // Image alt is image-level, not page-level — page Title is just noise on
  // this view. Mirrors seo-tool's treatment.
  if (cat === 'imgs missing alt') return show(['url','status','issues']);
  // Severity views (Errors / Warnings / Info) — without an explicit show()
  // every column renders, pushing Issues off the right edge and forcing a
  // horizontal scroll just to see what's wrong.
  if (cat === '__err' || cat === '__warn' || cat === '__info') return show(['url','status','title','issues']);
  if (cat !== 'all' && !cat.startsWith('__')) return show(['url','status','title','issues']);
  _scSyncTableWidth();
}

// Drag-select + right-click copy for ANY tbody whose <tr>s carry data-url.
// Was previously hardcoded to #crawler-tbody, so report panels (sitemap
// orphans, all values, etc.) had no way to copy URLs in bulk. Now any
// renderer that emits <tr data-url="…"> inside a <tbody> opts in
// automatically. Selection is scoped to the tbody the drag started in
// so dragging across two tables doesn't merge them.
(function() {
  let dragging = false;
  let startRow = null;
  let lastRow = null;
  let scopeTbody = null;

  function getRow(el) {
    if (!el) return null;
    const tr = el.closest('tr[data-url]');
    if (!tr) return null;
    if (!tr.closest('tbody')) return null;
    return tr;
  }

  function clearSelection(scope) {
    const root = scope || document;
    root.querySelectorAll('tr.cr-selected').forEach(r => r.classList.remove('cr-selected'));
  }

  function applySelection(a, b) {
    if (!a || !b) return;
    const tbody = a.closest('tbody');
    if (!tbody || b.closest('tbody') !== tbody) return;
    const rows = Array.from(tbody.querySelectorAll(':scope tr[data-url]'))
      .filter(r => r.style.display !== 'none');
    const ia = rows.indexOf(a), ib = rows.indexOf(b);
    if (ia < 0 || ib < 0) return;
    const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
    rows.forEach((r, i) => r.classList.toggle('cr-selected', i >= lo && i <= hi));
  }

  function scToast(msg) {
    const n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText = 'position:fixed;bottom:80px;right:20px;background:#22c55e;color:#fff;padding:8px 14px;border-radius:6px;font-size:.8rem;z-index:9999;pointer-events:none;';
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2500);
  }

  document.addEventListener('mousedown', e => {
    const row = getRow(e.target);
    if (!row) return;
    if (e.button !== 0) return;
    if (e.target.closest('button,a,input,select')) return;
    dragging = true;
    startRow = row;
    lastRow = row;
    scopeTbody = row.closest('tbody');
    clearSelection(scopeTbody);
    row.classList.add('cr-selected');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const row = getRow(e.target);
    if (!row || row === lastRow) return;
    if (row.closest('tbody') !== scopeTbody) return;
    lastRow = row;
    clearSelection(scopeTbody);
    applySelection(startRow, row);
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  // Double-click any cell in a selectable tbody to expand it (wrap the
  // full value, drop the ellipsis) and auto-select for easy copy.
  document.addEventListener('dblclick', e => {
    const td = e.target.closest('td');
    if (!td) return;
    const tbody = td.closest('tbody');
    if (!tbody || !tbody.querySelector('tr[data-url]')) return;
    if (e.target.closest('button,a,input,select,svg')) return;
    e.preventDefault();
    td.classList.toggle('cs-cell-expanded');
    if (td.classList.contains('cs-cell-expanded')) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(td);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
    } else {
      try { window.getSelection().removeAllRanges(); } catch {}
    }
  });

  document.addEventListener('contextmenu', e => {
    const targetRow = getRow(e.target);
    const targetTbody = targetRow ? targetRow.closest('tbody') : (e.target.closest && e.target.closest('tbody'));
    if (!targetTbody) return;
    const selected = Array.from(targetTbody.querySelectorAll('tr.cr-selected[data-url]'));
    if (!selected.length) return;
    e.preventDefault();

    const old = document.getElementById('cr-ctx-menu');
    if (old) old.remove();

    const urls = selected.map(r => r.dataset.url);
    const menu = document.createElement('div');
    menu.id = 'cr-ctx-menu';
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:9999;min-width:200px;overflow:hidden;font-size:12px;`;

    // Clipboard with execCommand fallback + always-fires toast. On HTTPS or
    // localhost navigator.clipboard works; on insecure / cross-origin pages
    // (or if focus left the doc) it can reject — fall back to a hidden
    // textarea + execCommand. Always show feedback so the user sees the
    // click registered, even if the copy itself failed.
    // Two-stage copy: try execCommand first synchronously inside the user
    // gesture (most reliable, esp. for multi-line). If that fails, fall back
    // to navigator.clipboard.writeText. Previously we tried clipboard first
    // and the async rejection lost the user-gesture context, so the textarea
    // fallback only ever wrote a single line on some browsers.
    const copyText = (text, ok, fail) => {
      const done = (success) => scToast(success ? ok : (fail || 'Copy failed — clipboard blocked.'));
      let copied = false;
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;';
        document.body.appendChild(ta);
        const prevActive = document.activeElement;
        ta.focus();
        ta.setSelectionRange(0, text.length);
        try { copied = document.execCommand('copy'); } catch { copied = false; }
        ta.remove();
        if (prevActive && prevActive.focus) { try { prevActive.focus(); } catch {} }
      } catch { copied = false; }
      if (copied) { done(true); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
          return;
        }
      } catch {}
      done(false);
    };

    const items = [
      { label: `Copy ${urls.length} URL${urls.length > 1 ? 's' : ''}`, action: () => copyText(urls.join('\n'), `Copied ${urls.length} URL${urls.length > 1 ? 's' : ''}.`) },
      { label: 'Copy as comma-separated', action: () => copyText(urls.join(', '), 'Copied as comma-separated.') },
      { label: 'Clear selection', action: () => clearSelection(targetTbody) },
    ];

    items.forEach(item => {
      const btn = document.createElement('button');
      btn.textContent = item.label;
      btn.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 14px;background:none;border:none;cursor:pointer;color:var(--text);font-size:12px;';
      btn.onmouseover = () => btn.style.background = 'var(--surface2)';
      btn.onmouseout  = () => btn.style.background = 'none';
      // Always close the menu, regardless of whether the action itself
      // succeeded or threw — prevents the menu sticking around when the
      // clipboard write rejects.
      btn.onclick = () => {
        try { item.action(); } catch (err) { console.error('ctx-menu action failed', err); }
        menu.remove();
      };
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  });
})();

// =============================================================================
// Save / Load / Compare crawl sessions  (port of seo-tool's save+compare)
// Crawls are persisted to ~/.site-crawler-crawls/ on the host — never committed.
// =============================================================================
if (typeof window.showToast !== 'function') {
  window.showToast = function(msg, kind) {
    const colors = { success: '#22c55e', error: '#ef4444', info: '#3b82f6' };
    const n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText = `position:fixed;bottom:80px;right:20px;background:${colors[kind] || colors.info};color:#fff;padding:9px 16px;border-radius:6px;font-size:12.5px;z-index:10001;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,0.18);max-width:420px;`;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 3200);
  };
}

function saveCurrentCrawl() {
  if (!crawlerResults || !crawlerResults.length) {
    showToast('Nothing to save yet — run a crawl first.', 'error');
    return;
  }
  const defaultName = (crawlerResults[0].url || '').replace(/^https?:\/\//,'').replace(/\/$/,'');
  const name = prompt('Name this crawl:', defaultName);
  if (!name) return;
  fetch('/crawl/save', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name, results: crawlerResults, inlinks: crawlerInlinks })
  }).then(r => r.json()).then(d => {
    if (d.error) { showToast('Save failed: ' + d.error, 'error'); return; }
    showToast(`Saved "${d.name}"`, 'success');
  }).catch(e => showToast('Save failed: ' + e.message, 'error'));
}

function openCrawlLoader(opts) {
  opts = opts || {};
  const compareOnly = !!opts.compareOnly;
  const ov = document.getElementById('crawl-loader-overlay');
  const body = document.getElementById('crawl-loader-body');
  if (!ov || !body) return;
  body.innerHTML = '<div style="padding:20px;text-align:center;color:#64748b;font-size:12px;">Loading saved crawls…</div>';
  ov.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  const hasCurrent = !!(crawlerResults && crawlerResults.length);
  fetch('/crawl/list').then(r => r.json()).then(d => {
    const crawls = d.crawls || [];
    if (!crawls.length) {
      body.innerHTML = '<div style="padding:32px;text-align:center;color:#64748b;font-size:13px;">No saved crawls in the last 30 days. Every crawl auto-saves — run one and it will appear here.</div>';
      return;
    }
    let headerNote;
    if (compareOnly) {
      headerNote = hasCurrent
        ? `<div style="padding:10px 14px;font-size:11px;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Pick a saved crawl to diff against the current crawl (${crawlerResults.length} pages).</div>`
        : `<div style="padding:10px 14px;font-size:12px;color:#b45309;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin:10px 14px;">Run or load a crawl first, then come back here to compare.</div>`;
    } else {
      headerNote = hasCurrent
        ? `<div style="padding:10px 14px;font-size:11px;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Showing last 30 days · Current crawl loaded (${crawlerResults.length} pages) — use <strong>Compare</strong> to diff against any saved crawl.</div>`
        : `<div style="padding:10px 14px;font-size:11px;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Showing last 30 days · Load a crawl to view it, then open this list again to compare.</div>`;
    }
    const search = `
      <div style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:#fff;">
        <input type="search" id="crawl-loader-search" placeholder="Filter by domain, name, or saved by…" oninput="_filterCrawlLoader(this.value)" style="width:100%;padding:8px 12px;font-size:12.5px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;color:#0f172a;outline:none;" autocomplete="off" spellcheck="false" />
        <div id="crawl-loader-search-count" style="font-size:11px;color:#64748b;margin-top:6px;display:none;"></div>
      </div>`;
    const header = `
      <div style="display:grid;grid-template-columns:95px 55px 1fr 100px 80px 200px;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">
        <div>Date</div><div>Time</div><div>Website</div><div>Saved by</div><div style="text-align:right;">Pages</div><div></div>
      </div>`;
    const rows = crawls.map(c => {
      const dt = new Date((c.saved_at || 0) * 1000);
      const dateStr = dt.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'2-digit' });
      const timeStr = dt.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12:false });
      const seed = (c.seed || '').replace(/^https?:\/\//,'').replace(/\/$/,'');
      const savedBy = (c.saved_by || 'unknown');
      const compareBtn = hasCurrent
        ? `<button onclick='compareWithCurrent(${JSON.stringify(c.file)}, ${JSON.stringify(c.name)})' style="padding:6px 12px;font-size:11px;background:${compareOnly ? '#6366f1' : 'transparent'};color:${compareOnly ? '#fff' : '#6366f1'};border:1px solid #6366f1;border-radius:4px;cursor:pointer;font-weight:${compareOnly ? '600' : '400'};">Compare</button>`
        : '';
      const loadBtn = compareOnly
        ? ''
        : `<button onclick='loadSavedCrawl(${JSON.stringify(c.file)})' style="padding:6px 10px;font-size:11px;background:#6366f1;color:#fff;border:0;border-radius:4px;cursor:pointer;">Load</button>`;
      const delBtn = compareOnly
        ? ''
        : `<button onclick='deleteSavedCrawl(${JSON.stringify(c.file)})' title="Delete" style="padding:6px 8px;font-size:11px;background:transparent;color:#64748b;border:1px solid #e2e8f0;border-radius:4px;cursor:pointer;">✕</button>`;
      const searchBlob = (`${seed} ${c.name || ''} ${savedBy}`).toLowerCase().replace(/"/g,'&quot;');
      return `
        <div data-crawl-row="${c.file}" data-search="${searchBlob}" style="display:grid;grid-template-columns:95px 55px 1fr 100px 80px 200px;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:12px;">
          <div style="color:#0f172a;font-variant-numeric:tabular-nums;">${dateStr}</div>
          <div style="color:#64748b;font-variant-numeric:tabular-nums;font-family:'SF Mono','Menlo',monospace;">${timeStr}</div>
          <div style="min-width:0;">
            <div style="font-weight:600;color:#0f172a;word-break:break-all;">${seed || c.name}
              ${c.source === 'seo-tool' ? '<span title="Saved in seo-tool" style="display:inline-block;margin-left:6px;padding:1px 6px;background:#ede9fe;color:#5b21b6;border-radius:3px;font-size:9.5px;font-weight:600;vertical-align:middle;">seo-tool</span>' : ''}
              ${c.source === 'site-crawler' ? '<span title="Saved in site-crawler" style="display:inline-block;margin-left:6px;padding:1px 6px;background:#dbeafe;color:#1e40af;border-radius:3px;font-size:9.5px;font-weight:600;vertical-align:middle;">site-crawler</span>' : ''}
            </div>
            <div style="font-size:10px;color:#64748b;word-break:break-all;">${c.name}</div>
          </div>
          <div style="font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${savedBy}">${savedBy}</div>
          <div style="text-align:right;color:#0f172a;font-variant-numeric:tabular-nums;">${c.pages}</div>
          <div style="display:flex;gap:6px;justify-content:flex-end;">
            ${compareBtn}
            ${loadBtn}
            ${delBtn}
          </div>
        </div>
      `;
    }).join('');
    body.innerHTML = headerNote + search + header + rows;
  }).catch(e => {
    body.innerHTML = `<div style="padding:20px;color:#ef4444;font-size:12px;">Error: ${e.message}</div>`;
  });
}

window._filterCrawlLoader = function(q) {
  const term = (q || '').trim().toLowerCase();
  const rows = document.querySelectorAll('#crawl-loader-body [data-crawl-row]');
  let shown = 0;
  rows.forEach(r => {
    const blob = (r.dataset.search || '');
    const match = !term || blob.indexOf(term) !== -1;
    r.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  const countEl = document.getElementById('crawl-loader-search-count');
  if (countEl) {
    if (term) {
      countEl.style.display = '';
      countEl.textContent = `${shown} of ${rows.length} crawls match "${q}"`;
    } else {
      countEl.style.display = 'none';
    }
  }
};

function openCompareCrawlsPicker() {
  if (!crawlerResults || !crawlerResults.length) {
    showToast('Run or load a crawl first, then pick one to compare against.', 'error');
    return;
  }
  openCrawlLoader({ compareOnly: true });
}

function closeCrawlLoader() {
  const ov = document.getElementById('crawl-loader-overlay');
  if (ov) ov.style.display = 'none';
  document.body.style.overflow = '';
}

function loadSavedCrawl(file) {
  fetch('/crawl/load?file=' + encodeURIComponent(file)).then(r => r.json()).then(d => {
    if (d.error) { showToast('Load failed: ' + d.error, 'error'); return; }
    crawlerResults = d.results || [];
    crawlerInlinks = d.inlinks || {};
    window.crawlerReports = d.reports || {};
    const urlField = document.getElementById('crawler-url');
    if (urlField && (d.seed || d.name)) urlField.value = d.seed || d.name;
    setTimeout(() => {
      const empty = document.getElementById('crawler-empty');
      const results = document.getElementById('crawler-results');
      const sidebar = document.getElementById('issues-sidebar');
      const stats = document.getElementById('crawler-stats');
      if (empty) empty.style.display = 'none';
      if (results) results.style.display = '';
      if (sidebar) sidebar.style.display = '';
      if (stats) stats.style.display = 'grid';
      const tbody = document.getElementById('crawler-tbody');
      if (tbody) tbody.innerHTML = '';
      crawlerResults.forEach(r => { try { renderRow(r); } catch(e){} });
      const csCrawled = document.getElementById('cs-crawled');
      if (csCrawled) csCrawled.textContent = String(crawlerResults.length);
      const post = document.getElementById('crawler-post-crawl-actions');
      if (post) post.style.display = 'flex';
      { const _smBtn = document.getElementById('crawler-export-sitemap-btn'); if (_smBtn && crawlerResults.length) _smBtn.style.display = 'inline-flex'; }
      { const _xBtn = document.getElementById('crawler-export-xlsx-btn'); if (_xBtn && crawlerResults.length) _xBtn.style.display = 'inline-flex'; }
      if (typeof updateCounts === 'function') updateCounts();
      if (typeof window.selectCategory === 'function') window.selectCategory('all');
      showToast(`Loaded "${d.name}" · ${crawlerResults.length} pages`, 'success');
      closeCrawlLoader();
    }, 120);
  }).catch(e => showToast('Load failed: ' + e.message, 'error'));
}

function deleteSavedCrawl(file) {
  if (!confirm('Delete this saved crawl?')) return;
  fetch('/crawl/delete', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ file })
  }).then(r => r.json()).then(d => {
    if (d.error) { showToast('Delete failed: ' + d.error, 'error'); return; }
    const row = document.querySelector(`#crawl-loader-body [data-crawl-row="${CSS.escape(file)}"]`);
    if (row) row.remove();
    const left = document.querySelectorAll('#crawl-loader-body [data-crawl-row]').length;
    if (left === 0) {
      const body = document.getElementById('crawl-loader-body');
      if (body) body.innerHTML = '<div style="padding:32px;text-align:center;color:#64748b;font-size:13px;">No saved crawls left.</div>';
    }
  });
}

function compareWithCurrent(file, savedName) {
  if (!crawlerResults || !crawlerResults.length) {
    showToast('Load or run a crawl first, then compare.', 'error'); return;
  }
  closeCrawlLoader();
  window._compareActiveTab = 'overview';
  showToast('Comparing…', 'info');
  fetch('/crawl/compare', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ a_file: file, b_results: crawlerResults })
  }).then(r => r.json()).then(d => {
    if (d.error) { showToast('Compare failed: ' + d.error, 'error'); return; }
    _renderCompareModal(d, savedName);
  }).catch(e => showToast('Compare failed: ' + e.message, 'error'));
}

function _renderCompareModal(d, savedName) {
  window._compareData = d;
  window._compareSavedName = savedName;

  let ov = document.getElementById('crawl-compare-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'crawl-compare-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:10000;display:none;flex-direction:column;overflow:hidden;';
    ov.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;padding:10px 18px;border-bottom:1px solid #e2e8f0;background:#f8fafc;flex-shrink:0;">
        <div style="font-size:13px;font-weight:600;color:#0f172a;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="crawl-compare-title">Compare crawls</div>
        <button onclick="_closeCompareModal()" style="background:#fff;border:1px solid #e2e8f0;border-radius:5px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;color:#0f172a;flex-shrink:0;display:inline-flex;align-items:center;gap:6px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Exit Compare
        </button>
      </div>
      <div id="crawl-compare-tabs" style="display:flex;gap:0;padding:0 18px;border-bottom:1px solid #e2e8f0;background:#f8fafc;flex-shrink:0;overflow-x:auto;"></div>
      <div id="crawl-compare-body" style="overflow:auto;flex:1;min-height:0;background:#fff;"></div>
    `;
    document.body.appendChild(ov);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('crawl-compare-overlay')?.style.display === 'flex') {
        _closeCompareModal();
      }
    });
  }
  const title = document.getElementById('crawl-compare-title');
  if (title) title.textContent = `Compare: "${savedName || (d.a && d.a.name) || ''}" (old) vs current crawl`;
  const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const delta = (a, b, opts = {}) => {
    const dlt = b - a;
    if (dlt === 0) return `<span style="color:#94a3b8;">·</span>`;
    const lessIsBetter = opts.lessIsBetter !== false;
    const good = lessIsBetter ? dlt < 0 : dlt > 0;
    const arrow = dlt > 0 ? '▲' : '▼';
    const sign = dlt > 0 ? '+' : '';
    const color = good ? '#10b981' : '#ef4444';
    return `<span style="color:${color};font-weight:600;">${arrow} ${sign}${dlt}</span>`;
  };
  const deltaTime = (a, b) => {
    const dlt = +(b - a).toFixed(2);
    if (dlt === 0) return `<span style="color:#94a3b8;">·</span>`;
    const good = dlt < 0;
    const sign = dlt > 0 ? '+' : '';
    const color = good ? '#10b981' : '#ef4444';
    return `<span style="color:${color};font-weight:600;">${sign}${dlt}s</span>`;
  };

  const aggA = (d.aggregate && d.aggregate.a) || {};
  const aggB = (d.aggregate && d.aggregate.b) || {};
  const codesA = aggA.codes || {'2xx':0,'3xx':0,'4xx':0,'5xx':0,'other':0};
  const codesB = aggB.codes || {'2xx':0,'3xx':0,'4xx':0,'5xx':0,'other':0};

  const kpi = (label, a, b, opts) => `
    <div style="flex:1;min-width:130px;padding:12px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;">
      <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">${label}</div>
      <div style="display:flex;align-items:baseline;gap:8px;">
        <div style="font-size:20px;font-weight:700;color:#0f172a;font-variant-numeric:tabular-nums;">${b}</div>
        <div style="font-size:11px;color:#64748b;">was ${a}</div>
        <div style="margin-left:auto;font-size:11px;">${(opts && opts.time) ? deltaTime(a, b) : delta(a, b, opts)}</div>
      </div>
    </div>`;
  const toplineHtml = `
    <div style="padding:14px 18px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;">
        ${kpi('Pages', aggA.pages || 0, aggB.pages || 0, { lessIsBetter: false })}
        ${kpi('Errors (4xx/5xx)', aggA.errors || 0, aggB.errors || 0)}
        ${kpi('Pages with issues', aggA.warns_pages || 0, aggB.warns_pages || 0)}
        ${kpi('Avg response time', aggA.avg_response_time || 0, aggB.avg_response_time || 0, { time: true })}
        ${kpi('Max depth', aggA.max_depth || 0, aggB.max_depth || 0)}
        ${kpi('Indexable', aggA.indexable || 0, aggB.indexable || 0, { lessIsBetter: false })}
        ${kpi('Noindex', aggA.noindex || 0, aggB.noindex || 0)}
        ${kpi('Pages with schema', aggA.with_schema || 0, aggB.with_schema || 0, { lessIsBetter: false })}
        ${kpi('Redirects', aggA.redirects || 0, aggB.redirects || 0)}
        ${kpi('Missing title', aggA.missing_title || 0, aggB.missing_title || 0)}
        ${kpi('Missing meta', aggA.missing_meta || 0, aggB.missing_meta || 0)}
        ${kpi('Missing H1', aggA.missing_h1 || 0, aggB.missing_h1 || 0)}
        ${kpi('Thin content', aggA.thin || 0, aggB.thin || 0)}
        ${kpi('Slow (>3s)', aggA.slow || 0, aggB.slow || 0)}
        ${kpi('Images no alt', aggA.images_no_alt || 0, aggB.images_no_alt || 0)}
      </div>
    </div>`;

  const codeColor = { '2xx': '#22c55e', '3xx': '#f59e0b', '4xx': '#ef4444', '5xx': '#dc2626', 'other': '#888' };
  const codeRow = (k) => `
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:7px 14px;font-weight:600;color:${codeColor[k]};">${k}</td>
      <td style="padding:7px 14px;text-align:right;font-variant-numeric:tabular-nums;color:#64748b;">${codesA[k] || 0}</td>
      <td style="padding:7px 14px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${codesB[k] || 0}</td>
      <td style="padding:7px 14px;text-align:right;">${delta(codesA[k] || 0, codesB[k] || 0, { lessIsBetter: k !== '2xx' })}</td>
    </tr>`;
  const codesHtml = `
    <details open style="border-bottom:1px solid #e2e8f0;">
      <summary style="padding:12px 18px;cursor:pointer;font-weight:600;font-size:13px;">Status codes</summary>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:7px 14px;text-align:left;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Code</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Old</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">New</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Δ</th>
        </tr></thead>
        <tbody>${['2xx','3xx','4xx','5xx','other'].map(codeRow).join('')}</tbody>
      </table>
    </details>`;

  const issues = d.issues || [];
  const issueRow = (it, idx) => {
    const sev = (typeof sevOf === 'function' ? sevOf(it.issue) : 'warn');
    const sevColor = sev === 'error' ? '#ef4444' : sev === 'warn' ? '#f59e0b' : '#3b82f6';
    const resolved = it.only_a_total != null ? it.only_a_total : (it.only_a || []).length;
    const introduced = it.only_b_total != null ? it.only_b_total : (it.only_b || []).length;
    const still = it.both_total != null ? it.both_total : (it.both || []).length;
    const hasDrill = (resolved + introduced + still) > 0;
    return `<tr data-issue-idx="${idx}" data-expanded="0" style="border-bottom:1px solid #e2e8f0;${hasDrill ? 'cursor:pointer;' : ''}" ${hasDrill ? `onclick="_compareToggleIssueDrill(${idx})"` : ''}>
      <td style="padding:7px 14px;">
        ${hasDrill ? `<span class="ci-arrow" style="display:inline-block;width:10px;color:#64748b;font-size:10px;margin-right:4px;transition:transform .12s;">▶</span>` : '<span style="display:inline-block;width:14px;"></span>'}
        <span style="display:inline-block;padding:1px 6px;border-radius:3px;background:rgba(0,0,0,0.04);color:${sevColor};font-size:10px;font-weight:600;text-transform:uppercase;margin-right:6px;">${sev}</span><span style="font-size:12px;">${escHtml(it.issue)}</span>
      </td>
      <td style="padding:7px 14px;text-align:right;font-variant-numeric:tabular-nums;color:#64748b;">${it.a}</td>
      <td style="padding:7px 14px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${it.b}</td>
      <td style="padding:7px 14px;text-align:right;">${delta(it.a, it.b)}</td>
    </tr>`;
  };
  const issuesHtml = `
    <details open style="border-bottom:1px solid #e2e8f0;">
      <summary style="padding:12px 18px;cursor:pointer;font-weight:600;font-size:13px;">Issues (${issues.length}) <span style="font-weight:400;color:#64748b;font-size:11.5px;margin-left:6px;">click any row to see the URLs</span></summary>
      ${issues.length === 0 ? `<div style="padding:14px 18px;color:#64748b;font-size:12px;">No issues seen in either crawl.</div>` : `
      <table id="cmp-issues-table" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:7px 14px;text-align:left;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Issue</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Old</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">New</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Δ</th>
        </tr></thead>
        <tbody>${issues.map((it, i) => issueRow(it, i)).join('')}</tbody>
      </table>`}
    </details>`;

  const structure = d.structure || [];
  const structRow = (s) => `<tr style="border-bottom:1px solid #e2e8f0;">
    <td style="padding:6px 14px;font-family:'SF Mono','Menlo',monospace;font-size:12px;">${escHtml(s.path)}</td>
    <td style="padding:6px 14px;text-align:right;font-variant-numeric:tabular-nums;color:#64748b;">${s.a}</td>
    <td style="padding:6px 14px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${s.b}</td>
    <td style="padding:6px 14px;text-align:right;">${delta(s.a, s.b, { lessIsBetter: false })}</td>
  </tr>`;
  const structureHtml = structure.length ? `
    <details style="border-bottom:1px solid #e2e8f0;">
      <summary style="padding:12px 18px;cursor:pointer;font-weight:600;font-size:13px;">Site structure (${structure.length} top-level directories)</summary>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:7px 14px;text-align:left;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Directory</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Old</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">New</th>
          <th style="padding:7px 14px;text-align:right;font-weight:600;color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;">Δ</th>
        </tr></thead>
        <tbody>${structure.map(structRow).join('')}</tbody>
      </table>
    </details>` : '';

  const s = d.summary || {};
  const urlRow = (x, sign, signColor) => {
    const sc = x.status_code ? `<span style="font-size:10.5px;color:${x.status_code >= 400 ? '#ef4444' : x.status_code >= 300 ? '#f59e0b' : '#22c55e'};font-weight:600;font-variant-numeric:tabular-nums;margin-right:8px;">${x.status_code}</span>` : '';
    const ti = x.title ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${escHtml(x.title.slice(0, 100))}</div>` : '';
    return `<div style="padding:6px 14px;border-bottom:1px solid #e2e8f0;">
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-family:'SF Mono','Menlo',monospace;">
        <span style="color:${signColor};font-weight:700;">${sign}</span>
        ${sc}
        <a href="${x.url}" target="_blank" style="color:#6366f1;text-decoration:none;word-break:break-all;flex:1;min-width:0;">${escHtml(x.url)}</a>
      </div>
      ${ti}
    </div>`;
  };

  const FIELD_LABELS = {
    status_code: 'Status', title: 'Title', title_len: 'Title len', meta_description: 'Meta',
    meta_len: 'Meta len', h1: 'H1', word_count: 'Word count', canonical: 'Canonical',
    redirect_url: 'Redirect', indexable: 'Indexable', depth: 'Depth',
    response_time: 'Response time', internal_links: 'Internal links',
    external_links: 'External links', images_no_alt: 'Imgs no alt',
    body_hash: 'Body content', schema_types: 'Schema types',
  };
  const changedRow = (c) => {
    const fields = Object.entries(c.diffs).map(([f, v]) => {
      let oldv = v.old, newv = v.new;
      if (f === 'body_hash') { oldv = oldv ? oldv.slice(0, 8) + '…' : '—'; newv = newv ? newv.slice(0, 8) + '…' : '—'; }
      else { oldv = (oldv == null ? '—' : String(oldv)).slice(0, 220); newv = (newv == null ? '—' : String(newv)).slice(0, 220); }
      return `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;margin-top:4px;">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">${FIELD_LABELS[f] || f}</div>
        <div style="font-size:12px;">
          <div style="color:#ef4444;">− ${escHtml(oldv)}</div>
          <div style="color:#10b981;">+ ${escHtml(newv)}</div>
        </div>
      </div>`;
    }).join('');
    return `<div style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;font-family:'SF Mono','Menlo',monospace;word-break:break-all;margin-bottom:4px;">
        <a href="${c.url}" target="_blank" style="color:#6366f1;text-decoration:none;">${escHtml(c.url)}</a>
      </div>
      ${fields}
    </div>`;
  };
  const sliceList = (items, max, render) => {
    if (!items || !items.length) return `<div style="padding:14px 18px;color:#64748b;font-size:12px;">None.</div>`;
    return items.slice(0, max).map(render).join('') +
      (items.length > max ? `<div style="padding:8px 14px;font-size:11px;color:#64748b;">…and ${items.length - max} more</div>` : '');
  };

  const tabs = [
    { id: 'overview', label: 'Overview', count: null },
    { id: 'codes', label: 'Status Codes', count: null },
    { id: 'issues', label: 'Issues', count: (d.issues || []).length },
    { id: 'structure', label: 'Site Structure', count: (d.structure || []).length },
    { id: 'added', label: 'Added', count: s.added || 0, color: '#10b981' },
    { id: 'removed', label: 'Removed', count: s.removed || 0, color: '#ef4444' },
    { id: 'changed', label: 'Changed', count: s.changed || 0, color: '#f59e0b' },
  ];
  const active = window._compareActiveTab || 'overview';
  document.getElementById('crawl-compare-tabs').innerHTML = tabs.map(t => {
    const isActive = t.id === active;
    const badge = (t.count != null && t.count > 0)
      ? `<span style="margin-left:6px;padding:1px 7px;border-radius:10px;background:${t.color || (isActive ? '#6366f1' : '#f1f5f9')};color:${t.color || isActive ? '#fff' : '#64748b'};font-size:10.5px;font-variant-numeric:tabular-nums;font-weight:600;">${t.count}</span>`
      : (t.count === 0 ? `<span style="margin-left:6px;padding:1px 7px;border-radius:10px;background:#f1f5f9;color:#64748b;font-size:10.5px;font-variant-numeric:tabular-nums;">0</span>` : '');
    return `<button type="button" onclick="_compareSwitchTab('${t.id}')" style="background:none;border:0;border-bottom:2px solid ${isActive ? '#6366f1' : 'transparent'};padding:11px 16px;cursor:pointer;font-size:12.5px;font-weight:${isActive ? 700 : 500};color:${isActive ? '#0f172a' : '#64748b'};display:inline-flex;align-items:center;gap:0;flex-shrink:0;">${t.label}${badge}</button>`;
  }).join('');

  let bodyHtml = '';
  if (active === 'overview') {
    bodyHtml = toplineHtml +
      `<div style="padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div style="border:1px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden;">
          <div style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Top moving issues</div>
          ${(d.issues || []).slice(0, 8).length === 0 ? `<div style="padding:14px;color:#64748b;font-size:12px;">No issues changed.</div>` : `
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <tbody>${(d.issues || []).slice(0, 8).map(it => `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:7px 14px;">${escHtml(it.issue)}</td><td style="padding:7px 14px;text-align:right;color:#64748b;">${it.a}</td><td style="padding:7px 14px;text-align:right;font-weight:600;">${it.b}</td><td style="padding:7px 14px;text-align:right;">${delta(it.a, it.b)}</td></tr>`).join('')}</tbody>
          </table>`}
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden;">
          <div style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Top moving directories</div>
          ${(d.structure || []).filter(x => x.delta !== 0).slice(0, 8).length === 0 ? `<div style="padding:14px;color:#64748b;font-size:12px;">No directory changes.</div>` : `
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <tbody>${(d.structure || []).filter(x => x.delta !== 0).slice(0, 8).map(s2 => `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:7px 14px;font-family:'SF Mono','Menlo',monospace;">${escHtml(s2.path)}</td><td style="padding:7px 14px;text-align:right;color:#64748b;">${s2.a}</td><td style="padding:7px 14px;text-align:right;font-weight:600;">${s2.b}</td><td style="padding:7px 14px;text-align:right;">${delta(s2.a, s2.b, { lessIsBetter: false })}</td></tr>`).join('')}</tbody>
          </table>`}
        </div>
      </div>
      <div style="padding:0 18px 18px;">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
          <div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;background:#fff;">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">URLs added</div>
            <div style="font-size:24px;font-weight:700;color:#10b981;font-variant-numeric:tabular-nums;">${s.added || 0}</div>
            <button onclick="_compareSwitchTab('added')" style="margin-top:6px;background:none;border:0;color:#6366f1;font-size:12px;cursor:pointer;padding:0;">View →</button>
          </div>
          <div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;background:#fff;">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">URLs removed</div>
            <div style="font-size:24px;font-weight:700;color:#ef4444;font-variant-numeric:tabular-nums;">${s.removed || 0}</div>
            <button onclick="_compareSwitchTab('removed')" style="margin-top:6px;background:none;border:0;color:#6366f1;font-size:12px;cursor:pointer;padding:0;">View →</button>
          </div>
          <div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;background:#fff;">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">URLs changed</div>
            <div style="font-size:24px;font-weight:700;color:#f59e0b;font-variant-numeric:tabular-nums;">${s.changed || 0}</div>
            <button onclick="_compareSwitchTab('changed')" style="margin-top:6px;background:none;border:0;color:#6366f1;font-size:12px;cursor:pointer;padding:0;">View →</button>
          </div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:#64748b;">Unchanged: ${s.unchanged || 0} URLs (same on both crawls)</div>
      </div>`;
  } else if (active === 'codes') {
    bodyHtml = codesHtml;
  } else if (active === 'issues') {
    bodyHtml = issuesHtml;
  } else if (active === 'structure') {
    bodyHtml = structureHtml || `<div style="padding:18px;color:#64748b;font-size:12px;">No structural changes.</div>`;
  } else if (active === 'added') {
    bodyHtml = `<div style="padding:0;">${sliceList(d.added, 1000, (x) => urlRow(x, '+', '#10b981'))}</div>`;
  } else if (active === 'removed') {
    bodyHtml = `<div style="padding:0;">${sliceList(d.removed, 1000, (x) => urlRow(x, '−', '#ef4444'))}</div>`;
  } else if (active === 'changed') {
    bodyHtml = `<div style="padding:0;">${sliceList(d.changed, 1000, changedRow)}</div>`;
  }
  document.getElementById('crawl-compare-body').innerHTML = bodyHtml;

  ov.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function _compareSwitchTab(tabId) {
  window._compareActiveTab = tabId;
  if (window._compareData) _renderCompareModal(window._compareData, window._compareSavedName);
}

function _closeCompareModal() {
  const ov = document.getElementById('crawl-compare-overlay');
  if (ov) ov.style.display = 'none';
  document.body.style.overflow = '';
}

window._compareToggleIssueDrill = function(idx) {
  const tr = document.querySelector(`#cmp-issues-table tr[data-issue-idx="${idx}"]`);
  if (!tr) return;
  const expanded = tr.dataset.expanded === '1';
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('cmp-issue-drill')) existing.remove();
  const arrow = tr.querySelector('.ci-arrow');
  if (expanded) { tr.dataset.expanded = '0'; if (arrow) arrow.style.transform = ''; return; }
  tr.dataset.expanded = '1';
  if (arrow) arrow.style.transform = 'rotate(90deg)';

  const it = (window._compareData && (window._compareData.issues || [])[idx]) || null;
  if (!it) return;
  const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const renderList = (urls, total, emptyMsg, color) => {
    const safeUrls = Array.isArray(urls) ? urls : [];
    if (!safeUrls.length) return `<div style="padding:10px 12px;color:#64748b;font-size:11px;font-style:italic;">${emptyMsg}</div>`;
    const more = (total != null && total > safeUrls.length)
      ? `<div style="padding:6px 12px;font-size:10.5px;color:#64748b;">…and ${total - safeUrls.length} more</div>`
      : '';
    return safeUrls.map(u => `
      <div style="padding:5px 12px;font-size:11.5px;font-family:'SF Mono','Menlo',monospace;border-bottom:1px solid #e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        <span style="color:${color};font-weight:700;margin-right:6px;">●</span><a href="${u}" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none;">${escHtml(u)}</a>
      </div>`).join('') + more;
  };
  const onlyA = it.only_a || [];
  const onlyB = it.only_b || [];
  const both  = it.both  || [];
  const oat = it.only_a_total != null ? it.only_a_total : onlyA.length;
  const obt = it.only_b_total != null ? it.only_b_total : onlyB.length;
  const bt  = it.both_total   != null ? it.both_total   : both.length;
  const drill = document.createElement('tr');
  drill.className = 'cmp-issue-drill';
  drill.innerHTML = `
    <td colspan="4" style="padding:0;background:#f8fafc;border-bottom:1px solid #e2e8f0;">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:#e2e8f0;">
        <div style="background:#fff;">
          <div style="padding:8px 12px;font-size:10.5px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0;background:#f8fafc;">Resolved <span style="color:#64748b;font-weight:500;">(${oat})</span></div>
          <div style="max-height:340px;overflow:auto;">${renderList(onlyA, oat, 'No URLs resolved', '#10b981')}</div>
        </div>
        <div style="background:#fff;">
          <div style="padding:8px 12px;font-size:10.5px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0;background:#f8fafc;">Newly broken <span style="color:#64748b;font-weight:500;">(${obt})</span></div>
          <div style="max-height:340px;overflow:auto;">${renderList(onlyB, obt, 'No new URLs broken', '#ef4444')}</div>
        </div>
        <div style="background:#fff;">
          <div style="padding:8px 12px;font-size:10.5px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0;background:#f8fafc;">Still failing <span style="color:#64748b;font-weight:500;">(${bt})</span></div>
          <div style="max-height:340px;overflow:auto;">${renderList(both, bt, 'None — issue cleared', '#f59e0b')}</div>
        </div>
      </div>
    </td>`;
  tr.parentNode.insertBefore(drill, tr.nextSibling);
};

// Auto-save on crawl finish + reveal manual Save button.
(function _wireSiteCrawlerSave() {
  const _origCrawlFinished = (typeof crawlFinished === 'function') ? crawlFinished : null;
  if (!_origCrawlFinished) return;
  window.crawlFinished = function() {
    _origCrawlFinished.apply(this, arguments);
    if (!Array.isArray(crawlerResults) || !crawlerResults.length) return;
    const post = document.getElementById('crawler-post-crawl-actions');
    if (post) post.style.display = 'flex';
    try {
      const host = (crawlerResults[0].url || '').replace(/^https?:\/\//,'').replace(/\/.*$/,'');
      const d = new Date();
      const stamp = d.getFullYear() + '-' +
        String(d.getMonth()+1).padStart(2,'0') + '-' +
        String(d.getDate()).padStart(2,'0') + ' ' +
        String(d.getHours()).padStart(2,'0') + ':' +
        String(d.getMinutes()).padStart(2,'0');
      const name = host ? `${host} — ${stamp}` : `crawl — ${stamp}`;
      fetch('/crawl/save', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name, results: crawlerResults, inlinks: crawlerInlinks })
      }).then(r => r.json()).then(d => {
        if (d && d.ok) showToast(`Auto-saved: ${name}`, 'success');
      }).catch(() => {});
    } catch {}
  };
})();

// =============================================================================
// Site Structure visualisation — sunburst (radial directory hierarchy),
// hierarchy text tree, and anchor-text cloud. Pure SVG, no external libs.
// Mirrors the implementation in seo-tool/static/script.js.
// =============================================================================

window._svView = window._svView || 'sunburst';

// Throttled live refresh while a crawl is streaming. The SSE 'page' handler
// calls _maybeRefreshSiteStructure() on every new page; we coalesce to one
// re-render every ~2.5s so the SVG doesn't thrash. Skip mid-drag (would
// cancel a pan), mid-search-typing (would steal input focus), and when the
// user isn't actually viewing this panel. Zoom viewBox is preserved across
// refreshes so the user's zoom level survives.
let _svRefreshTimer = null;
let _svLastRefresh = 0;
const _SV_REFRESH_MIN_GAP = 2500;

window._maybeRefreshSiteStructure = function() {
  if (typeof activeCategory === 'undefined' || activeCategory !== '__sitemap_viz') return;
  if (window._svPZ && window._svPZ.drag) return;
  const searchEl = document.getElementById('sv-search');
  if (searchEl && document.activeElement === searchEl && searchEl.value) return;
  const now = Date.now();
  const since = now - _svLastRefresh;
  if (since >= _SV_REFRESH_MIN_GAP) {
    _svRefreshNow();
    return;
  }
  if (_svRefreshTimer) return;
  _svRefreshTimer = setTimeout(() => {
    _svRefreshTimer = null;
    window._maybeRefreshSiteStructure();
  }, _SV_REFRESH_MIN_GAP - since);
};

function _svRefreshNow() {
  _svLastRefresh = Date.now();
  if (typeof activeCategory === 'undefined' || activeCategory !== '__sitemap_viz') return;
  const prevVb = (window._svPZ && window._svPZ.vb) ? { ...window._svPZ.vb } : null;
  _scRenderSiteStructurePanel();
  if (prevVb) {
    setTimeout(() => {
      const s = window._svPZ;
      if (!s || !s.svg) return;
      s.vb = prevVb;
      s.svg.setAttribute('viewBox', `${prevVb.x} ${prevVb.y} ${prevVb.w} ${prevVb.h}`);
    }, 10);
  }
}

function _scRenderSiteStructurePanel() {
  const main = document.querySelector('.results-panel') || document.getElementById('crawler-results');
  if (!main) return;
  const old = document.getElementById('sitestructure-panel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'sitestructure-panel';
  panel.style.cssText = 'flex:1;overflow:auto;min-height:0;padding:14px;font-size:12px;';
  panel.innerHTML = _scRenderSiteStructure();
  main.appendChild(panel);
}

function _scBuildSiteStructureTree(results) {
  const root = { name: '(root)', full: '/', children: {}, leaf: null, count: 0, issues: 0, errors: 0 };
  results.forEach(p => {
    try {
      const u = new URL(p.url);
      const path = u.pathname.replace(/\/$/, '') || '/';
      const parts = path === '/' ? [''] : path.split('/').filter(Boolean);
      let node = root;
      node.count++;
      node.issues += (p.issues || []).length;
      if (p.status_code >= 400) node.errors++;
      if (parts.length === 1 && parts[0] === '') {
        node.leaf = p;
        return;
      }
      let fullPath = '';
      parts.forEach((seg, i) => {
        fullPath += '/' + seg;
        if (!node.children[seg]) {
          node.children[seg] = { name: seg, full: fullPath, children: {}, leaf: null, count: 0, issues: 0, errors: 0 };
        }
        node = node.children[seg];
        node.count++;
        node.issues += (p.issues || []).length;
        if (p.status_code >= 400) node.errors++;
        if (i === parts.length - 1) node.leaf = p;
      });
    } catch (e) {}
  });
  return root;
}

function _scRenderSiteStructure() {
  const results = crawlerResults || [];
  if (!results.length) {
    return '<div style="padding:32px;text-align:center;color:#64748b;font-size:13px;">Crawl the site first to see its structure.</div>';
  }
  const view = window._svView || 'sunburst';
  const root = _scBuildSiteStructureTree(results);

  const tab = (id, label, icon) => `
    <button type="button" onclick="_svSwitchView('${id}')"
      style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:${view===id?'var(--accent,#6366f1)':'var(--surface2,#f1f5f9)'};color:${view===id?'#fff':'var(--text,#0f172a)'};border:1px solid ${view===id?'var(--accent,#6366f1)':'var(--border,#e2e8f0)'};border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;">
      <span style="font-size:14px;line-height:1;">${icon}</span>${label}
    </button>`;

  let body = '';
  if (view === 'sunburst')      body = _scRenderSiteStructureSunburst(root, results);
  else if (view === 'hierarchy') body = _scRenderSiteStructureTree(root);
  else if (view === 'cloud')     body = _scRenderAnchorTextCloud();
  else                           body = _scRenderSiteStructureSunburst(root, results);

  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
      ${tab('sunburst', 'Sunburst', '☀')}
      ${tab('hierarchy', 'Hierarchy', '⇲')}
      ${tab('cloud', 'Anchor cloud', '☁')}
      <span style="margin-left:auto;font-size:11px;color:#64748b;">${results.length} URLs · ${root.errors} broken · ${root.issues} issue${root.issues===1?'':'s'} total</span>
    </div>
    ${body}`;
}

window._svSwitchView = function(view) {
  window._svView = view;
  // Re-render the panel in place.
  if (typeof _scRenderSiteStructurePanel === 'function') _scRenderSiteStructurePanel();
};

// Click-to-drill zoomable sunburst. Click a slice → it becomes the new
// centre, all its children fill 360°. Click the centre disc → zoom out.
window._svFocus = window._svFocus || '';

function _svFindNode(root, fullPath) {
  if (!fullPath || fullPath === '/' || fullPath === root.full) return root;
  const parts = fullPath.replace(/^\//, '').split('/').filter(Boolean);
  let node = root;
  for (const seg of parts) {
    if (!node || !node.children || !node.children[seg]) return null;
    node = node.children[seg];
  }
  return node;
}

function _svParentPath(p) {
  if (!p || p === '/' || p === '') return '';
  const parts = p.replace(/^\//, '').split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '';
}

function _scRenderSiteStructureSunburst(rootTree, results) {
  const W = 720, H = 720;
  const cx = W / 2, cy = H / 2;
  const innerRadius = 70;

  const focus = _svFindNode(rootTree, window._svFocus) || rootTree;
  if (focus === rootTree) window._svFocus = '';

  const subDepth = (n) => {
    let m = 0;
    Object.values(n.children).forEach(c => { m = Math.max(m, 1 + subDepth(c)); });
    return m;
  };
  const depth = Math.max(2, subDepth(focus));
  const rw = Math.min(72, (Math.min(W, H) / 2 - innerRadius - 10) / depth);

  const palette = ['#0ea5e9', '#22c55e', '#a855f7', '#f59e0b', '#06b6d4', '#ec4899', '#14b8a6', '#f43f5e'];
  const sliceColor = (node, d) => {
    if (node.errors > 0) return '#ef4444';
    if (node.leaf && node.leaf.status_code >= 300 && node.leaf.status_code < 400) return '#f59e0b';
    return palette[d % palette.length];
  };

  const arcs = [];
  const allocate = (node, d, a0, a1) => {
    if (d > 0) arcs.push({ node, d, a0, a1 });
    const kids = Object.values(node.children);
    if (!kids.length) return;
    const total = kids.reduce((s, k) => s + Math.max(1, k.count), 0);
    let cur = a0;
    kids.sort((a, b) => b.count - a.count).forEach(k => {
      const w = (Math.max(1, k.count) / total) * (a1 - a0);
      allocate(k, d + 1, cur, cur + w);
      cur += w;
    });
  };
  allocate(focus, 0, 0, Math.PI * 2);

  const polar = (r, a) => [cx + r * Math.cos(a - Math.PI / 2), cy + r * Math.sin(a - Math.PI / 2)];
  const arcPath = (r0, r1, a0, a1) => {
    if (a1 - a0 >= Math.PI * 2 - 1e-3) {
      const [m0x, m0y] = polar(r0, 0);
      const [m1x, m1y] = polar(r1, 0);
      return `M ${m1x} ${m1y} A ${r1} ${r1} 0 1 1 ${m1x - 0.001} ${m1y} L ${m0x - 0.001} ${m0y} A ${r0} ${r0} 0 1 0 ${m0x} ${m0y} Z`;
    }
    const [s0x, s0y] = polar(r0, a0);
    const [e0x, e0y] = polar(r0, a1);
    const [s1x, s1y] = polar(r1, a0);
    const [e1x, e1y] = polar(r1, a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    return `M ${s0x} ${s0y} L ${s1x} ${s1y} A ${r1} ${r1} 0 ${large} 1 ${e1x} ${e1y} L ${e0x} ${e0y} A ${r0} ${r0} 0 ${large} 0 ${s0x} ${s0y} Z`;
  };

  const _scEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const slices = arcs.map((arc, i) => {
    const r0 = innerRadius + (arc.d - 1) * rw;
    const r1 = innerRadius + arc.d * rw;
    const path = arcPath(r0, r1, arc.a0, arc.a1);
    const color = sliceColor(arc.node, arc.d);
    const angle = arc.a1 - arc.a0;
    const midR = (r0 + r1) / 2;
    const arcLengthMid = midR * angle;
    const safePath = _scEsc(arc.node.full).replace(/'/g, "\\'");
    const hasKids = Object.keys(arc.node.children || {}).length > 0;
    const title = `${_scEsc(arc.node.full)}\n${arc.node.count} URL${arc.node.count===1?'':'s'}${arc.node.errors?` · ${arc.node.errors} broken`:''}${arc.node.issues?` · ${arc.node.issues} issue${arc.node.issues===1?'':'s'}`:''}\n${hasKids ? 'Click to drill in · Shift+click to filter table' : 'Shift+click to filter table'}`;

    // Two label modes: tangential curved text for wide arcs, radial text
    // for narrow ones (so drilled-in views with many siblings still get
    // labels on every slice).
    let label = '';
    if (arcLengthMid > 32 && rw > 22) {
      const midAng = (arc.a0 + arc.a1) / 2;
      const reverse = midAng > Math.PI / 2 && midAng < 3 * Math.PI / 2;
      const sa = reverse ? arc.a1 : arc.a0;
      const ea = reverse ? arc.a0 : arc.a1;
      const sweep = reverse ? 0 : 1;
      const [sx, sy] = polar(midR, sa);
      const [ex, ey] = polar(midR, ea);
      const large = Math.abs(ea - sa) > Math.PI ? 1 : 0;
      const labelArcPath = `M ${sx} ${sy} A ${midR} ${midR} 0 ${large} ${sweep} ${ex} ${ey}`;
      const pathId = `sv-lbl-${i}-${arc.d}`;
      const maxChars = Math.max(3, Math.floor(arcLengthMid / 6.8) - 1);
      const labelText = arc.node.name.length > maxChars
        ? arc.node.name.slice(0, Math.max(1, maxChars - 1)) + '…'
        : arc.node.name;
      label = `
        <defs><path id="${pathId}" d="${labelArcPath}" fill="none"/></defs>
        <text dy="4" style="font-family:ui-sans-serif,system-ui;font-size:13px;font-weight:700;fill:#fff;stroke:rgba(0,0,0,0.55);stroke-width:3.5px;paint-order:stroke;pointer-events:none;">
          <textPath href="#${pathId}" startOffset="50%" text-anchor="middle">${_scEsc(labelText)}</textPath>
        </text>`;
    } else if (rw > 14 && angle > 0.018) {
      // Radial label — reads from centre outward. Flip 180° on bottom/left
      // half so letters aren't upside-down.
      const midAng = (arc.a0 + arc.a1) / 2;
      const [tx, ty] = polar(midR, midAng);
      const baseRot = (midAng * 180 / Math.PI) - 90;
      const flip = midAng > Math.PI / 2 && midAng < 3 * Math.PI / 2;
      const rot = flip ? baseRot + 180 : baseRot;
      const maxChars = Math.max(2, Math.floor((rw - 6) / 5.8));
      const labelText = arc.node.name.length > maxChars
        ? arc.node.name.slice(0, Math.max(1, maxChars - 1)) + '…'
        : arc.node.name;
      label = `<text x="${tx}" y="${ty}"
        transform="rotate(${rot.toFixed(2)} ${tx} ${ty})"
        text-anchor="middle" dy="3.2"
        style="font-family:ui-sans-serif,system-ui;font-size:10px;font-weight:600;fill:#fff;stroke:rgba(0,0,0,0.6);stroke-width:2.4px;paint-order:stroke;pointer-events:none;">${_scEsc(labelText)}</text>`;
    }

    return `<g class="sv-slice" data-path="${_scEsc(arc.node.full)}">
      <path d="${path}" fill="${color}" stroke="#fff" stroke-width="1.5" opacity="0.92"
        style="cursor:pointer;transition:opacity .12s;"
        onmouseover="this.setAttribute('opacity','1');_svSliceHover('${safePath}', ${arc.node.count}, ${arc.node.errors}, ${arc.node.issues})"
        onmouseout="this.setAttribute('opacity','0.92');_svSliceHover('','','','')"
        onclick="_svSliceClick(event, '${safePath}', ${hasKids ? 1 : 0})">
        <title>${title}</title>
      </path>
      ${label}
    </g>`;
  }).join('');

  const focusLabel = focus === rootTree ? 'site' : (focus.name || '/');
  const canGoUp = focus !== rootTree;
  const center = `
    <g style="cursor:${canGoUp ? 'pointer' : 'default'};" ${canGoUp ? `onclick="_svZoomOut()"` : ''}>
      <circle cx="${cx}" cy="${cy}" r="${innerRadius - 4}" fill="#fff" stroke="${canGoUp ? '#6366f1' : '#e2e8f0'}" stroke-width="${canGoUp ? '2' : '1.5'}"/>
      <text x="${cx}" y="${cy - 22}" text-anchor="middle" style="font-family:ui-sans-serif,system-ui;font-size:10.5px;fill:#64748b;text-transform:uppercase;letter-spacing:.05em;pointer-events:none;">${canGoUp ? '← back' : 'site'}</text>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-family:ui-sans-serif,system-ui;font-size:${focusLabel.length > 14 ? 13 : 17}px;font-weight:700;fill:#0f172a;pointer-events:none;">${_scEsc(focusLabel.length > 18 ? focusLabel.slice(0, 17) + '…' : focusLabel)}</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" style="font-family:ui-sans-serif,system-ui;font-size:13px;font-weight:600;fill:#6366f1;pointer-events:none;">${focus.count} URL${focus.count===1?'':'s'}</text>
      ${focus.errors ? `<text x="${cx}" y="${cy + 36}" text-anchor="middle" style="font-family:ui-sans-serif,system-ui;font-size:10.5px;font-weight:600;fill:#ef4444;pointer-events:none;">${focus.errors} broken</text>` : ''}
    </g>`;

  const buildCrumbs = () => {
    const items = [{ name: 'site', path: '' }];
    if (focus !== rootTree && focus.full) {
      const parts = focus.full.replace(/^\//, '').split('/').filter(Boolean);
      let acc = '';
      parts.forEach(p => { acc += '/' + p; items.push({ name: p, path: acc }); });
    }
    return items.map((it, i) => {
      const isLast = i === items.length - 1;
      return `<button type="button" onclick="_svZoomTo('${it.path.replace(/'/g,"\\'")}')"
        style="background:${isLast?'#6366f1':'#fff'};color:${isLast?'#fff':'#0f172a'};border:1px solid ${isLast?'#6366f1':'#e2e8f0'};border-radius:5px;padding:3px 9px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;">${_scEsc(it.name)}</button>`;
    }).join('<span style="color:#94a3b8;font-size:11px;align-self:center;">›</span>');
  };

  // Collect every URL inside the current focus subtree for the list below.
  const collectLeaves = (node, out) => {
    if (node.leaf) out.push(node.leaf);
    Object.values(node.children).forEach(c => collectLeaves(c, out));
    return out;
  };
  const focusUrls = collectLeaves(focus, []).sort((a, b) => (a.url || '').localeCompare(b.url || ''));
  const focusUrlsJson = JSON.stringify(focusUrls.map(p => ({
    u: p.url || '',
    s: p.status_code || 0,
    i: (p.issues || []).length,
    t: p.title || '',
  })));

  // Wire pan/zoom after the SVG is in the DOM.
  setTimeout(_svInitPanZoom, 0);

  return `
    <div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
        ${buildCrumbs()}
        <div style="margin-left:auto;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:4px 10px;min-width:240px;">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" style="color:#94a3b8;flex-shrink:0;"><circle cx="9" cy="9" r="6"/><path d="M13.5 13.5L18 18"/></svg>
          <input type="text" id="sv-search" placeholder="Search ${focusUrls.length} URL${focusUrls.length===1?'':'s'} in this view…"
            oninput="_svFilter(this.value)" autocomplete="off" spellcheck="false"
            style="background:none;border:none;outline:none;font-size:12px;color:#0f172a;flex:1;min-width:0;font-family:inherit;" />
          <button type="button" id="sv-search-clear" onclick="document.getElementById('sv-search').value='';_svFilter('')" style="display:none;background:none;border:none;cursor:pointer;color:#94a3b8;font-size:14px;line-height:1;padding:0 2px;" title="Clear">×</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:16px;align-items:start;">
        <div style="min-width:0;">
          <div id="sv-svg-wrap" style="position:relative;background:#f8fafc;border-radius:10px;padding:8px;overflow:hidden;touch-action:none;">
            <div style="position:absolute;top:14px;left:14px;font-size:10.5px;color:#64748b;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:5px 9px;z-index:2;pointer-events:none;line-height:1.3;max-width:55%;">
              click slice to drill · centre to go back · drag to pan · scroll to zoom
            </div>
            <div style="position:absolute;top:14px;right:14px;display:flex;flex-direction:column;gap:5px;z-index:2;">
              <button type="button" onclick="_svZoom(1.25)" title="Zoom in" style="width:30px;height:30px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;color:#0f172a;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;font-family:inherit;" onmouseover="this.style.borderColor='#6366f1';this.style.color='#6366f1'" onmouseout="this.style.borderColor='#e2e8f0';this.style.color='#0f172a'">+</button>
              <button type="button" onclick="_svZoom(0.8)" title="Zoom out" style="width:30px;height:30px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;color:#0f172a;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;font-family:inherit;" onmouseover="this.style.borderColor='#6366f1';this.style.color='#6366f1'" onmouseout="this.style.borderColor='#e2e8f0';this.style.color='#0f172a'">−</button>
              <button type="button" onclick="_svResetView()" title="Reset zoom & position" style="width:30px;height:30px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;color:#0f172a;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;font-family:inherit;" onmouseover="this.style.borderColor='#6366f1';this.style.color='#6366f1'" onmouseout="this.style.borderColor='#e2e8f0';this.style.color='#0f172a'">⟲</button>
            </div>
            <svg id="sv-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
                 data-vb-w="${W}" data-vb-h="${H}"
                 style="width:100%;max-width:680px;height:auto;display:block;margin:0 auto;user-select:none;cursor:grab;">
              ${slices}
              ${center}
            </svg>
          </div>
          <div style="margin-top:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:11.5px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.05em;">
              <span>Pages in this view</span>
              <span id="sv-list-count" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:2px 9px;font-size:10.5px;color:#64748b;font-weight:600;letter-spacing:0;text-transform:none;">${focusUrls.length}</span>
              <span style="margin-left:auto;font-weight:500;font-size:10.5px;color:#64748b;text-transform:none;letter-spacing:0;">click any URL to open in dock · ⇧-click to filter table</span>
            </div>
            <div id="sv-list" data-urls='${focusUrlsJson.replace(/'/g, "&#39;")}' style="max-height:340px;overflow:auto;font-family:'SF Mono','Menlo',monospace;font-size:11.5px;">
              ${_svRenderList(focusUrls, '')}
            </div>
          </div>
        </div>
        <div style="min-width:0;overflow:hidden;">
          <div id="sv-readout" style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:12px;min-height:120px;overflow:hidden;">
            <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:6px;">hover a slice</div>
            <div id="sv-readout-path" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#6366f1;word-break:break-all;overflow-wrap:anywhere;margin-bottom:8px;max-width:100%;">—</div>
            <div id="sv-readout-stats" style="font-size:11.5px;color:#64748b;line-height:1.55;">Click a slice to drill in. Hold <kbd style="font-family:inherit;background:#fff;border:1px solid #e2e8f0;border-radius:3px;padding:1px 5px;font-size:10.5px;">Shift</kbd> while clicking to filter the table to that subtree instead.</div>
          </div>
          <div style="font-size:11px;color:#64748b;line-height:1.55;">
            <strong style="color:#0f172a;font-size:11.5px;">How to read</strong><br>
            Each ring is one path level under the centre. Slice size = number of URLs in that subtree. Red = 4xx/5xx pages live in there.
          </div>
        </div>
      </div>
    </div>`;
}

function _svRenderList(pages, filter) {
  if (!pages || !pages.length) {
    return '<div style="padding:18px 14px;color:#64748b;font-size:12px;font-family:ui-sans-serif,system-ui;text-align:center;">No URLs in this view.</div>';
  }
  const _scEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const f = (filter || '').trim().toLowerCase();
  const matches = f
    ? pages.filter(p => ((p.url || p.u) || '').toLowerCase().includes(f) || ((p.title || p.t) || '').toLowerCase().includes(f))
    : pages;
  if (!matches.length) {
    return `<div style="padding:18px 14px;color:#64748b;font-size:12px;font-family:ui-sans-serif,system-ui;text-align:center;">No URLs match <code style="background:#fff;padding:1px 6px;border-radius:3px;">${_scEsc(filter)}</code></div>`;
  }
  return matches.map(p => {
    const url = p.url || p.u || '';
    const status = p.status_code || p.s || 0;
    const issues = (p.issues ? p.issues.length : (p.i || 0));
    const title = p.title || p.t || '';
    const path = url.replace(/^https?:\/\/[^\/]+/, '') || '/';
    const sc = status >= 500 ? '#dc2626' : status >= 400 ? '#ef4444' : status >= 300 ? '#f59e0b' : status >= 200 ? '#22c55e' : '#94a3b8';
    const safeUrl = (url || '').replace(/'/g, "\\'");
    return `<div onclick="_svListClick(event, '${safeUrl}')"
      style="display:flex;align-items:center;gap:10px;padding:6px 14px;border-bottom:1px solid #e2e8f0;cursor:pointer;line-height:1.4;"
      onmouseover="this.style.background='#fff'" onmouseout="this.style.background=''"
      title="${_scEsc(title || url)}">
      <span style="color:${sc};font-weight:700;width:38px;flex-shrink:0;text-align:right;font-variant-numeric:tabular-nums;">${status || '—'}</span>
      <span style="flex:1;min-width:0;color:#6366f1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_scEsc(path)}</span>
      ${issues ? `<span style="color:#f59e0b;font-size:10.5px;font-weight:600;flex-shrink:0;">${issues} issue${issues===1?'':'s'}</span>` : ''}
    </div>`;
  }).join('');
}

window._svFilter = function(value) {
  const v = (value || '').trim().toLowerCase();
  const clear = document.getElementById('sv-search-clear');
  if (clear) clear.style.display = v ? '' : 'none';
  document.querySelectorAll('#sv-svg .sv-slice').forEach(g => {
    const pathEl = g.querySelector('path');
    const arcPath = (g.getAttribute('data-path') || '').toLowerCase();
    if (!v || arcPath.includes(v)) {
      pathEl && pathEl.setAttribute('opacity', '0.92');
    } else {
      pathEl && pathEl.setAttribute('opacity', '0.15');
    }
  });
  const list = document.getElementById('sv-list');
  if (list) {
    let pages = [];
    try { pages = JSON.parse((list.dataset.urls || '[]').replace(/&#39;/g, "'")); } catch {}
    list.innerHTML = _svRenderList(pages, v);
    const countEl = document.getElementById('sv-list-count');
    const total = pages.length;
    if (countEl) {
      if (v) {
        const matched = pages.filter(p => (p.u || '').toLowerCase().includes(v) || (p.t || '').toLowerCase().includes(v)).length;
        countEl.textContent = `${matched} / ${total}`;
      } else {
        countEl.textContent = total;
      }
    }
  }
};

window._svListClick = function(e, url) {
  if (!url) return;
  if (e && e.shiftKey) return _svFilterTable(url);
  if (typeof window.openDock === 'function') window.openDock(url);
};

// Pan + zoom on the sunburst SVG. Drag past 4px = pan and suppress the
// follow-up click (so users don't accidentally drill in while panning).
// Scroll wheel zooms around the cursor position. +/-/⟲ buttons drive the
// same code paths.
function _svInitPanZoom() {
  const svg = document.getElementById('sv-svg');
  const wrap = document.getElementById('sv-svg-wrap');
  if (!svg || !wrap) return;
  if (svg.dataset.svPanZoom === '1') return;
  svg.dataset.svPanZoom = '1';
  const W = parseFloat(svg.dataset.vbW) || 720;
  const H = parseFloat(svg.dataset.vbH) || 720;
  const state = window._svPZ = {
    svg, wrap, w0: W, h0: H,
    vb: { x: 0, y: 0, w: W, h: H },
    drag: null,
    suppressClick: false,
  };
  const apply = () => svg.setAttribute('viewBox', `${state.vb.x} ${state.vb.y} ${state.vb.w} ${state.vb.h}`);

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    state.drag = { sx: e.clientX, sy: e.clientY, vbX: state.vb.x, vbY: state.vb.y, moved: 0 };
    state.suppressClick = false;
    svg.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.drag) return;
    const dx = e.clientX - state.drag.sx;
    const dy = e.clientY - state.drag.sy;
    state.drag.moved = Math.max(state.drag.moved, Math.abs(dx), Math.abs(dy));
    const r = svg.getBoundingClientRect();
    state.vb.x = state.drag.vbX - dx / r.width * state.vb.w;
    state.vb.y = state.drag.vbY - dy / r.height * state.vb.h;
    apply();
  });
  window.addEventListener('mouseup', () => {
    if (!state.drag) return;
    if (state.drag.moved > 4) state.suppressClick = true;
    state.drag = null;
    svg.style.cursor = 'grab';
    setTimeout(() => { state.suppressClick = false; }, 50);
  });
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
    _svZoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });
  apply();
}

function _svZoomAt(clientX, clientY, factor) {
  const s = window._svPZ;
  if (!s) return;
  const newW = s.vb.w / factor;
  const newH = s.vb.h / factor;
  if (newW < s.w0 / 12 || newW > s.w0 * 4) return;
  const r = s.svg.getBoundingClientRect();
  const px = s.vb.x + (clientX - r.left) / r.width * s.vb.w;
  const py = s.vb.y + (clientY - r.top) / r.height * s.vb.h;
  s.vb.x = px - (clientX - r.left) / r.width * newW;
  s.vb.y = py - (clientY - r.top) / r.height * newH;
  s.vb.w = newW;
  s.vb.h = newH;
  s.svg.setAttribute('viewBox', `${s.vb.x} ${s.vb.y} ${s.vb.w} ${s.vb.h}`);
}

window._svZoom = function(factor) {
  const s = window._svPZ;
  if (!s) return;
  const r = s.svg.getBoundingClientRect();
  _svZoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
};

window._svResetView = function() {
  const s = window._svPZ;
  if (!s) return;
  s.vb = { x: 0, y: 0, w: s.w0, h: s.h0 };
  s.svg.setAttribute('viewBox', `0 0 ${s.w0} ${s.h0}`);
};

window._svSliceHover = function(pathStr, count, errors, issues) {
  const p = document.getElementById('sv-readout-path');
  const s = document.getElementById('sv-readout-stats');
  if (!p || !s) return;
  if (!pathStr) {
    p.textContent = '—';
    s.innerHTML = 'Click a slice to drill in. Hold <kbd style="font-family:inherit;background:#fff;border:1px solid #e2e8f0;border-radius:3px;padding:1px 5px;font-size:10.5px;">Shift</kbd> while clicking to filter the table to that subtree instead.';
    return;
  }
  p.textContent = pathStr || '/';
  const parts = [];
  parts.push(`<strong style="color:#0f172a;">${count}</strong> URL${count===1?'':'s'} under this path`);
  if (errors > 0) parts.push(`<span style="color:#ef4444;font-weight:600;">${errors} broken</span>`);
  if (issues > 0) parts.push(`<span style="color:#f59e0b;font-weight:600;">${issues} issue${issues===1?'':'s'} total</span>`);
  s.innerHTML = parts.join(' · ');
};

// Slice click: default = drill in (zoom to that subtree); shift+click =
// filter the table. Clicking a leaf (no children) opens that URL in the
// bottom dock — drilling would just stop at the last level anyway, and
// switching to the table view loses the user's place in the chart.
// suppressClick is set by _svInitPanZoom when a drag exceeded 4px so we
// don't accidentally drill in at the end of a pan gesture.
window._svSliceClick = function(e, pathPrefix, hasKids) {
  if (window._svPZ && window._svPZ.suppressClick) return;
  if (e && e.shiftKey) return _svFilterTable(pathPrefix);
  if (!hasKids) {
    // Leaf — open the actual URL in the dock without leaving the sunburst.
    // pathPrefix is just the path part; resolve to a full URL by matching
    // against crawlerResults so the dock can find the page record.
    const results = (typeof crawlerResults !== 'undefined' && crawlerResults) || (window.results || []);
    const match = results.find(r => {
      try {
        const u = new URL(r.url);
        const p = u.pathname.replace(/\/$/, '') || '/';
        return p === pathPrefix || p === pathPrefix.replace(/\/$/, '');
      } catch { return false; }
    });
    if (match && typeof window.openDock === 'function') window.openDock(match.url);
    return;
  }
  window._svFocus = pathPrefix;
  if (typeof _svSwitchView === 'function') _svSwitchView('sunburst');
};

window._svZoomOut = function() {
  const parent = _svParentPath(window._svFocus || '');
  window._svFocus = parent;
  if (typeof _svSwitchView === 'function') _svSwitchView('sunburst');
};

window._svZoomTo = function(pathPrefix) {
  window._svFocus = pathPrefix || '';
  if (typeof _svSwitchView === 'function') _svSwitchView('sunburst');
};

function _svFilterTable(pathPrefix) {
  if (typeof window.selectCategory === 'function') {
    window.selectCategory('all');
    setTimeout(() => {
      const urlBox = document.getElementById('sc-url-search');
      if (urlBox) {
        urlBox.value = pathPrefix;
        if (typeof scFilterByUrl === 'function') scFilterByUrl(pathPrefix);
        else urlBox.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 60);
  }
}

function _scRenderSiteStructureTree(root) {
  const renderNode = (node, depth) => {
    const kids = Object.values(node.children).sort((a, b) => b.count - a.count);
    const label = depth === 0 ? '(root)' : node.name;
    const leaf = node.leaf;
    let statusColor = '#64748b';
    let statusText = '';
    if (leaf) {
      const sc = leaf.status_code;
      if (sc >= 400) { statusColor = '#ef4444'; statusText = `HTTP ${sc}`; }
      else if (sc >= 300) { statusColor = '#f59e0b'; statusText = `redirect ${sc}`; }
      else if (sc >= 200) { statusColor = '#22c55e'; statusText = `${sc}`; }
    } else {
      statusText = '(no page crawled at this path)';
    }
    const issueCount = leaf ? (leaf.issues || []).length : 0;
    const hasKids = kids.length > 0;
    // Collapse every sub-folder by default — only the root is expanded so the
    // user lands on a clean overview and clicks the carets they want to dig
    // into. With deep crawls (200+ URLs in nested paths), full-expansion was
    // an unreadable wall of text.
    const rowId = 'sv' + Math.random().toString(36).slice(2, 9);
    const initiallyOpen = depth === 0;
    let row = `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:4px;cursor:${hasKids?'pointer':'default'};${depth===0?'border-bottom:1px solid #e2e8f0;margin-bottom:4px;':''}"
           onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background=''"
           ${hasKids ? `onclick="document.getElementById('${rowId}').style.display=document.getElementById('${rowId}').style.display==='none'?'':'none';this.querySelector('.sv-caret').textContent=this.querySelector('.sv-caret').textContent==='▸'?'▾':'▸'"` : ''}>
        <span class="sv-caret" style="width:12px;font-size:10px;color:#94a3b8;text-align:center;">${hasKids ? (initiallyOpen ? '▾' : '▸') : '·'}</span>
        <span style="font-family:'SF Mono','Menlo',monospace;font-size:12.5px;color:${leaf?'#6366f1':'#64748b'};font-weight:${leaf?600:400};">${label || '/'}</span>
        ${leaf ? `<span style="font-family:'SF Mono','Menlo',monospace;font-size:10.5px;color:${statusColor};">${statusText}</span>` : `<span style="font-family:'SF Mono','Menlo',monospace;font-size:10.5px;color:#94a3b8;">${statusText}</span>`}
        ${issueCount ? `<span style="font-size:10.5px;color:#f59e0b;">${issueCount} issue${issueCount>1?'s':''}</span>` : ''}
        <span style="margin-left:auto;font-family:'SF Mono','Menlo',monospace;font-size:10px;color:#94a3b8;">${node.count} URL${node.count>1?'s':''}</span>
      </div>`;
    if (hasKids) {
      row += `<div id="${rowId}" style="padding-left:${(depth+1)*14}px;${initiallyOpen ? '' : 'display:none;'}">`;
      row += kids.map(c => renderNode(c, depth + 1)).join('');
      row += `</div>`;
    }
    return row;
  };
  return `<div style="font-family:inherit;">${renderNode(root, 0)}</div>`;
}

// Generic anchors that fail Google's "anchor as relevance signal" expectation
// AND fail accessibility (screen readers announce out of context).
const _SC_GENERIC_ANCHORS = new Set(['click here','read more','learn more','more','here','this','this page','find out more','find out','more info','more information','details','view','view more','see more','see details','link','website','this link','click','tap here','tap','open','go','go here','continue','continue reading','full story']);

function _scRenderAnchorTextCloud() {
  const counts = {};
  let totalLinks = 0;
  Object.entries(crawlerInlinks || {}).forEach(([target, arr]) => {
    (arr || []).forEach(e => {
      let anchor = (typeof e === 'string') ? '' : (e.anchor || '');
      anchor = (anchor || '').trim();
      if (!anchor) return;
      if (anchor.length > 60) anchor = anchor.slice(0, 60) + '…';
      const key = anchor.toLowerCase();
      if (!counts[key]) counts[key] = { display: anchor, count: 0, targets: new Set() };
      counts[key].count++;
      counts[key].targets.add(target);
      totalLinks++;
    });
  });
  const items = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 80);
  if (!items.length) {
    return `<div style="padding:32px;text-align:center;color:#64748b;font-size:13px;">
      No anchor text captured yet. Anchor data is collected as the crawler discovers internal links — let the crawl finish, then re-open this view.
    </div>`;
  }
  const max = items[0].count;
  const min = items[items.length - 1].count;
  const palette = ['#0ea5e9', '#22c55e', '#a855f7', '#06b6d4', '#ec4899', '#14b8a6', '#6366f1'];
  const _scEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Count generic occurrences for the banner.
  const genericItems = items.filter(it => _SC_GENERIC_ANCHORS.has(it.display.toLowerCase()));
  const genericLinks = genericItems.reduce((n, it) => n + it.count, 0);
  const genericPct = totalLinks ? Math.round((genericLinks / totalLinks) * 100) : 0;

  const tags = items.map((it, i) => {
    const ratio = max === min ? 1 : (it.count - min) / (max - min);
    const fontSize = (12 + ratio * 26).toFixed(1);
    const opacity = (0.55 + ratio * 0.45).toFixed(2);
    const isGeneric = _SC_GENERIC_ANCHORS.has(it.display.toLowerCase());
    // Generic anchors are flagged red regardless of frequency colour so the
    // user spots them at a glance — Google treats anchor text as a
    // destination-relevance signal, generic anchors waste it.
    const color = isGeneric ? '#dc2626' : palette[i % palette.length];
    const safe = _scEsc(it.display);
    const titleAttr = isGeneric
      ? `${safe} — generic anchor (${it.count}×). Google can't tell what the linked page is about. Rewrite to describe the destination topic.`
      : `${safe} — used ${it.count} time${it.count===1?'':'s'} pointing to ${it.targets.size} URL${it.targets.size===1?'':'s'}`;
    const extra = isGeneric ? `border:1px solid rgba(220,38,38,0.4);background:rgba(254,226,226,0.6);` : '';
    const badge = isGeneric ? `<span style="margin-left:5px;font-size:9.5px;font-weight:700;color:#fff;background:#dc2626;padding:1px 5px;border-radius:8px;letter-spacing:.4px;text-transform:uppercase;">⚠</span>` : '';
    return `<span class="sv-cloud-tag" style="display:inline-block;padding:5px 10px;font-size:${fontSize}px;font-weight:${500 + Math.round(ratio*300)};color:${color};opacity:${opacity};line-height:1.25;cursor:pointer;border-radius:6px;transition:background .12s,opacity .12s;${extra}"
        onmouseover="this.style.background='#f1f5f9';this.style.opacity='1';"
        onmouseout="this.style.background='${isGeneric ? 'rgba(254,226,226,0.6)' : ''}';this.style.opacity='${opacity}';"
        title="${titleAttr}">${safe}<span style="font-size:10.5px;font-weight:600;color:#64748b;margin-left:4px;opacity:.85;">${it.count}</span>${badge}</span>`;
  }).join(' ');

  const banner = genericItems.length ? `
    <div style="margin:0 0 12px;padding:11px 14px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.35);border-left:3px solid #ef4444;border-radius:6px;font-size:12px;color:#7f1d1d;line-height:1.5;">
      <div style="font-weight:700;color:#991b1b;margin-bottom:3px;">⚠ ${genericItems.length} generic anchor${genericItems.length===1?'':'s'} found · ${genericLinks} link${genericLinks===1?'':'s'} (${genericPct}% of internal links)</div>
      <div>Anchors like <em>"Read more"</em>, <em>"Click here"</em>, <em>"Learn more"</em> are an SEO problem. Google uses anchor text as a topical relevance signal for the destination page — generic anchors give it nothing to work with. They also fail accessibility (screen readers announce the anchor out of context).</div>
      <div style="margin-top:5px;"><strong>Fix:</strong> rewrite each generic anchor so it describes what the linked page is <em>about</em> — match the target page's topic / primary keyword. (e.g. "Read more →" becomes "private in-home care services →".)</div>
    </div>` : '';

  return `
    ${banner}
    <div style="display:flex;flex-wrap:wrap;gap:6px 8px;align-items:baseline;justify-content:center;background:#f8fafc;border-radius:10px;padding:24px 22px;line-height:1.6;">
      ${tags}
    </div>
    <div style="margin-top:10px;font-size:11px;color:#64748b;text-align:center;">
      Top ${items.length} anchor text${items.length===1?'':'s'} used in internal links · size = frequency. Red border / ⚠ = generic anchor (rewrite recommended).
    </div>`;
}
