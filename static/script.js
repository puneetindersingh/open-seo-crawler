// Site Crawler — client.
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
  'Missing meta description': { sev: 'error', why: 'Google falls back to scraping body copy for the SERP snippet — almost always worse CTR than a hand-written description.', sources: [['Google — Meta description', 'https://developers.google.com/search/docs/appearance/snippet'], ['Ahrefs', 'https://ahrefs.com/blog/meta-description/']] },
  'Meta desc too long': { sev: 'warn', why: 'Google truncates around 155–160 characters on desktop, shorter on mobile. Past that gets ellipsised.', sources: [['Moz', 'https://moz.com/learn/seo/meta-description']] },
  'Meta desc too short': { sev: 'warn', why: 'Under ~120 characters wastes SERP real estate and gives Google less to match against queries.', sources: [['Ahrefs', 'https://ahrefs.com/blog/meta-description/']] },
  'Missing title': { sev: 'error', why: 'The <title> is the strongest on-page ranking signal and the clickable SERP heading. Missing means Google invents one — usually badly.', sources: [['Google — Title link', 'https://developers.google.com/search/docs/appearance/title-link']] },
  'Title too long': { sev: 'warn', why: 'Google truncates titles at ~600 px (≈60 chars). Lead with the primary keyword, put brand last.', sources: [['Google — Title link', 'https://developers.google.com/search/docs/appearance/title-link']] },
  'Title too short': { sev: 'warn', why: 'Titles under ~30 chars under-use SERP real estate and miss supporting keywords.', sources: [['Moz', 'https://moz.com/learn/seo/title-tag']] },
  'Missing H1': { sev: 'error', why: 'The H1 tells users and search engines what the page is about. Missing H1s hurt accessibility (screen readers) and topical relevance.', sources: [['Ahrefs', 'https://ahrefs.com/blog/h1-tag/']] },
  'Multiple H1s': { sev: 'warn', why: 'Dilutes topical signal and usually indicates a template issue. One clear H1 per page is the safe pattern.', sources: [['Ahrefs', 'https://ahrefs.com/blog/h1-tag/']] },
  'H1 same as title': { sev: 'warn', why: 'Screaming Frog flags this as an opportunity, not an error. Title and H1 serve different jobs — identical text wastes a chance to target a second keyword angle.', sources: [['Screaming Frog', 'https://www.screamingfrog.co.uk/seo-spider/issues/page-titles/same-as-h1/']] },
  'Missing canonical': { sev: 'error', why: 'Without a canonical, Google has to guess which URL variant to index. Picks non-deterministically and splits link equity.', sources: [['Google', 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls']] },
  'Canonicalised': { sev: 'warn', why: 'The canonical points elsewhere, so Google will drop this URL from the index and keep the canonical target instead.', sources: [['Google', 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls']] },
  'imgs missing alt': { sev: 'warn', why: 'Alt text is required for accessibility (WCAG) and is how Google Images + AI engines understand visuals.', sources: [['W3C WCAG', 'https://www.w3.org/WAI/tutorials/images/'], ['Google Images', 'https://developers.google.com/search/docs/appearance/google-images']] },
  'No schema': { sev: 'warn', why: 'Without JSON-LD, Google can\'t award rich results and AI engines have to parse HTML to figure out entity/relationship signals.', sources: [['Google', 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data'], ['Schema.org', 'https://schema.org/']] },
  'Thin content': { sev: 'warn', why: 'Pages under ~200 words rarely rank because they fail to cover intent. Google\'s Helpful Content system penalises pages that don\'t satisfy the query.', sources: [['Google — Helpful content', 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content']] },
  'Slow': { sev: 'warn', why: 'Response time over 3s degrades Core Web Vitals (LCP, INP) and increases bounce. Field LCP ≤2.5s is Google\'s "good" threshold.', sources: [['Core Web Vitals', 'https://web.dev/articles/vitals']] },
  'Redirect': { sev: 'warn', why: 'Real content redirects mean inbound links hit stale URLs. Update internal links to the final destination to preserve crawl budget and link equity.', sources: [['Google', 'https://developers.google.com/search/docs/crawling-indexing/301-redirects']] },
  'noindex': { sev: 'error', why: 'The page is explicitly telling Google not to index it. Intentional for staging; catastrophic on money pages.', sources: [['Google', 'https://developers.google.com/search/docs/crawling-indexing/block-indexing']] },
  'HTTP': { sev: 'error', why: 'A 4xx/5xx response means users and Googlebot hit an error page. 404s on indexed URLs bleed link equity.', sources: [['Google', 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors']] },
  'Missing viewport': { sev: 'warn', why: 'Without viewport meta, mobile browsers render at desktop width. Google flags the page as not mobile-friendly.', sources: [['Google Mobile', 'https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing']] },
  'URL:': { sev: 'warn', why: 'URL hygiene issues (uppercase, underscores, spaces, >115 chars, tracking params) create duplicate-URL risk and hurt CTR.', sources: [['Google', 'https://developers.google.com/search/docs/crawling-indexing/url-structure']] },
  'Mixed content': { sev: 'error', why: 'HTTPS pages loading HTTP resources break the padlock and modern browsers block active mixed content.', sources: [['web.dev', 'https://web.dev/articles/what-is-mixed-content']] },
  'Missing Open Graph': { sev: 'warn', why: 'Without og:title/og:description/og:image, Facebook/LinkedIn/Slack previews scrape random page elements. Shares look ugly, CTR drops.', sources: [['Open Graph', 'https://ogp.me/']] },
  'Missing og:image': { sev: 'warn', why: 'Without an og:image, shared links render as text-only cards — significantly lower engagement. Recommended size: 1200×630.', sources: [['Open Graph', 'https://ogp.me/#structured']] },
  'Missing Twitter Card': { sev: 'info', why: 'Without twitter:card metadata, X falls back to Open Graph or plain text. Summary Large Image card gives the best preview.', sources: [['X Cards', 'https://developer.x.com/en/docs/x-for-websites/cards/overview/abouts-cards']] },
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

function renderRow(d) {
  const tbody = document.getElementById('crawler-tbody');
  const tr = document.createElement('tr');
  const statusColor = d.status_code >= 400 ? '#ef4444' : d.status_code >= 300 ? '#f59e0b' : '#22c55e';
  const path = d.url.replace(/^https?:\/\/[^\/]+/, '') || '/';
  const issues = (d.issues || []).map(i => `<span class="badge ${sevOf(i)}" title="${sevOf(i).toUpperCase()}">${escapeHtml(i)}</span>`).join('');
  const safe = d.url.replace(/"/g, '&quot;').replace(/'/g, "\\'");
  tr.innerHTML = `
    <td style="max-width:300px" title="${escapeHtml(d.url)}">
      <span class="url-cell" onclick="openDock('${safe}')">${escapeHtml(path)}</span>
      <button class="copy-icon" onclick="copyUrl(this,'${safe}')" title="Copy URL">⧉</button>
      <a class="open-icon" href="${escapeHtml(d.url)}" target="_blank" rel="noopener" title="Open in new tab">↗</a>
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
  document.getElementById('detail-title').textContent = 'All Pages';
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
  document.getElementById('detail-title').textContent = titleMap[cat] || cat;

  // Info box
  renderIssueInfo(cat);

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
  const colour = { error: '#ef4444', warn: '#f59e0b', info: '#3b82f6' }[meta.sev];
  const label = { error: 'Error', warn: 'Warning', info: 'Info' }[meta.sev];
  box.innerHTML = `<div class="info-box">
    <span class="sev-tag" style="background:${colour}22;color:${colour}">${label}</span>
    ${escapeHtml(meta.why)}
    ${meta.sources.length ? `<div class="sources">Sources: ${meta.sources.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${escapeHtml(t)}</a>`).join(' · ')}</div>` : ''}
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
    let topSev = null;
    for (const i of issues) {
      const s = sev(i);
      if (s === 'error') topSev = 'error';
      else if (s === 'warn' && topSev !== 'error') topSev = 'warn';
      else if (!topSev) topSev = 'info';
    }
    if (topSev === 'error') counts.__err++;
    else if (topSev === 'warn') counts.__warn++;
    else if (topSev === 'info') counts.__info++;

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
