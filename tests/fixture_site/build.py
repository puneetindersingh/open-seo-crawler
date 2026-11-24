#!/usr/bin/env python3
"""Build the fault fixture site.

One deliberate fault per page, named in the path, so a failing assertion points
at exactly one check. Everything is generated rather than committed as 40 loose
files, and the 2MB page is generated rather than stored.

    python3 build.py            # writes ./site/

The server that hosts it (serve.py) adds the faults that need HTTP behaviour
rather than markup: the redirect and the 404.
"""
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'site')

# Every page links here so no page is an accidental orphan, except the ones
# that are meant to be.
NAV = ('<nav><a href="/">Home</a> <a href="/about/">About</a> '
       '<a href="/services/">Services</a></nav>')


def page(body, head='', doctype=True, html_tag=True, head_tag=True, body_tag=True):
    """Assemble a page, with the option to leave out structural tags."""
    parts = []
    if doctype:
        parts.append('<!doctype html>')
    if html_tag:
        parts.append('<html lang="en-AU">')
    if head_tag:
        parts.append('<head><meta charset="utf-8">'
                     '<meta name="viewport" content="width=device-width, initial-scale=1">'
                     + head + '</head>')
    elif head:
        parts.append(head)
    if body_tag:
        parts.append('<body>' + body + '</body>')
    else:
        parts.append(body)
    if html_tag:
        parts.append('</html>')
    return '\n'.join(parts)


def canonical(href):
    return f'<link rel="canonical" href="{href}">'


def write(path, text):
    full = os.path.join(OUT, path.strip('/'), 'index.html') if not path.endswith('.html') \
        else os.path.join(OUT, path.strip('/'))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as fh:
        fh.write(text)


