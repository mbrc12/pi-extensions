#!/usr/bin/env python3
"""Render a book (or one chapter) from XML into a screen-reading HTML.

    uv run bookify.py build  book.xml              # chapter pages + index
    uv run bookify.py build  book.xml --single     # one self-contained file
    uv run bookify.py check  chapter.xml           # validate, write nothing

Source of truth is the XML next to the book. Images are resolved against the
book directory (usually ./figures/); with --single they are inlined as WebP.

A `<book>` root pulls in chapter files with `<include src="chNN.xml"/>`, resolves
every reference across all chapters, and writes one document.

Schema (content only; presentation lives in template.html and style.css):

  book      @title @author @edition        children: include/src
  chapter   @n @title @eyebrow             children: section, problems, footnotes
  section   @id @n @title                  nestable
  p, note, quote, list/item, code, output
  eq        @id @n [numbered="no"] [src="..."]     body is TeX, or an image if src
  fig       @id @n @src @alt [wide="yes"]          body is the caption
  table     @id @n @caption                        columns/col, row/cell
  demo      @id @n @title                          p, code, output, api/fn, fig, note
  api/fn    @name @doc
  problems / problem @id @n                        statement, solution
  footnotes / footnote @n

Inline: $math$, <em>, <strong>, <code>, <ref to="" [text=""] [soft="yes"]>,
        <link href="">, <fnref n="">, <br/>
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from html import escape
from pathlib import Path

HERE = Path(__file__).resolve().parent          # skill scripts dir
ASSETS = HERE.parent / "assets"
BOOK_DIR = Path(".")                             # set per invocation
TEMPLATE: Path | None = None

NOUN = {"eq": "", "fig": "Fig.", "section": "§", "demo": "Demo", "problem": "Prob.", "table": "Table"}


class Build:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.labels: dict[str, tuple[str, str, str, str]] = {}
        self.current_chapter = ""
        self.pages: dict[str, str] = {}
        self.single = False
        self.embed_chapters = True
        self._data_cache: dict[str, str] = {}
        self.soft_misses: list[str] = []
        self.counts: dict[str, int] = {}

    # ---------------------------------------------------------------- helpers
    def err(self, node: ET.Element, message: str) -> None:
        line = getattr(node, "sourceline", None)
        self.errors.append(f"{node.tag}: {message}" + (f" (line {line})" if line else ""))

    def warn(self, node: ET.Element, message: str) -> None:
        self.warnings.append(f"{node.tag}: {message}")

    def img_src(self, path: str) -> str:
        """Return an inline data: URI when embedding, so the page needs no image files.

        Scanned crops are large PNGs; they are downsampled and re-encoded as WebP so the
        single-file book stays a few megabytes instead of tens.
        """
        if not EMBED or not path or path.startswith(("data:", "http")):
            return path
        if path in self._data_cache:
            return self._data_cache[path]
        file = BOOK_DIR / path
        if not file.exists():
            self.err(ET.Element("img"), f"missing image {path}")
            return path

        import base64, io
        from PIL import Image

        with Image.open(file) as im:
            im = im.convert("RGB")
            max_width = IMG_WIDTH
            if im.width > max_width:
                im = im.resize((max_width, round(im.height * max_width / im.width)),
                               Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="WEBP", quality=IMG_QUALITY, method=4)
        uri = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()
        self._data_cache[path] = uri
        return uri

    def text(self, value: str | None) -> str:
        return escape(value or "", quote=False)

    def collect(self, root: ET.Element, chapter: str = "") -> None:
        for node in root.iter():
            if node.tag == "chapter" and node.get("n"):
                chapter = node.get("n")
                self.labels[f"ch{chapter}"] = ("chapter", chapter, node.get("title", ""), chapter)
            nid = node.get("id")
            if not nid:
                continue
            if nid in self.labels:
                self.err(node, f"duplicate id {nid!r}")
            self.labels[nid] = (node.tag, node.get("n", ""), node.get("title", ""), chapter)

    # ---------------------------------------------------------------- inline
    def inline(self, node: ET.Element) -> str:
        out = [self.text(node.text)]
        for child in node:
            tag = child.tag
            if tag == "ref":
                out.append(self.ref(child))
            elif tag == "link":
                href = child.get("href", "")
                out.append(f'<a href="{escape(href)}">{self.inline(child)}</a>')
            elif tag == "fnref":
                n = child.get("n", "")
                out.append(f'<sup class="ref"><a href="#fn-{n}">{escape(n)}</a></sup>')
            elif tag == "br":
                out.append("<br>")
            elif tag in {"em", "strong", "code"}:
                out.append(f"<{tag}>{self.inline(child)}</{tag}>")
            else:
                self.err(child, f"unknown inline element <{tag}>")
                out.append(self.inline(child))
            out.append(self.text(child.tail))
        return "".join(out)

    def ref(self, node: ET.Element) -> str:
        target = node.get("to", "")
        fallback = node.get("text", target)
        if target not in self.labels:
            if node.get("soft") == "yes":
                self.soft_misses.append(target)
                return escape(fallback)
            self.err(node, f"unresolved reference {target!r}")
            return escape(fallback)
        kind, n, title, owner = self.labels[target]
        same_page = self.single or owner == self.current_chapter
        href = f"#{target}" if same_page else f"ch{int(owner):02d}.html#{target}"
        text = node.get("text")
        if text is None:
            if kind == "chapter":
                text = f"Chapter {n}"
            elif kind == "eq":
                text = f"({n})" if n else title
            elif kind == "section":
                text = f"§{n}" if n else title
            else:
                text = f"{NOUN.get(kind, '')} {n}".strip()
        return f'<a href="{href}">{escape(text)}</a>'

    # ---------------------------------------------------------------- blocks
    def eq(self, node: ET.Element) -> str:
        n = node.get("n", "")
        numbered = node.get("numbered", "yes") != "no"
        cls = "eq" if numbered else "eq plain"
        num = f'<div class="num">({escape(n)})</div>' if numbered else ""
        src = node.get("src")
        if src:
            body = (f'<img class="eqimg" src="{self.img_src(src)}" loading="lazy" decoding="async" '
                    f'alt="Equation{" " + n if n else ""}, scanned from the book">')
        else:
            body = "$$\n" + escape((node.text or "").strip(), quote=False) + "\n$$"
        return (f'<div class="{cls}" id="{node.get("id", "")}">\n'
                f'  <div class="math">{body}</div>\n  {num}\n</div>')

    def fig(self, node: ET.Element, level: str = "") -> str:
        src, alt = node.get("src", ""), node.get("alt", "")
        if not src:
            self.err(node, "missing src")
        if not alt:
            self.err(node, "missing alt text")
        caption = self.inline(node).strip()
        n = node.get("n", "")
        prefix = f"<strong>Figure {escape(n)}</strong> — " if n else ""
        cls = ' class="wide"' if node.get("wide") == "yes" else ""
        return (f'<figure id="{node.get("id", "")}"{cls}>\n'
                f'  <img src="{self.img_src(src)}" alt="{escape(alt)}" loading="lazy" decoding="async">\n'
                f'  <figcaption>{prefix}{caption}</figcaption>\n</figure>')

    def table(self, node: ET.Element) -> str:
        caption = node.get("caption", "")
        columns = [self.inline(c) for c in node.findall("columns/col")]
        head = "".join(f'<th scope="col">{c}</th>' for c in columns)
        rows = []
        for row in node.findall("row"):
            cells = "".join(f"<td>{self.inline(c)}</td>" for c in row.findall("cell"))
            rows.append(f"<tr>{cells}</tr>")
        n = node.get("n", "")
        cap_prefix = f"<strong>Table {escape(n)}</strong> — " if n else ""
        return (f'<table id="{node.get("id", "")}">\n'
                f'  <caption>{cap_prefix}{escape(caption)}</caption>\n'
                f'  <thead><tr>{head}</tr></thead>\n  <tbody>\n    '
                + "\n    ".join(rows) + "\n  </tbody>\n</table>")

    def demo(self, node: ET.Element) -> str:
        n, title = node.get("n", ""), node.get("title", "")
        parts = [f'<div class="demo" id="{node.get("id", "")}">',
                 f'  <p class="demo-head">Demo {escape(n)} <span class="title">— {escape(title)}</span></p>']
        for child in node:
            tag = child.tag
            if tag == "p":
                parts.append(f"  <p>{self.inline(child)}</p>")
            elif tag == "note":
                parts.append(f'  <p class="note">{self.inline(child)}</p>')
            elif tag == "code":
                lang = child.get("lang", "python")
                parts.append(f'  <pre><code class="language-{escape(lang)}">'
                             f'{escape(child.text or "").rstrip()}</code></pre>')
            elif tag == "output":
                parts.append(f'  <pre class="out"><samp>{escape((child.text or "").strip())}\n</samp></pre>')
            elif tag == "api":
                parts.append("  " + self.api(child))
            elif tag == "fig":
                parts.append("  " + self.fig(child))
            else:
                self.err(child, f"unknown element in demo: <{tag}>")
        parts.append("</div>")
        return "\n".join(parts)

    def api(self, node: ET.Element) -> str:
        rows = []
        for fn in node.findall("fn"):
            name, doc = fn.get("name", ""), fn.get("doc", "")
            link = f' · <a href="{escape(doc)}">docs</a>' if doc else ""
            rows.append(f'<dt><code>{escape(name)}</code>{link}</dt>'
                        f'<dd>{self.inline(fn).strip()}</dd>')
        return '<dl class="api">' + "".join(rows) + "</dl>"

    def problem(self, node: ET.Element) -> str:
        statement, solution = node.find("statement"), node.find("solution")
        if statement is None or solution is None:
            self.err(node, "problem needs <statement> and <solution>")
            return ""
        return (f'<li id="{node.get("id", "")}"><strong>{escape(node.get("n", ""))}.</strong> '
                f'{self.inline(statement).strip()}\n'
                f'  <details class="solution"><summary>Solution</summary><div class="body">\n'
                f'    {self.inline(solution).strip()}\n  </div></details>\n</li>')

    def section(self, node: ET.Element, toc: list) -> str:
        n, title = node.get("n", ""), node.get("title", "")
        node_id = node.get("id", "")
        level = node.get("level", "2")
        if not n and level == "2":
            level = "3"          # unnumbered subhead: run-in level, indented in the TOC
        toc.append((node_id, n, title))
        extra = ' class="demo-index"' if "index of demonstrations" in title.lower() else ""
        parts = [f'<h{level} id="{node_id}"{extra}>{escape(f"{n} {title}".strip())}</h{level}>']
        parts.extend(self.blocks(node, toc))
        return "\n".join(parts)

    def blocks(self, parent: ET.Element, toc: list | None = None) -> list[str]:
        toc = toc if toc is not None else []
        out = []
        for child in parent:
            tag = child.tag
            if tag == "section":
                out.append(self.section(child, toc))
            elif tag == "p":
                out.append(f"<p>{self.inline(child)}</p>")
            elif tag == "note":
                out.append(f'<p class="note">{self.inline(child)}</p>')
            elif tag == "eq":
                out.append(self.eq(child))
            elif tag == "fig":
                out.append(self.fig(child))
            elif tag == "table":
                out.append(self.table(child))
            elif tag == "demo":
                out.append(self.demo(child))
            elif tag == "h4":
                out.append(f"<h4>{self.inline(child)}</h4>")
            elif tag == "list":
                items = "".join(f"<li>{self.inline(li)}</li>" for li in child.findall("item"))
                out.append(f"<ul>{items}</ul>")
            elif tag == "quote":
                out.append(f"<blockquote><p>{self.inline(child)}</p></blockquote>")
            elif tag == "problems":
                items = "".join(self.problem(p) for p in child.findall("problem"))
                out.append(f'<ol class="problems">\n{items}\n</ol>')
            elif tag == "footnotes":
                rows = []
                for fn in child.findall("footnote"):
                    n = fn.get("n", "")
                    rows.append(f'  <p id="fn-{escape(n)}"><span class="ref">{escape(n)}</span> '
                                f'{self.inline(fn).strip()}</p>')
                out.append('<aside class="footnotes">\n' + "\n".join(rows) + "\n</aside>")
            else:
                self.err(child, f"unknown block element <{tag}>")
        return out

    # ---------------------------------------------------------------- output
    def chapter_html(self, root: ET.Element, *, top: bool, show_toc: bool = True) -> str:
        n, title = root.get("n", ""), root.get("title", "")
        eyebrow = root.get("eyebrow", "")
        toc: list[tuple[str, str, str]] = []
        body = "\n".join(self.blocks(root, toc))
        head = []
        if eyebrow:
            head.append(f'<p class="eyebrow">{escape(eyebrow)}</p>')
        head.append(f'<h1 id="ch{n}">{escape(title)}</h1>')
        nav = self.section_toc(toc) if (toc and show_toc) else ""
        return (f'<article class="chapter">\n<header class="doc">\n  '
                + "\n  ".join(head) + "\n</header>\n\n" + nav + "\n\n" + body + "\n</article>")

    def section_toc(self, toc: list[tuple[str, str, str]]) -> str:
        links = "".join(
            f'<li class="{"l2" if n.count(".") >= 2 else "l1"}"><a href="#{i}">{(n + " " + t).strip()}</a></li>'
            for i, n, t in toc)
        return (f'<nav class="toc" aria-label="Sections of this chapter">\n'
                f'  <h2 class="toc-head">Sections</h2>\n  <ol>{links}</ol>\n</nav>')

    def _walk_tags(self, tag: str):
        return [n for n in getattr(self, "_all_nodes", []) if n.tag == tag]

    def page(self, title: str, header: str, content: str, nav: str,
             head: str = "", script: str = "", body_class: str = "") -> str:
        script = script or MATH_SCRIPT
        tpl = TEMPLATE or (BOOK_DIR / "template.html")
        if not tpl.exists():
            tpl = ASSETS / "template.html"
        css_file = BOOK_DIR / "style.css"
        css = css_file.read_text() if css_file.exists() else (ASSETS / "style.css").read_text()
        template = tpl.read_text().replace("{{css}}", css)
        return (template
                .replace("{{title}}", escape(title))
                .replace("{{header}}", header)
                .replace("{{toc}}", "")
                .replace("{{nav}}", nav)
                .replace("{{head}}", head)
                .replace("{{script}}", script)
                .replace("{{bodyclass}}", body_class)
                .replace("{{content}}", content))

    def pager(self, prev_ch: ET.Element | None, next_ch: ET.Element | None) -> str:
        parts = ['<nav class="pager" aria-label="Chapter navigation">']
        parts.append('<a class="pager-home" href="index.html">Contents</a>')
        if prev_ch is not None:
            parts.append(f'<a class="pager-prev" href="ch{int(prev_ch.get("n")):02d}.html">'
                         f'← Chapter {prev_ch.get("n")}</a>')
        if next_ch is not None:
            parts.append(f'<a class="pager-next" href="ch{int(next_ch.get("n")):02d}.html">'
                         f'Chapter {next_ch.get("n")} →</a>')
        parts.append("</nav>")
        return "\n  ".join(parts)

    def book_sidebar(self, chapters: list[ET.Element], title: str, author: str,
                     current: str = "", intro: str = "", single: bool = False) -> str:
        """Sidebar: brand, search + controls, demo switch, chapter/section tree."""
        items = []
        for ch in chapters:
            n = ch.get("n", "")
            here = (n == current)
            prefix = "" if (here or single) else f"ch{int(n):02d}.html"
            label = ch.get("title", "").split("—")[-1].strip()
            opened = " open" if here else ""
            items.append(f'<details class="chnav"{opened}><summary>'
                         f'<a href="{prefix}#ch{n}">Chapter {n} · {escape(label)}</a></summary>')
            sub = []
            for node in ch.iter("section"):
                nid, num, sect = node.get("id", ""), node.get("n", ""), node.get("title", "")
                if not nid:
                    continue
                depth = "s1" if not num else ("s2" if num.count(".") < 2 else "s3")
                demo = " demo-index" if "index of demonstrations" in sect.lower() else ""
                sub.append(f'<li class="{depth}{demo}"><a href="{prefix}#{nid}">'
                           f'{(num + " " + sect).strip()}</a></li>')
            items.append("<ol>" + "".join(sub) + "</ol></details>")

        def icon(paths: str, cls: str = "") -> str:
            return (f'<svg class="ico {cls}" viewBox="0 0 24 24" width="20" height="20" '
                    f'aria-hidden="true">{paths}</svg>')

        sun = icon('<circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="1.7"/>'
                   '<path d="M12 2.4v2.5M12 19.1v2.5M2.4 12h2.5M19.1 12h2.5M5.1 5.1l1.8 1.8'
                   'M17.1 17.1l1.8 1.8M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8" stroke="currentColor" '
                   'stroke-width="1.6" stroke-linecap="round"/>', "i-sun")
        moon = icon('<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.4 8.4 0 1 0 10.5 10.5z" fill="none" '
                    'stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>', "i-moon")
        smaller = icon('<path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>')
        bigger = icon('<path d="M5 12h14M12 5v14" stroke="currentColor" stroke-width="2" '
                      'stroke-linecap="round"/>')

        return (
            '<aside>\n'
            f'  <p class="brand">Goodman<strong>{escape(title)}</strong>'
            '<button class="collapse" data-act="collapse" title="Hide sidebar" aria-label="Hide sidebar">'
            '<svg class="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">'
            '<path d="M14.5 6 8.5 12l6 6" fill="none" stroke="currentColor" stroke-width="1.8" '
            'stroke-linecap="round" stroke-linejoin="round"/></svg></button></p>\n' 
            '  <div class="sidehead">\n'
            '    <input id="search" type="search" placeholder="Search the book…" aria-label="Search the book">\n'
            '    <div class="toolbar">\n'
            f'      <button data-act="theme" title="Switch theme" aria-label="Switch theme">{sun}{moon}</button>\n'
            f'      <button data-act="smaller" title="Smaller text" aria-label="Smaller text">{smaller}</button>\n'
            f'      <button data-act="bigger" title="Larger text" aria-label="Larger text">{bigger}</button>\n'
            '    </div>\n'
            '  </div>\n'
            '  <ul id="results"></ul>\n'
            '  <p class="demo-switch"><label><input type="checkbox" id="show-demos"> '
            'Show numerical demonstrations</label></p>\n'
            '  <nav aria-label="Contents">' + "".join(items) + '</nav>\n'
            + (f'  <p class="brand" style="margin-top:1.4rem"><a href="index.html">← Contents</a></p>' if intro else "")
            + '</aside>\n'
            '<button id="sidebar-open" data-act="collapse" title="Show sidebar" aria-label="Show sidebar">'
            '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">'
            '<path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" '
            'stroke-linecap="round" stroke-linejoin="round"/></svg></button>')

    def render(self, path: Path) -> dict[str, str]:
        global EMBED
        root = ET.parse(path).getroot()
        pages: dict[str, str] = {}

        if root.tag == "book":
            base = path.parent
            chapters = list(root.findall("chapter"))          # flattened book
            for inc in root.findall("include"):
                src = base / inc.get("src", "")
                ch = ET.parse(src).getroot()
                if ch.tag != "chapter":
                    raise SystemExit(f"{src}: root element must be <chapter>")
                chapters.append(ch)
            for ch in chapters:
                self.collect(ch, ch.get("n"))
            self._all_nodes = [n for c in chapters for n in c.iter()]

            title = root.get("title", "Book")
            author = root.get("author", "")
            items = "".join(
                f'<li><a href="ch{int(c.get("n")):02d}.html">{escape(c.get("title", ""))}</a></li>'
                for c in chapters)
            index_content = (f'<nav class="toc" aria-label="Chapters">\n'
                             f'  <h2 class="toc-head">Contents</h2>\n  <ol class="book-toc">{items}</ol>\n</nav>')
            header = (f'<header class="doc book-head">\n'
                      f'  <p class="eyebrow">{escape(root.get("edition", ""))}</p>\n'
                      f'  <h1>{escape(title)}</h1>\n  <p class="byline">{escape(author)}</p>\n</header>')
            pages["index.html"] = self.page(title, header, index_content, "")
            EMBED = False

            if self.single:
                self.current_chapter = ""
                EMBED = True
                parts = [self.chapter_html(ch, top=False) for ch in chapters]
                sidebar = self.book_sidebar(chapters, title, author, single=True)
                slots = []
                for i, ch in enumerate(chapters):
                    n = ch.get("n", "")
                    slots.append(f'<section class="chapter-slot" data-ch="{n}">'
                                 f'{self.chapter_html(ch, top=False, show_toc=False)}</section>')
                main_html = header + "\n" + "\n".join(slots)
                body = ('<div id="bar"></div>\n<div class="shell">\n' + sidebar
                        + '\n<main id="content">\n' + main_html + '\n</main>\n</div>')
                pages = {"book.html": self.page(
                    title, "", body, "",
                    head=READER_HEAD, script=READER_SCRIPT, body_class="reader")}

            for i, ch in enumerate(chapters if not self.single else []):
                self.current_chapter = ch.get("n")
                EMBED = bool(self.embed_chapters)
                sidebar = self.book_sidebar(chapters, title, author, current=ch.get("n"), intro="1")
                body = ('<div id="bar"></div>\n<div class="shell">\n' + sidebar
                        + '\n<main id="content">\n' + self.chapter_html(ch, top=False, show_toc=False) + '\n</main>\n</div>')
                pages[f"ch{int(ch.get('n')):02d}.html"] = self.page(
                    ch.get("title", ""), "", body, "",
                    head=READER_HEAD, script=READER_SCRIPT, body_class="reader")

        elif root.tag == "chapter":
            self.collect(root, root.get("n"))
            self._all_nodes = list(root.iter())
            self.current_chapter = root.get("n")
            pages[f"ch{int(root.get('n')):02d}.html"] = self.page(
                root.get("title", ""), "", self.chapter_html(root, top=True), "")
        else:
            raise SystemExit("root element must be <book> or <chapter>")

        for tag in ("p", "section", "eq", "fig", "table", "demo", "problem"):
            self.counts[tag] = sum(1 for _ in self._walk_tags(tag))
        if STATS:
            print("counts:", self.counts)
            print(f"soft refs unresolved: {len(self.soft_misses)}"
                  + (f" ({sorted(set(self.soft_misses))[:8]})" if self.soft_misses else ""))
        for w in self.warnings[:20]:
            print("warning:", w, file=sys.stderr)
        if self.errors:
            for e in self.errors:
                print("error:", e, file=sys.stderr)
            raise SystemExit(f"{len(self.errors)} build error(s)")
        return pages


MATH_SCRIPT = """<script>
window.addEventListener('load', function () {
  var opts = {delimiters: [{left: '$$', right: '$$', display: true},
                           {left: '$', right: '$', display: false}], throwOnError: false};
  renderMathInElement(document.body, opts);
  if (window.__afterMath) window.__afterMath();
});
</script>"""

READER_HEAD = """<style>
  /* ---------- reading shell: continuous scroll, sidebar, progress ---------- */
  body.reader { background: #fbfaf7; }
  .shell { display: grid; grid-template-columns: 19rem minmax(0, 1fr); gap: 0;
           align-items: start; }          /* start, not stretch: sticky needs room to move */
  .shell > aside { position: sticky; top: 0; height: 100vh; max-height: 100vh;
                   overflow-y: auto; overscroll-behavior: contain;
                   border-right: 1px solid var(--rule); background: #f6f4ee;
                   padding: 1.2rem 1rem 2rem; scrollbar-width: thin; }
  .shell > main { max-width: 40rem; margin: 0 auto; padding: 2.6rem 1.6rem 9rem; }
  aside .brand { font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  aside .brand strong { display: block; font-size: 1rem; letter-spacing: 0; text-transform: none;
                        color: var(--ink); margin-top: .2rem; font-weight: 400; }
  .sidehead { display: flex; align-items: stretch; gap: .35rem; margin: .85rem 0 .5rem; }
  #search { flex: 1 1 auto; min-width: 0; padding: .42rem .55rem .42rem 1.85rem; font: inherit;
            font-size: .84rem; border: 1px solid var(--rule); border-radius: 4px;
            background: var(--ctrl-bg); color: var(--ink);
            background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'><circle cx='11' cy='11' r='7'/><path d='M16.5 16.5 21 21'/></svg>");
            background-repeat: no-repeat; background-position: .58rem center; }
  #search::placeholder { color: var(--muted); }
  #results { list-style: none; margin: 0 0 .8rem; padding: 0; font-size: .84rem; }
  #results li { padding: .3rem 0; border-bottom: 1px solid var(--rule); }
  #results a { text-decoration: none; }
  #results .ctx { color: var(--muted); display: block; font-size: .78rem; }
  aside nav ol { list-style: none; margin: 0; padding: 0; font-size: .84rem; line-height: 1.45; }
  aside nav .ch { margin: .8rem 0 .25rem; font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; }
  aside nav a { color: var(--muted); text-decoration: none; display: block; padding: .1rem 0 .1rem .55rem;
                border-left: 2px solid transparent; }
  aside nav a:hover { color: var(--ink); }
  aside nav a.active { color: var(--accent); border-left-color: var(--accent); }
  aside nav .s2 { padding-left: 1.4rem; }
  aside nav .s3 { padding-left: 2.3rem; font-size: .8rem; }
  #bar { position: fixed; top: 0; left: 0; height: 2px; background: var(--accent); width: 0; z-index: 20; }
  .toolbar { display: inline-flex; flex: 0 0 auto; border: 1px solid var(--rule); border-radius: 4px;
             overflow: hidden; background: var(--ctrl-bg); }
  .toolbar button { padding: 0; min-width: 2.3rem; height: 2.15rem; display: inline-flex;
                    align-items: center; justify-content: center; border: 0;
                    border-right: 1px solid var(--rule); background: transparent;
                    color: var(--ink); cursor: pointer; }
  .toolbar button:last-child { border-right: 0; }
  .toolbar button:hover { background: var(--mark); color: var(--accent); }
  /* demo index follows the demos */
  .demo-index { display: none; }
  html.show-demos .demo-index { display: block; }
  html.show-demos li.demo-index { display: list-item; }
  /* collapsible sidebar */
  aside .brand { position: relative; }
  .collapse { position: absolute; right: -.2rem; top: -.1rem; border: 0; background: transparent;
              color: var(--muted); cursor: pointer; padding: .15rem; line-height: 0; border-radius: 3px; }
  .collapse:hover { color: var(--accent); background: var(--mark); }
  body.sidebar-collapsed .shell > main { max-width: 46rem; }
  #sidebar-open { display: none; position: fixed; left: .75rem; top: .75rem; z-index: 30;
                  border: 1px solid var(--rule); background: var(--ctrl-bg); color: var(--ink);
                  border-radius: 999px; padding: .45rem; line-height: 0; cursor: pointer;
                  box-shadow: 0 2px 8px rgba(0,0,0,.12); }
  #sidebar-open:hover { color: var(--accent); border-color: var(--accent); }
  body.sidebar-collapsed .shell { grid-template-columns: minmax(0, 1fr); }
  body.sidebar-collapsed .shell > aside { display: none; }
  body.sidebar-collapsed #sidebar-open { display: inline-flex; }
  .toolbar .ico { display: block; }
  .toolbar .i-moon { display: none; }
  body.reader.dark .toolbar .i-sun { display: none; }
  body.reader.dark .toolbar .i-moon { display: block; }
  .toolbar button:focus-visible, aside a:focus-visible, #search:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  body.reader.dark { background: #16151a; color: #e6e2da; }
  body.reader.dark .shell > aside { background: #1d1c22; border-color: #2c2b33; }
  body.reader.dark a { color: #c9a06a; }
  body.reader.dark pre { background: #201f26; border-color: #2f2e36; color: #ddd8cf; }
  body.reader.dark figure img { background: #fff; }
  body.reader.dark { --ctrl-bg:#201f26; --rule: #2f2e36; --muted: #9a958c; --ink: #e6e2da; --mark: #2a2932; }
  body.reader.dark .toolbar button:hover { background: #2a2932; color: #d9b07a; }
  @media (max-width: 900px) {
    .shell { grid-template-columns: 1fr; }
    .shell > aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--rule); }
  }
  @media print { .shell > aside, #bar, .toolbar { display: none; } .shell { display: block; } }
</style>"""

READER_SCRIPT = r"""<script>
(function () {
  var KEYBASE = 'bookify:' + location.pathname;
  var KOPTS = {delimiters: [{left: '$$', right: '$$', display: true},
                            {left: '$', right: '$', display: false}], throwOnError: false};

  function renderChapter(slot) {
    if (!slot || slot.dataset.rendered === '1') return;
    renderMathInElement(slot, KOPTS);
    if (window.Prism) Prism.highlightAllUnder(slot);
    slot.dataset.rendered = '1';
  }

  function chaptersNearViewport() {
    var slots = document.querySelectorAll('.chapter-slot');
    if (!slots.length) {                      /* single-chapter page */
      var mainEl = document.querySelector('main') || document.body;
      renderChapter(mainEl);
      return;
    }
    slots.forEach(function (slot) {
      var r = slot.getBoundingClientRect();
      if (r.top < innerHeight * 2 && r.bottom > -innerHeight) renderChapter(slot);
    });
  }

  window.addEventListener('load', function () {
    /* first paint: the chapter under the hash, plus whatever is on screen */
    var hash = decodeURIComponent(location.hash.slice(1));
    var target = hash && document.getElementById(hash);
    if (target) renderChapter(target.closest('.chapter-slot'));
    chaptersNearViewport();

    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) renderChapter(e.target);
      });
    }, {rootMargin: '1500px 0px'});
    document.querySelectorAll('.chapter-slot').forEach(function (s) { obs.observe(s); });

    /* render the rest in idle time, one chapter per slice, so scrolling never
       meets raw TeX while the first screen stays fast */
    var queue = Array.prototype.slice.call(document.querySelectorAll('.chapter-slot'))
                  .filter(function (s) { return s.dataset.rendered !== '1'; });
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 300); };
    function step() {
      if (!queue.length) return;
      renderChapter(queue.shift());
      idle(step, {timeout: 2000});
    }
    idle(step, {timeout: 2000});

    addEventListener('hashchange', function () {
      var id = decodeURIComponent(location.hash.slice(1));
      var t = id && document.getElementById(id);
      if (t) {
        renderChapter(t.closest('.chapter-slot'));
        t.scrollIntoView();
      }
    });

    /* demos: opt-in, remembered */
    var params = new URLSearchParams(location.search);
    var wantDemos = params.get('demos') === '1' || localStorage.getItem(KEYBASE + ':demos') === '1';
    document.documentElement.classList.toggle('show-demos', wantDemos);
    var box = document.getElementById('show-demos');
    if (box) {
      box.checked = wantDemos;
      box.addEventListener('change', function () {
        localStorage.setItem(KEYBASE + ':demos', box.checked ? '1' : '0');
        document.documentElement.classList.toggle('show-demos', box.checked);
      });
    }

    /* collapsible sidebar */
    var collapsed = localStorage.getItem(KEYBASE + ':collapsed') === '1';
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    document.querySelectorAll('[data-act="collapse"]').forEach(function (b) {
      b.addEventListener('click', function () {
        collapsed = !document.body.classList.contains('sidebar-collapsed');
        document.body.classList.toggle('sidebar-collapsed', collapsed);
        localStorage.setItem(KEYBASE + ':collapsed', collapsed ? '1' : '0');
      });
    });

    /* theme + text size */
    var dark = localStorage.getItem(KEYBASE + ':dark') === '1';
    document.body.classList.toggle('dark', dark);
    var article = document.getElementById('content') || document.querySelector('main');
    var size = parseFloat(localStorage.getItem(KEYBASE + ':size') || '19');
    if (article) article.style.fontSize = size + 'px';
    document.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.act;
        if (act === 'theme') {
          dark = !document.body.classList.contains('dark');
          document.body.classList.toggle('dark', dark);
          localStorage.setItem(KEYBASE + ':dark', dark ? '1' : '0');
        }
        if (act === 'bigger' || act === 'smaller') {
          if (!article) return;
          var cur = parseFloat(getComputedStyle(article).fontSize);
          cur = Math.min(26, Math.max(15, cur + (act === 'bigger' ? 1 : -1)));
          article.style.fontSize = cur + 'px';
          localStorage.setItem(KEYBASE + ':size', cur);
        }
      });
    });

    /* progress bar + active chapter in the sidebar */
    var heads = Array.prototype.slice.call(document.querySelectorAll('.chapter-slot'));
    function onScroll() {
      var h = document.documentElement.scrollHeight - innerHeight;
      var bar = document.getElementById('bar');
      if (bar) bar.style.width = (h > 0 ? (100 * scrollY / h) : 0) + '%';
      chaptersNearViewport();
      var mid = scrollY + innerHeight * 0.35, cur = heads[0];
      heads.forEach(function (s) { if (s.offsetTop <= mid) cur = s; });
      document.querySelectorAll('aside details.chnav').forEach(function (d) {
        var a = d.querySelector('summary a');
        var on = a && a.hash === '#ch' + (cur ? cur.dataset.ch : '');
        if (on && !d.open) d.open = true;
        if (!on && d.open) d.open = false;
      });
    }
    addEventListener('scroll', onScroll, {passive: true});
    onScroll();

    /* search: everything is already in the DOM */
    var input = document.getElementById('search');
    var results = document.getElementById('results');
    if (input && results) {
      var heads2 = Array.prototype.slice.call(document.querySelectorAll('main h2[id], main h3[id]'));
      var timer;
      input.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          var q = input.value.trim().toLowerCase();
          results.innerHTML = '';
          if (q.length < 2) return;
          var hits = 0;
          for (var i = 0; i < heads2.length && hits < 20; i++) {
            var h = heads2[i], node = h.nextElementSibling, buf = [];
            while (node && !/^H[23]$/.test(node.tagName)) { buf.push(node.textContent); node = node.nextElementSibling; }
            var body = buf.join(' ');
            var at = body.toLowerCase().indexOf(q);
            if (h.textContent.toLowerCase().indexOf(q) < 0 && at < 0) continue;
            var ch = h.closest('.chapter-slot');
            var snip = at < 0 ? body.slice(0, 90) : body.slice(Math.max(0, at - 40), at + 70);
            var li = document.createElement('li');
            li.innerHTML = '<a href="#' + h.id + '">' + h.textContent.trim() +
                           '</a><span class="ctx">Ch. ' + (ch ? ch.dataset.ch : '?') + ' · ' +
                           snip.replace(/\s+/g, ' ').trim() + '…</span>';
            results.appendChild(li);
            hits++;
          }
        }, 180);
      });
    }
  });
})();
</script>"""

STATS = False
EMBED = False
IMG_WIDTH = 1100
IMG_QUALITY = 80


def main() -> None:
    argv = sys.argv[1:]
    command = "build"
    if argv and argv[0] in {"build", "check"}:
        command = argv.pop(0)

    ap = argparse.ArgumentParser(prog="bookify.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="book.xml (or one chapter .xml)")
    ap.add_argument("-o", "--output", type=Path, help="output directory (default: next to the source)")
    ap.add_argument("--single", action="store_true",
                    help="write the whole book as one self-contained file (book.html)")
    ap.add_argument("--no-embed", action="store_true",
                    help="leave images as file paths instead of inlining them")
    ap.add_argument("--stats", action="store_true", help="print element counts and unresolved soft refs")
    args = ap.parse_args(argv)

    global STATS, EMBED, BOOK_DIR
    STATS = args.stats
    EMBED = not args.no_embed
    BOOK_DIR = args.source.resolve().parent

    builder = Build()
    builder.single = args.single
    pages = builder.render(args.source)

    if command == "check":
        print(f"{args.source}: valid ({len(pages)} page(s) would be written)")
        return

    outdir = args.output or BOOK_DIR
    outdir.mkdir(parents=True, exist_ok=True)
    for name, html in pages.items():
        (outdir / name).write_text(html)
    print(f"wrote {len(pages)} page(s) to {outdir}")


if __name__ == "__main__":
    main()
