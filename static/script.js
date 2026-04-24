// Open SEO Crawler — client.
let crawlerAbort = null;
let crawlerTimer = null;
let crawlerStart = 0;
let crawlerResults = [];
let crawlerInlinks = {}; // target URL -> [{source, anchor, placement}]
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
    <td style="max-width:300px" title="${escapeHtml(d.url)}">
      <span style="display:flex;align-items:center;gap:2px;min-width:0;">
        <span class="url-cell" onclick="openDock('${safe}')" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(path)}</span>
        ${_scOpenIcon(d.url)}${_scRefetchIcon(d.url)}
      </span>
    </td>
    <td style="color:${statusColor};font-weight:700">${d.status_code}</td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(d.title||'')}">${d.title ? escapeHtml(d.title) : '<em style="color:#ef4444">missing</em>'}</td>
    <td>${d.title_len || 0}</td>
    <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.meta_description ? escapeHtml(d.meta_description.substring(0,60)) : '<em style="color:#ef4444">missing</em>'}</td>
    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.h1 ? escapeHtml(d.h1) : '<em style="color:#ef4444">missing</em>'}</td>
    <td>${d.word_count || 0}</td>
    <td>${d.response_time || 0}s</td>
    <td>${issues || '<span style="color:#22c55e">OK</span>'}</td>
  `;
  tbody.appendChild(tr);
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
function startCrawl() {
  const url = document.getElementById('crawler-url').value.trim();
  if (!url) { document.getElementById('crawler-url').focus(); return; }

  crawlerAbort = new AbortController();
  crawlerStart = Date.now();
  crawlerResults = [];
  crawlerInlinks = {};
  activeCategory = 'all';

  document.getElementById('crawler-start-btn').style.display = 'none';
  document.getElementById('crawler-stop-btn').style.display = '';
  document.getElementById('crawler-stats').style.display = 'grid';
  document.getElementById('crawler-empty').style.display = 'none';
  document.getElementById('crawler-results').style.display = '';
  document.getElementById('issues-sidebar').style.display = '';
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

  crawlerTimer = setInterval(() => {
    const s = Math.floor((Date.now() - crawlerStart) / 1000);
    document.getElementById('cs-elapsed').textContent = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }, 1000);

  fetch('/crawl', {
    method: 'POST',
    signal: crawlerAbort.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      max_pages: parseInt(document.getElementById('crawler-max').value) || 200,
      max_workers: parseInt(document.getElementById('crawler-workers').value) || 5,
      crawl_delay: parseFloat(document.getElementById('crawler-speed').value),
      max_depth: parseInt(document.getElementById('crawler-depth').value) || 10,
      render_js: document.getElementById('crawler-render-js').checked,
      ignore_robots: document.getElementById('crawler-ignore-robots').checked,
      include_patterns: document.getElementById('crawler-include').value.trim(),
      exclude_patterns: document.getElementById('crawler-exclude').value.trim(),
    })
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
              updateCounts();
              // Refresh dock if the open URL got fresh data (new inlinks or its own page row)
              if (dockUrl && (dockUrl === src || (p.data.internal_link_urls || []).some(e => (Array.isArray(e) ? e[0] : e) === dockUrl))) {
                renderDock();
              }
            } else if (p.type === 'cms_detected') {
              renderCmsBanner(p);
            }
          } catch {}
        }
        return pump();
      });
    }
    return pump();
  }).catch(e => { if (e.name !== 'AbortError') console.error(e); crawlFinished(); });
}

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
  };
  document.getElementById('detail-title-text').textContent = titleMap[cat] || cat;

  // Info box
  renderIssueInfo(cat);
  _scSetColumns(cat);

  // Re-render the table with the filtered rows
  const tbody = document.getElementById('crawler-tbody');
  tbody.innerHTML = '';
  for (const r of crawlerResults) {
    if (matchesCategory(r, cat)) renderRow(r);
  }
};

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

  document.querySelectorAll('.ci-count, .sev-num').forEach(el => {
    const k = el.dataset.count;
    if (k in counts) el.textContent = counts[k];
  });
}

function stopCrawl() {
  if (crawlerAbort) crawlerAbort.abort();
}

function crawlFinished() {
  if (crawlerTimer) { clearInterval(crawlerTimer); crawlerTimer = null; }
  document.getElementById('crawler-start-btn').style.display = '';
  document.getElementById('crawler-stop-btn').style.display = 'none';
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

    const items = [
      { label: `Copy ${urls.length} URL${urls.length > 1 ? 's' : ''}`, action: () => navigator.clipboard.writeText(urls.join('\n')).then(() => scToast(`Copied ${urls.length} URL${urls.length > 1 ? 's' : ''}.`)) },
      { label: 'Copy as comma-separated', action: () => navigator.clipboard.writeText(urls.join(', ')).then(() => scToast('Copied.')) },
      { label: 'Clear selection', action: clearSelection },
    ];

    items.forEach(item => {
      const btn = document.createElement('button');
      btn.textContent = item.label;
      btn.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 14px;background:none;border:none;cursor:pointer;color:var(--text);font-size:12px;';
      btn.onmouseover = () => btn.style.background = 'var(--surface2)';
      btn.onmouseout  = () => btn.style.background = 'none';
      btn.onclick = () => { item.action(); menu.remove(); };
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  });
})();