def build(base='http://127.0.0.1:8099'):
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    # --- clean pages: these must produce none of the new findings ------------
    write('/', page(
        f'{NAV}<h1>Fixture home</h1><p>' + ('Real sentences about a real thing. ' * 40) + '</p>'
        '<p><a href="/clean-second/">A second clean page</a> '
        '<a href="/lorem/">Placeholder page</a> '
        '<a href="/images-no-dims/">Images page</a> '
        '<a href="/forms-insecure/">Forms page</a> '
        '<a href="/local-links/">Local links page</a> '
        '<a href="/canonical-fragment/">Canonical fragment</a> '
        '<a href="/canonical-to-404/">Canonical to 404</a> '
        '<a href="/canonical-to-redirect/">Canonical to redirect</a> '
        '<a href="/canonical-to-noindex/">Canonical to noindex</a> '
        '<a href="/noindex-hub/">Noindex hub</a> '
        '<a href="/dead-end/">Dead end</a> '
        '<a href="/blog/">Blog</a> '
        '<a href="/search/?q=widgets">Search</a> '
        '<a href="/hreflang-en/">Hreflang EN</a> '
        '<a href="/hreflang-fr/">Hreflang FR</a> '
        '<a href="/big/">Big document</a> '
        '<a href="/no-head/">No head</a> '
        '<a href="/no-body/">No body</a> '
        # The canonical targets have to be IN the crawl, or the crawl-level
        # checks have nothing to compare a canonical against.
        '<a href="/gone/">A page that 404s</a> '
        '<a href="/old-url/">A page that redirects</a> '
        '<a href="/redirect-links/">Links to redirects</a> '
        '<a href="/placement/">Link placement</a> '
        '<a href="/inert-markup/">Inert markup</a> '
        '<a href="/noindex-target/">A noindex page</a> '
        '<a href="/accents/">Accented title</a> '
        # Bot checks served as 2xx pages, a redirect loop, and a link
        # carrying Shopify's search tracking parameters (same page as
        # /services/, so it must not become a second row).
        '<a href="/challenge-200/">Bot check with a 200</a> '
        '<a href="/challenge-202/">Bot check with a 202</a> '
        '<a href="/loop-a/">Redirect loop</a> '
        '<a href="/services/?_pos=2&amp;_sid=a1b2c3&amp;_ss=r&amp;_kx=zz">Services from search</a> '
        # Bot readability pages: serve.py answers some crawler user agents
        # differently, which is the fault each one carries.
        '<a href="/bot-blocked/">Blocked for one bot</a> '
        '<a href="/bot-cloaked/">Different title for one bot</a> '
        '<a href="/bot-thin/">Thin for one bot</a> '
        '<a href="/bot-mobile-thin/">Thin on mobile</a> '
        '<a href="/bot-redirect/">Redirect for one bot</a> '
        '<a href="/bot-noindex/">noindex for one bot</a> '
        '<a href="/bot-js/">Needs JavaScript</a> '
        '<a href="/bot-noindex-js/">noindex removed by JavaScript</a> '
        '<a href="/bot-ai-directives/">AI directives</a></p>',
        head=f'<title>Fixture home</title><meta name="description" content="A home page for the fault fixture site, long enough not to be flagged as short by the meta description check.">{canonical(base + "/")}'))

    write('/clean-second/', page(
        f'{NAV}<h1>A clean second page</h1><p>' + ('Ordinary copy that says something. ' * 40) + '</p>'
        '<p><a href="/">Home</a></p>',
        head=f'<title>A clean second page</title><meta name="description" content="A second clean page, present so the clean case is asserted and not merely assumed by the fixture.">{canonical(base + "/clean-second/")}'))

    write('/about/', page(f'{NAV}<h1>About</h1><p>' + ('About copy here. ' * 40) + '</p>',
                          head=f'<title>About</title><meta name="description" content="About page for the fixture site, written long enough to avoid the short description finding.">{canonical(base + "/about/")}'))
    write('/services/', page(f'{NAV}<h1>Services</h1><p>' + ('Services copy here. ' * 40) + '</p>',
                             head=f'<title>Services</title><meta name="description" content="Services page for the fixture site, written long enough to avoid the short description finding.">{canonical(base + "/services/")}'))

    # --- one fault per page --------------------------------------------------
    write('/lorem/', page(
        f'{NAV}<h1>Maintenance reports</h1>'
        '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
        + ('Then some real copy carries on. ' * 30) + '</p>',
        head=f'<title>Placeholder copy</title><meta name="description" content="Page carrying lorem ipsum placeholder text in its opening paragraph, which is the fault under test here.">{canonical(base + "/lorem/")}'))

    write('/images-no-dims/', page(
        f'{NAV}<h1>Images with no dimensions</h1><p>' + ('Copy about images. ' * 40) + '</p>'
        '<img src="/a.jpg" alt="A picture of something">'
        '<img src="/b.jpg" alt="Another picture">'
        '<img src="/c.jpg" alt="Sized correctly" width="400" height="300">',
        head=f'<title>Images with no dimensions</title><meta name="description" content="Two images with no width or height attributes and one sized correctly, for the layout shift check.">{canonical(base + "/images-no-dims/")}'))

    write('/forms-insecure/', page(
        f'{NAV}<h1>Insecure form</h1><p>' + ('Copy about the form. ' * 40) + '</p>'
        '<form action="http://example.com/subscribe" method="post">'
        '<input name="email"><button>Send</button></form>',
        head=f'<title>Insecure form</title><meta name="description" content="A form posting to a plain http URL on another host, which is the insecure form fault under test.">{canonical(base + "/forms-insecure/")}'))

    write('/local-links/', page(
        f'{NAV}<h1>Links a visitor cannot open</h1><p>' + ('Copy about links. ' * 40) + '</p>'
        '<p><a href="http://localhost:3000/admin">Admin</a> '
        '<a href="https://10.0.0.5/panel">Panel</a> '
        '<a href="https://staging.example.com/thing">Staging</a> '
        '<a href="https://dev.to/article">A real website</a></p>',
        head=f'<title>Local and staging links</title><meta name="description" content="Links to localhost, a private address and a staging subdomain, plus one real site that must stay quiet.">{canonical(base + "/local-links/")}'))

    write('/canonical-fragment/', page(
        f'{NAV}<h1>Canonical with a fragment</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Canonical with a fragment</title><meta name="description" content="The canonical on this page carries a fragment, which resolves to a different URL than the one written.">{canonical(base + "/canonical-fragment/#reviews")}'))

    write('/canonical-to-404/', page(
        f'{NAV}<h1>Canonical to a missing page</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Canonical to a 404</title><meta name="description" content="The canonical names a URL that returns 404, so this page hands indexing to somewhere that cannot be indexed.">{canonical(base + "/gone/")}'))

    write('/canonical-to-redirect/', page(
        f'{NAV}<h1>Canonical to a redirect</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Canonical to a redirect</title><meta name="description" content="The canonical names a URL that redirects elsewhere, so Google has to follow a hop to reach the real page.">{canonical(base + "/old-url/")}'))

    write('/canonical-to-noindex/', page(
        f'{NAV}<h1>Canonical to a noindex page</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Canonical to a noindex page</title><meta name="description" content="The canonical names a page set to noindex, so neither URL ends up in the index at all.">{canonical(base + "/noindex-target/")}'))

    write('/noindex-target/', page(
        f'{NAV}<h1>A page set to noindex</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Noindex target</title><meta name="robots" content="noindex, follow"><meta name="description" content="A noindex page that another page wrongly names as its canonical, used by the canonical target check.">{canonical(base + "/noindex-target/")}'))

    # A noindex hub is the ONLY page linking to /only-from-noindex/.
    write('/noindex-hub/', page(
        f'{NAV}<h1>Noindex hub</h1><p>' + ('Copy here. ' * 40) + '</p>'
        '<p><a href="/only-from-noindex/">The page this hub links to</a></p>',
        head=f'<title>Noindex hub</title><meta name="robots" content="noindex, follow"><meta name="description" content="A noindex archive page which is the only inbound link to another page, for the link equity check.">{canonical(base + "/noindex-hub/")}'))

    write('/only-from-noindex/', page(
        f'{NAV}<h1>Linked only from a noindex page</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Linked only from a noindex page</title><meta name="description" content="Indexable page whose only inbound internal link comes from a noindex hub, so no link equity reaches it.">{canonical(base + "/only-from-noindex/")}'))

    # Dead end: no outgoing links at all, not even the nav.
    write('/dead-end/', page(
        '<h1>Dead end</h1><p>' + ('This page links nowhere. ' * 40) + '</p>',
        head=f'<title>Dead end</title><meta name="description" content="A page with no internal outlinks at all, so crawling and link equity both stop when they arrive here.">{canonical(base + "/dead-end/")}'))

    # Pagination: rel=next declared, nothing links to page 2.
    write('/blog/', page(
        f'{NAV}<h1>Blog</h1><p>' + ('Posts would be listed here. ' * 40) + '</p>',
        head=f'<title>Blog</title><link rel="next" href="{base}/blog/page/2/"><meta name="description" content="A blog index declaring rel next while nothing on the page links to page two with an anchor tag.">{canonical(base + "/blog/")}'))
    write('/blog/page/2/', page(
        f'{NAV}<h1>Blog page 2</h1><p>' + ('More posts. ' * 40) + '</p>',
        head=f'<title>Blog page 2</title><link rel="prev" href="{base}/blog/"><meta name="description" content="The second page of the blog, reachable only by the rel next declaration on page one of the series.">{canonical(base + "/blog/page/2/")}'))

    # Reachable only through the 301, so its row keeps original_url and the
    # canonical-target check has a redirecting URL to find.
    write('/redirect-target/', page(
        f'{NAV}<h1>Redirect target</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Redirect target</title><meta name="description" content="The destination of the fixture redirect, linked from nowhere so the redirecting row survives the crawl.">{canonical(base + "/redirect-target/")}'))
    # Links that only redirect, each to a page the crawl reaches anyway: /about
    # 301s to /about/ (its slash twin, linked from the nav), /moved/ 301s to
    # /services/. A crawler that drops a redirect landing on a page it holds,
    # or never fetches a slash twin, reports neither.
    write('/redirect-links/', page(
        f'{NAV}<h1>Links to redirects</h1><p>' + ('Copy here. ' * 40) + '</p>'
        '<p><a href="/about">About, written without the slash</a> '
        '<a href="/moved/">A page that moved</a> '
        '<a href="/services/?view">Services with a bare parameter</a></p>',
        head=f'<title>Links to redirects</title><meta name="description" content="A page whose links point at URLs that redirect to pages the crawl reaches through the navigation anyway.">{canonical(base + "/redirect-links/")}'))
    # Link placement. The body carries page-setting classes that name no
    # region (a Divi page has et-tb-has-footer, other themes et_fixed_nav or
    # has-header-image); a crawler that reads them labels every copy link footer
    # or nav. Copy links must read as copy, real regions keep their label.
    write('/placement/', '<!doctype html><html lang="en-AU"><head><meta charset="utf-8">'
          '<title>Link placement</title>'
          '<meta name="description" content="Copy links on a page whose body classes mention a header, a footer and a nav, plus links in real regions.">'
          f'{canonical(base + "/placement/")}</head>'
          '<body class="et-tb-has-header et-tb-has-footer et_fixed_nav has-header-image">'
          f'{NAV}<div id="main-content"><h1>Link placement</h1><p>' + ('Copy here. ' * 40) + '</p>'
          '<p>Read <a href="/clean-second/">the second clean page</a> in the copy.</p>'
          '<div class="panel bg-navy"><p><a href="/dead-end/">A link on a navy panel</a></p></div>'
          '<section class="et_pb_fullwidth_header"><a href="/blog/">A hero button</a></section></div>'
          '<div class="site-footer"><a href="/lorem/">A footer link</a></div>'
          '<div class="et-l et-l--header"><a href="/accents/">A theme builder header link</a></div>'
          '</body></html>')
    # Inert markup: a theme's sitewide chrome that looks like faults to a raw
    # read. A tracking pixel's <noscript><img> closes the head early, payment
    # icons in the footer are inline SVGs with <title> names, the mega menu
    # sits in a <template>, a quick-view dialog with its own h2 renders ahead
    # of the main content, and its product image is an alt="" copy of the
    # described one. None of that is a fault. The one real fault is the
    # lifestyle photo in a section with alt="".
    write('/inert-markup/', '<!doctype html><html lang="en-AU"><head><meta charset="utf-8">'
          '<title>Inert markup</title>'
          '<meta name="description" content="Sitewide theme chrome that a raw read mistakes for faults: icon titles, a menu template and a quick-view dialog.">'
          f'{canonical(base + "/inert-markup/")}'
          '<script>var tpl = "<div><title>in a string</title></div>";</script>'
          '<noscript><img height="1" width="1" src="/px.gif"></noscript>'
          '<meta name="x-verify" content="1"></head><body>'
          '<header><nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/services/">Services</a>'
          '<template x-if="open"><div class="card"><img alt="" src="/files/promo-card.jpg" width="400" height="300">'
          '<p>Our range</p><a href="/services/">Shop now</a><svg><title>Arrow</title><path d="M0 0"/></svg>'
          '</div></template></nav></header>'
          '<div id="QuickView" x-cloak><div role="dialog" aria-modal="true"><h2>Product name</h2>'
          '<div class="hidden"><img alt="" src="/files/product.png?width=600" width="600" height="600"></div></div></div>'
          '<main><h1>Inert markup</h1><img alt="A product on a plate" src="/files/product.png?width=1780" width="1780" height="1780">'
          '<h2>Details</h2><p>' + ('Copy here. ' * 40) + '</p>'
          '<section><img alt="" src="/files/lifestyle-photo.jpg" width="800" height="600"></section></main>'
          '<footer><ul><li><svg role="img" aria-labelledby="pi-a"><title id="pi-a">Card A</title><path d="M0 0"/></svg></li>'
          '<li><svg role="img" aria-labelledby="pi-b"><title id="pi-b">Card B</title><path d="M0 0"/></svg></li></ul></footer>'
          '</body></html>')
    write('/search/', page(
        f'{NAV}<h1>Search results</h1><p>' + ('Results would appear here. ' * 40) + '</p>',
        head=f'<title>Search results</title><meta name="description" content="An internal search results page, which is thin, infinite in number, and has no business being indexed.">{canonical(base + "/search/")}'))

    # Hreflang: EN names FR, FR never names EN back.
    write('/hreflang-en/', page(
        f'{NAV}<h1>English page</h1><p>' + ('English copy. ' * 40) + '</p>',
        head=f'<title>English page</title><link rel="alternate" hreflang="en" href="{base}/hreflang-en/">'
             f'<link rel="alternate" hreflang="fr" href="{base}/hreflang-fr/">'
             f'<meta name="description" content="English page naming a French alternate which never names it back, so the cluster is one way.">{canonical(base + "/hreflang-en/")}'))
    write('/hreflang-fr/', page(
        f'{NAV}<h1>Page francaise</h1><p>' + ('French copy. ' * 40) + '</p>',
        head=f'<title>Page francaise</title><link rel="alternate" hreflang="fr" href="{base}/hreflang-fr/">'
             f'<meta name="description" content="French page that declares only itself, which is what breaks the return link the English page expects.">{canonical(base + "/hreflang-fr/")}'))

    # Structural faults.
    write('/no-head/', page(
        f'{NAV}<h1>No head element</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head='', head_tag=False))
    write('/no-body/', page(
        f'{NAV}<h1>No body element</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>No body</title>{canonical(base + "/no-body/")}', body_tag=False))

    # Over 2MB: Google stops reading an HTML document at about that size.
    filler = '<p>' + ('Padding sentence used only to pass the two megabyte mark. ' * 20) + '</p>\n'
    body = f'{NAV}<h1>A very large document</h1>' + filler * 1900
    write('/big/', page(body,
                        head=f'<title>A very large document</title><meta name="description" content="An HTML document deliberately larger than two megabytes, past the point Google stops reading one.">{canonical(base + "/big/")}'))

    # Non-ASCII text with no charset anywhere: the server sends a bare
    # text/html and the page has no <meta charset>. Browsers read that as
    # UTF-8; a crawler that falls back to ISO-8859-1 reports mojibake.
    write('/accents/', '<!doctype html><html lang="fr"><head>'
          '<title>Café crème brûlée</title>'
          '<meta name="description" content="Une page en français avec des accents, servie sans charset, pour vérifier le décodage.">'
          f'{canonical(base + "/accents/")}</head><body>{NAV}<h1>Crème brûlée</h1><p>'
          + ('Du texte ordinaire avec des accents: é, è, ê, ç, à. ' * 30) + '</p></body></html>')

    # Bot readability pages. The HTML is ordinary; serve.py varies the
    # response by user agent.
    words = ('Plain sentences about widgets and how they are made. ' * 30)
    for path, title in (('/bot-blocked/', 'Blocked for one bot'),
                        ('/bot-cloaked/', 'The same title for everyone'),
                        ('/bot-thin/', 'Thin for one bot'),
                        ('/bot-mobile-thin/', 'Thin on mobile'),
                        ('/bot-redirect/', 'Redirect for one bot')):
        write(path, page(f'{NAV}<h1>{title}</h1><p>{words}</p>',
                         head=f'<title>{title}</title><meta name="description" content="A bot readability fixture page with enough words to compare.">{canonical(base + path)}'))
    write('/bot-noindex/', page(f'{NAV}<h1>noindex for Googlebot only</h1><p>{words}</p>',
                                head=f'<title>noindex for Googlebot only</title><meta name="googlebot" content="noindex">{canonical(base + "/bot-noindex/")}'))
    # Content written by script: the raw HTML has an empty shell.
    write('/bot-js/', page(
        f'{NAV}<h1>Needs JavaScript</h1><div id="app"></div>'
        '<script>document.getElementById("app").innerHTML = "<p>" + '
        '"Words that only exist after the script runs. ".repeat(40) + "</p>";</script>',
        head=f'<title>Needs JavaScript</title>{canonical(base + "/bot-js/")}'))
    # noindex in the HTML that a script removes: Google may never run it.
    write('/bot-noindex-js/', page(
        f'{NAV}<h1>noindex removed by JavaScript</h1><p>{words}</p>'
        '<script>var m = document.querySelector("meta[name=robots]"); if (m) m.remove();</script>',
        head=f'<title>noindex removed by JavaScript</title><meta name="robots" content="noindex">{canonical(base + "/bot-noindex-js/")}'))
    write('/bot-ai-directives/', page(
        f'{NAV}<h1>AI directives</h1><p>{words}</p><p data-nosnippet>Kept out of snippets.</p>',
        head=f'<title>AI directives page</title><meta name="robots" content="noarchive, nocache, max-snippet:20">{canonical(base + "/bot-ai-directives/")}'))

    # A page only the sitemap knows about, for the sitemap-only report.
    write('/sitemap-only/', page(
        f'{NAV}<h1>Only in the sitemap</h1><p>' + ('Copy here. ' * 40) + '</p>',
        head=f'<title>Only in the sitemap</title><meta name="description" content="A page listed in the XML sitemap that no page on the site links to, for the sitemap-only report.">{canonical(base + "/sitemap-only/")}'))

    # The sitemap lists the clean core pages plus one of each sitemap fault: a
    # 404, a redirect, a noindex page and a page nothing links to. Crawled pages
    # it leaves out (the clean second page, say) belong in "missing from sitemap".
    listed = ['/', '/about/', '/services/', '/gone/', '/old-url/',
              '/noindex-target/', '/sitemap-only/']
    with open(os.path.join(OUT, 'sitemap.xml'), 'w', encoding='utf-8') as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                 + ''.join(f'  <url><loc>{base}{p}</loc><lastmod>2026-10-01</lastmod></url>\n'
                           for p in listed)
                 + '</urlset>\n')

    with open(os.path.join(OUT, 'robots.txt'), 'w', encoding='utf-8') as fh:
        # CCBot is kept out of the bot pages, so the bot check has a robots.txt
        # disallow to report for one crawler.
        fh.write(f'User-agent: *\nAllow: /\n\nUser-agent: CCBot\nDisallow: /bot-\n\nSitemap: {base}/sitemap.xml\n')

    return OUT


if __name__ == '__main__':
    out = build()
    n = sum(len(f) for _r, _d, f in os.walk(out))
    print(f'fixture site written to {out} ({n} files)')
