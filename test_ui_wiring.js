/**
 * The four-part wiring behind every page_checks finding, tested for real.
 *
 * A finding is silently useless unless all of these line up:
 *   1. sevOf            gives it a severity, or it defaults to info
 *   2. normalize        collapses a counted issue to one summary card
 *   3. matchesCategory  selects the pages that card stands for
 *   4. titleMap         gives the drill-in a heading
 *
 * The functions are lifted out of static/script.js and run here, so this fails
 * if the wiring drifts from the strings page_checks.py actually emits.
 *
 *     node test_ui_wiring.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "static", "script.js"), "utf8");

// issue string, expected severity, expected summary slug
const CASES = [
  ["Lorem ipsum placeholder text in the page copy", "error", "Lorem ipsum placeholder text in the page copy"],
  ["2 link(s) to a local or staging host (localhost, staging.example.com)", "error", "local staging links"],
  ["1 form(s) submit over HTTP (browsers warn the visitor)", "error", "insecure forms"],
  ["No <head> element (head tags land in the body)", "error", "No <head> element"],
  ["Canonical points to a non-200 URL (HTTP 404)", "error", "Canonical points to a non-200 URL"],
  ["Canonical points to a non-indexable URL", "error", "Canonical points to a non-indexable URL"],
  ["Canonical contains a fragment (Google drops everything after the #)", "warn", "Canonical contains a fragment"],
  ["Canonical points to a URL that redirects", "warn", "Canonical points to a URL that redirects"],
  ["No <body> element", "warn", "No <body> element"],
  ["Host variant redirect is temporary (http://example.com/ answers 302)", "warn", "Host variant redirect is temporary"],
  ["HTTP version does not redirect to HTTPS (http://example.com/ answers 200)", "error", "HTTP version does not redirect to HTTPS"],
  ["www and non-www both answer 200 (https://example.com/)", "warn", "www and non-www both answer 200"],
  ["HTML document over 2MB (3.1MB)", "warn", "HTML document over 2MB"],
  ["No internal outlinks (dead end for crawling and link equity)", "warn", "No internal outlinks"],
  ["Inbound internal links come only from non-indexable pages (no link equity reaches it)", "warn",
   "Inbound internal links come only from non-indexable pages"],
  ["3 pagination URL(s) declared by rel but not linked in an anchor tag (crawlers cannot follow them)",
   "warn", "pagination not linked"],
  ["2 hreflang alternate(s) do not link back (https://example.com/fr/)", "warn", "hreflang no return"],
  ["4 image(s) with no width or height (causes layout shift)", "info", "image dimensions"],
  ["URL: uppercase", "warn", "URL:"],
  ["URL: internal search result page", "warn", "URL:"],
  // Directives, reported with the meaning their owners document.
  ["noarchive (Bing keeps the page out of Copilot answers; Amazon will not train on it)", "info", "noarchive"],
  ["nocache (Bing Copilot shows only the URL, title and snippet)", "info", "nocache"],
  ["max-snippet limits the text Google can show, AI answers included (20 characters)", "info",
   "max-snippet limits the text Google can show, AI answers included"],
  ["data-nosnippet keeps sections out of snippets and AI answers (2 section(s))", "info",
   "data-nosnippet keeps sections out of snippets and AI answers"],
  ["noindex only for Googlebot (meta name=\"googlebot\")", "error", "noindex only for Googlebot"],
  // Bot readability. One card per crawler, so the heading is the card label.
  ["Search bot blocked: Googlebot smartphone (HTTP 403)", "error", "Search bot blocked: Googlebot smartphone"],
  ["AI search bot challenged: PerplexityBot (Cloudflare challenge (HTTP 403))", "error", "AI search bot challenged: PerplexityBot"],
  ["Training bot blocked: GPTBot (HTTP 403)", "info", "Training bot blocked: GPTBot"],
  ["Search bot sees different content: Bingbot (title, text)", "warn", "Search bot sees different content: Bingbot"],
  ["AI search bot sees a thinner page: PerplexityBot (35 of 278 words)", "warn", "AI search bot sees a thinner page: PerplexityBot"],
  ["AI assistant bot redirected elsewhere: ChatGPT-User (to https://example.com/)", "warn", "AI assistant bot redirected elsewhere: ChatGPT-User"],
  ["Content needs JavaScript (crawlers that do not run it see 4 of 324 words)", "warn", "Content needs JavaScript"],
  ["noindex in the HTML is removed by JavaScript (Google may skip rendering a noindex page, so it can stay out of the index)", "error",
   "noindex in the HTML is removed by JavaScript"],
  ["Mobile page has less content than desktop (33 of 276 words)", "warn", "Mobile page has less content than desktop"],
];
// Cards whose label carries a crawler name or a count: the drill-in heading
// falls back to that label, so they need no titleMap entry.
const LABEL_IS_HEADING = (slug) => / bot (blocked|challenged|sees|redirected)|^noindex only for |^content needs javascript|^noindex in the html|^mobile /i.test(slug);

function grab(header, endNeedle) {
  const start = SRC.indexOf(header);
  if (start < 0) throw new Error("not found in script.js: " + header);
  const end = SRC.indexOf(endNeedle, start);
  if (end < 0) throw new Error("end not found for " + header);
  return SRC.slice(start, end + endNeedle.length);
}

const errRe = grab("const _PAGE_CHECK_ERR_RE", ";\n");
const warnRe = grab("const _PAGE_CHECK_WARN_RE", ";\n");
const sevOf = new Function(errRe + warnRe + grab("function sevOf(issue)", "\n}\n") + "\nreturn sevOf;")();
const matchesCategory = new Function(
  errRe + warnRe + grab("function matchesCategory(page, cat)", "\n}\n") + "\nreturn matchesCategory;")();

// One shared grouping function feeds every summary panel, so the panels
// cannot disagree. Both panels must use it rather than a copy of their own.
const normalizers = [new Function(grab("function _scIssueGroup(issue)", "\n}\n") + "\nreturn _scIssueGroup;")()];
// Summary and the severity views both count through _scIssueTally, which
// groups with _scIssueGroup.
const panelsUsingShared = grab("function _scIssueTally(pages)", "\n}\n").includes("_scIssueGroup(issue)")
  ? [grab("function _scRenderSummaryPanel()", "\n}\n"), grab("function _scRenderSeverityPanel(cat)", "\n}\n")]
      .filter((f) => f.includes("_scIssueTally(")).length
  : 0;

let passed = 0;
const failures = [];
const check = (name, cond) => { cond ? passed++ : failures.push(name); };

check("both summary panels use the shared grouping", panelsUsingShared >= 2);
check("no summary panel keeps its own copy of the map", !SRC.includes("const normalize = (issue) =>"));

for (const [issue, severity, slug] of CASES) {
  check(`sevOf("${issue.slice(0, 46)}") is ${severity}`, sevOf(issue) === severity);
  normalizers.forEach((normalize, n) => {
    const [label, got] = normalize(issue);
    check(`normalize #${n} groups "${issue.slice(0, 40)}" as ${slug}`, got === slug);
    check(`normalize #${n} gives "${slug}" a label`, !!label);
  });
  const page = { url: "https://example.com/x", issues: [issue], status_code: 200, depth: 1 };
  const unrelated = { url: "https://example.com/y", issues: ["Missing title"], status_code: 200, depth: 1 };
  check(`"${slug}" selects the page its issue is on`, matchesCategory(page, slug) === true);
  check(`"${slug}" leaves an unrelated page out`, matchesCategory(unrelated, slug) !== true);
}

// Counted issues differ per page. They must still land in one card.
const a = normalizers[0]("2 link(s) to a local or staging host (localhost)")[1];
const b = normalizers[0]("7 link(s) to a local or staging host (10.0.0.5)")[1];
check("a counted issue is one card whatever the count", a === b);

// Every slug needs a drill-in heading.
for (const [, , slug] of CASES) {
  check(`titleMap has a heading for "${slug}"`, SRC.includes(`'${slug}':`) || slug === "URL:" || LABEL_IS_HEADING(slug));
}

if (failures.length) {
  failures.forEach((f) => console.log("FAIL: " + f));
  console.log(`${passed}/${passed + failures.length} UI wiring checks passed`);
  process.exit(1);
}
console.log(`${passed}/${passed} UI wiring checks passed`);
