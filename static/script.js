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
};

function sevOf(issue) {
  const l = (issue || '').toLowerCase();
  if (/^missing (title|h1|canonical|meta description)|^http [45]|served over http|^mixed content|^noindex|^canonicalised/.test(l)) return 'error';
  if (/too (long|short)|imgs missing alt|thin content|multiple h1|h1 same as title|missing viewport|no schema|missing open graph|missing og:image|^slow |^url:|trailing slash|^redirect \(|www normalization|http→https/.test(l)) return 'warn';
  return 'info';
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

function renderRow(d) {
  const tbody = document.getElementById('crawler-tbody');
  const tr = document.createElement('tr');
  tr.dataset.url = d.url;
  const statusColor = d.status_code >= 400 ? '#ef4444' : d.status_code >= 300 ? '#f59e0b' : '#22c55e';
  const path = d.url.replace(/^https?:\/\/[^\/]+/, '') || '/';
  const issues = (d.issues || []).map(i => `<span class="badge ${sevOf(i)}" title="${sevOf(i).toUpperCase()}">${escapeHtml(i)}</span>`).join('');
  const safe = d.url.replace(/"/g, '&quot;').replace(/'/g, "\\'");
  tr.innerHTML = `
    <td title="${escapeHtml(d.url)}">
      <span style="display:flex;align-items:center;gap:2px;min-width:0;">
        <span class="url-cell" onclick="openDock('${safe}')" style="flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(path)}</span>
        <span class="cs-cell-actions" style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;">${_scOpenIcon(d.url)}${_scRefetchIcon(d.url)}</span>
      </span>
    </td>
    <td style="color:${statusColor};font-weight:700">${d.status_code}</td>
    <td title="${escapeHtml(d.title||'')}">${d.title ? escapeHtml(d.title) : '<em style="color:#ef4444">missing</em>'}</td>
    <td>${d.title_len || 0}</td>
    <td>${d.meta_description ? escapeHtml(d.meta_description.substring(0,60)) : '<em style="color:#ef4444">missing</em>'}</td>
    <td>${d.h1 ? escapeHtml(d.h1) : '<em style="color:#ef4444">missing</em>'}</td>
    <td>${d.word_count || 0}</td>
    <td>${d.response_time || 0}s</td>
    <td>${issues || '<span style="color:#22c55e">OK</span>'}</td>
  `;
  tbody.appendChild(tr);
}

// =============================================================================
// Column resize — drag .th-resize handles to adjust column widths.
// Double-click handle to auto-fit column to content (icons included).
// Widths persist in localStorage.
// =============================================================================
const _SC_COL_KEY = 'sc_crawler_col_widths_v1';
function _scLoadColWidths() {
  try {
    const raw = localStorage.getItem(_SC_COL_KEY);
    if (!raw) return;
    const widths = JSON.parse(raw);
    document.querySelectorAll('#crawler-table colgroup col').forEach((col, i) => {
      if (typeof widths[i] === 'number' && widths[i] > 20) col.style.width = widths[i] + 'px';
    });
  } catch {}
}
function _scSaveColWidths() {
  try {
    const cols = document.querySelectorAll('#crawler-table colgroup col');
    const widths = Array.from(cols).map(c => parseInt(c.style.width, 10) || c.offsetWidth);
    localStorage.setItem(_SC_COL_KEY, JSON.stringify(widths));
  } catch {}
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
  const thead = document.getElementById('crawler-thead');
  if (!thead || thead.dataset.resizersWired === '1') return;
  thead.dataset.resizersWired = '1';
  _scLoadColWidths();
  thead.querySelectorAll('.th-resize').forEach(handle => {
    const idx = parseInt(handle.dataset.colIdx, 10);
    handle.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); _scAutoFitColumn(idx); });
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const col = document.querySelectorAll('#crawler-table colgroup col')[idx];
      if (!col) return;
      const startX = e.clientX;
      const startWidth = parseInt(col.style.width, 10) || col.offsetWidth;
      handle.classList.add('is-dragging');
      document.body.classList.add('is-col-resizing');
      const onMove = (ev) => {
        const maxW = Math.max(1200, (window.innerWidth || 4000) - 60);
        const w = Math.max(40, Math.min(maxW, startWidth + (ev.clientX - startX)));
        col.style.width = w + 'px';
      };
      const onUp = () => {
        handle.classList.remove('is-dragging');
        document.body.classList.remove('is-col-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _scSaveColWidths();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
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
  const inlinks = crawlerInlinks[dockUrl] || [];
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
    '__sm_only': 'Sitemap Only — Not Reached by Crawl', '__sm_noindex': 'Non-Indexable in Sitemap',
    '__sm_non200': 'Non-200 in Sitemap', '__sm_redirects': 'Redirects in Sitemap',
    '__sm_pagination': 'Pagination in Sitemap',
    '__nd_content': 'Near-Duplicate Content — pairs above the similarity threshold',
    '__schema_by_page': 'Schema by Page — every crawled page with the schema types it emits',
  };
  document.getElementById('detail-title-text').textContent = titleMap[cat] || cat;

  // Report-style categories (sitemap analysis, schema-by-page) render
  // their own panel. Hide the entire table-wrap (not just the table)
  // because the wrap has flex:1 and would keep the empty layout space.
  // Also hide the "double-click to expand" hint — doesn't apply.
  const _tableWrap = document.querySelector('.table-wrap');
  const _expandHint = document.querySelector('.cs-expand-hint');
  const _isReportPanel = (typeof cat === 'string') &&
    (cat.startsWith('__sm_') || cat === '__schema_by_page' || cat === '__nd_content');
  if (_isReportPanel) {
    renderIssueInfo(cat);
    const tbody = document.getElementById('crawler-tbody');
    tbody.innerHTML = '';
    if (_tableWrap) _tableWrap.style.display = 'none';
    if (_expandHint) _expandHint.style.display = 'none';
    if (cat === '__schema_by_page') {
      _renderSchemaByPagePanel();
    } else if (cat === '__nd_content') {
      _renderNearDupPanel();
    } else {
      _renderSitemapPanel(cat);
    }
    const bulkBtn = document.getElementById('crawler-bulk-recrawl-btn');
    if (bulkBtn) bulkBtn.style.display = 'none';
    return;
  }
  // Drop any sitemap/schema/near-dup panel content when switching back.
  const smPanel = document.getElementById('sitemap-panel');
  if (smPanel) smPanel.remove();
  const schemaPanel = document.getElementById('schema-by-page-panel');
  if (schemaPanel) schemaPanel.remove();
  const ndPanel = document.getElementById('near-dup-panel');
  if (ndPanel) ndPanel.remove();
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
  panel.style.cssText = 'padding:0 14px 14px;font-size:12px;';
  const rows = (crawlerResults || []).filter(r => !r.error);
  if (!rows.length) {
    panel.innerHTML = '<div style="padding:20px;color:var(--text-muted);">No crawled pages yet.</div>';
    main.appendChild(panel);
    return;
  }
  const withSchema = rows.filter(r => Array.isArray(r.schema_types) && r.schema_types.length);
  const withoutSchema = rows.length - withSchema.length;
  const typeCounts = {};
  withSchema.forEach(r => r.schema_types.forEach(t => { typeCounts[t] = (typeCounts[t] || 0) + 1; }));
  const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const escapeHtml = (s) => {
    if (s == null) return '';
    if (typeof s !== 'string') {
      try { s = Array.isArray(s) ? s.join(', ') : String(s); } catch { return ''; }
    }
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  const typeChip = (t, n) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;background:var(--surface);border:1px solid var(--border);border-radius:999px;font-size:11px;">
       <code style="font-size:10.5px;font-weight:600;color:var(--text);">${escapeHtml(t)}</code>
       <span style="color:var(--text-muted);">×${n}</span>
     </span>`;
  const summary = `
    <div style="padding:14px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;align-items:center;margin-bottom:10px;">
        <span><b style="color:#22c55e;font-size:16px;font-variant-numeric:tabular-nums;">${withSchema.length}</b> <span style="color:var(--text-muted);">with schema</span></span>
        <span><b style="color:#f59e0b;font-size:16px;font-variant-numeric:tabular-nums;">${withoutSchema}</b> <span style="color:var(--text-muted);">without</span></span>
        <span style="color:var(--text-muted);">·</span>
        <span><b style="color:var(--text);font-size:16px;font-variant-numeric:tabular-nums;">${Object.keys(typeCounts).length}</b> <span style="color:var(--text-muted);">unique type${Object.keys(typeCounts).length === 1 ? '' : 's'}</span></span>
      </div>
      ${sortedTypes.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;">${sortedTypes.map(([t, n]) => typeChip(t, n)).join('')}</div>` : ''}
    </div>`;
  const list = rows.map(r => {
    const types = Array.isArray(r.schema_types) ? r.schema_types : [];
    const path = (r.url || '').replace(/^https?:\/\/[^\/]+/, '') || '/';
    const cells = types.length
      ? types.map(t => `<code style="display:inline-block;font-size:10.5px;background:var(--surface2);color:var(--text);padding:2px 7px;border-radius:4px;margin:1px;border:1px solid var(--border);">${escapeHtml(t)}</code>`).join(' ')
      : '<span style="color:#f59e0b;font-style:italic;font-size:11px;">no schema</span>';
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:42% 1fr;gap:12px;align-items:start;font-size:11.5px;">
      <div style="word-break:break-all;"><a href="${r.url}" target="_blank" style="color:#4f46e5;" title="${escapeHtml(r.url)}">${escapeHtml(path)}</a></div>
      <div>${cells}</div>
    </div>`;
  }).join('');
  panel.innerHTML = summary + list;
  main.appendChild(panel);
}

// =============================================================================
// Near-duplicate content detection (mirrors internal-tool, no AI/AI).
// =============================================================================
function _scToggleNearDupCfg(checked) {
  const cfg = document.getElementById('crawler-neardup-cfg');
  if (cfg) cfg.style.display = checked ? '' : 'none';
}
window._scToggleNearDupCfg = _scToggleNearDupCfg;

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
  const main = document.querySelector('section#crawler-results') || document.querySelector('section.results') || document.querySelector('main') || document.body;
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
    return `<tr style="border-bottom:1px solid var(--border,#e2e8f0);">
      <td style="padding:7px 12px;font-variant-numeric:tabular-nums;font-weight:700;color:${simColor};white-space:nowrap;">${sim}%</td>
      <td style="padding:7px 12px;font-size:12px;"><a href="${p.url_a}" target="_blank" style="color:var(--accent,#6366f1);text-decoration:none;">${pathA}</a></td>
      <td style="padding:7px 12px;font-size:12px;"><a href="${p.url_b}" target="_blank" style="color:var(--accent,#6366f1);text-decoration:none;">${pathB}</a></td>
      <td style="padding:7px 12px;font-size:11px;color:var(--text-muted,#64748b);font-family:monospace;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(p.shared_phrase_sample||'').replace(/"/g,'&quot;')}">${p.shared_phrase_sample || '—'}</td>
      <td style="padding:7px 12px;text-align:right;"><button type="button" onclick="openNdDiff('${safeA}','${safeB}')" style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:5px;padding:3px 9px;font-size:11px;color:var(--accent,#6366f1);cursor:pointer;">Compare →</button></td>
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
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:var(--surface,#fff);border-bottom:2px solid var(--border,#e2e8f0);">
          <th style="text-align:left;padding:7px 12px;font-weight:600;color:var(--text-muted,#64748b);font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Sim</th>
          <th style="text-align:left;padding:7px 12px;font-weight:600;color:var(--text-muted,#64748b);font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Page A</th>
          <th style="text-align:left;padding:7px 12px;font-weight:600;color:var(--text-muted,#64748b);font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Page B</th>
          <th style="text-align:left;padding:7px 12px;font-weight:600;color:var(--text-muted,#64748b);font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Shared sample</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
  main.appendChild(panel);
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
  panel.style.cssText = 'padding:0 14px 14px;font-size:12px;';
  if (!d) {
    panel.innerHTML = '<div style="padding:20px;color:#64748b;">Click <b>Analyse</b> in the sidebar to run sitemap analysis.</div>';
    main.appendChild(panel);
    return;
  }
  const reports = d.reports || {};
  const map = {
    '__sm_missing':    { key: 'missing_from_sitemap',     hint: 'These pages are indexable, return 200, and were reached by the crawl, but are NOT in the sitemap. Add them.' },
    '__sm_orphan':     { key: 'orphan_in_sitemap',        hint: 'In the sitemap and crawled, but no internal links point to them. Link to them from related pages.' },
    '__sm_only':       { key: 'sitemap_only',             hint: 'In the sitemap but the crawl never reached them. Either truly orphan (no internal links anywhere) or buried beyond crawl depth.' },
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
    <div style="padding:10px 0 4px;font-size:13px;font-weight:600;">${cat.replace('__sm_','').replace(/^./, c => c.toUpperCase())} (${items.length})</div>
    <div style="padding-bottom:8px;font-size:11px;color:#64748b;">${info.hint}</div>
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
  const list = rows.map(r => `
    <div style="padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:11px;display:flex;gap:8px;align-items:center;">
      <a href="${r.url}" target="_blank" style="color:#4f46e5;flex:1;word-break:break-all;">${r.url}</a>
      ${r.meta ? `<span style="color:#94a3b8;font-size:10.5px;">${r.meta}</span>` : ''}
    </div>
  `).join('');
  panel.innerHTML = header + list;
  main.appendChild(panel);
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

  document.querySelectorAll('.ci-count, .sev-num').forEach(el => {
    const k = el.dataset.count;
    if (k in counts) el.textContent = counts[k];
  });
}

function stopCrawl() {
  if (crawlerAbort) crawlerAbort.abort();
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
const _SC_SORT_KEYS = ['url','status_code','title','title_len','meta_description','h1','word_count','response_time','issues'];
function _scSortRows(rows) {
  const key = _SC_SORT_KEYS[_scSortCol];
  if (!key) return rows;
  return rows.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'issues') { va = (va||[]).length; vb = (vb||[]).length; }
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

function _scSetColumns(cat) {
  const table = document.getElementById('crawler-table');
  if (!table) return;
  const all = ['title','tlen','meta','h1','words','speed'];
  table.classList.remove(...all.map(c => 'hide-col-' + c));
  const show = (cols) => table.classList.add(...all.filter(c => !cols.includes(c)).map(c => 'hide-col-' + c));
  if (cat === 'Missing meta description') return show(['url','status','title','meta','issues']);
  if (cat === 'Meta desc too long' || cat === 'Meta desc too short') return show(['url','status','meta','issues']);
  if (cat === 'Missing title') return show(['url','status','title','tlen','h1','issues']);
  if (cat === 'Title too long' || cat === 'Title too short') return show(['url','status','title','tlen','issues']);
  if (cat === 'Missing H1' || cat === 'Multiple H1s') return show(['url','status','h1','issues']);
  if (cat === 'H1 identical to title tag') return show(['url','status','title','h1','issues']);
  if (cat === 'Thin content') return show(['url','status','words','issues']);
  if (cat === 'Slow') return show(['url','status','speed','issues']);
  if (cat !== 'all' && !cat.startsWith('__')) return show(['url','status','title','issues']);
}

// Drag-select rows in the crawler table — click+drag to highlight, right-click to copy
(function() {
  let dragging = false;
  let startRow = null;
  let lastRow = null;

  function getRow(el) {
    return el && el.closest('#crawler-tbody tr[data-url]');
  }

  function clearSelection() {
    document.querySelectorAll('#crawler-tbody tr.cr-selected').forEach(r => r.classList.remove('cr-selected'));
  }

  function applySelection(a, b) {
    const rows = Array.from(document.querySelectorAll('#crawler-tbody tr[data-url]')).filter(r => r.style.display !== 'none');
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
    if (!row || !row.closest('#crawler-tbody')) return;
    if (e.button !== 0) return;
    if (e.target.closest('button,a,input,select')) return;
    dragging = true;
    startRow = row;
    lastRow = row;
    clearSelection();
    row.classList.add('cr-selected');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const row = getRow(e.target);
    if (!row || row === lastRow) return;
    lastRow = row;
    clearSelection();
    applySelection(startRow, row);
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  // Double-click any cell to expand it (wrap the full value, drop the
  // ellipsis) and auto-select for easy copy. Click again to collapse.
  document.addEventListener('dblclick', e => {
    const td = e.target.closest('#crawler-tbody td');
    if (!td) return;
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
    const selected = Array.from(document.querySelectorAll('#crawler-tbody tr.cr-selected[data-url]'));
    if (!selected.length || !e.target.closest('#crawler-tbody')) return;
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
    const copyText = (text, ok, fail) => {
      const done = (success) => scToast(success ? ok : (fail || 'Copy failed — clipboard blocked.'));
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => done(true), () => {
            try {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
              document.body.appendChild(ta);
              ta.focus(); ta.select();
              const ok2 = document.execCommand('copy');
              ta.remove();
              done(ok2);
            } catch { done(false); }
          });
          return;
        }
      } catch {}
      done(false);
    };

    const items = [
      { label: `Copy ${urls.length} URL${urls.length > 1 ? 's' : ''}`, action: () => copyText(urls.join('\n'), `Copied ${urls.length} URL${urls.length > 1 ? 's' : ''}.`) },
      { label: 'Copy as comma-separated', action: () => copyText(urls.join(', '), 'Copied as comma-separated.') },
      { label: 'Clear selection', action: clearSelection },
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
// Save / Load / Compare crawl sessions  (port of internal-tool's save+compare)
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
            <div style="font-weight:600;color:#0f172a;word-break:break-all;">${seed || c.name}</div>
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
