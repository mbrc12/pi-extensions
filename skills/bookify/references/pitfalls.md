# Failure catalogue

Every entry is something that actually happened, with the fix. Read this before debugging.

## Maths

**Raw `$…$` visible everywhere.** Script ordering. KaTeX's auto-render ran on a DOM that a
pagination library had already cloned, so the visible copy was never processed. Fix: render
maths first, then do anything that copies the DOM; if you paginate, use the library's preview
API and call it from the maths callback.

**`katex: 0` on a page that clearly has maths.** The router only rendered elements it knew
about (`.chapter-slot`) while the page used a different root (`<article>`), so nothing was
selected. Fix: fall back to rendering `main` when the expected containers are absent.

**A short sentence where a formula used to be, then text resumes mid-sentence.** A raw `<`
inside inline maths (`$a<b$`) was parsed as an HTML tag. Fix: `&lt;` or `\lt`. This one is
silent — the browser repairs the HTML and you see "garbage".

**XML parse error at a column pointing into a formula.** A bare `&` in `\begin{aligned}`.
Fix: `&amp;` (XML parsing catches it, unlike the `<` case).

**Braces never balance.** `\left( … \right` or `\begin{cases}` without `\end{cases}`. The
verifier reports the span; fix at source.

## Assembly

**Duplicate ids across chapters.** Two workers both wrote `id="problems"`. Fix:
`normalize.py ids`, which namespaces generic ids and rewrites same-file refs. Run it after
every batch of chapters.

**Refs render as plain text.** Either `soft="yes"` and the target is missing, or the chapter
label (`ch5`) was never registered. The build registers chapter anchors from `n=`; soft misses
are counted by `--stats`.

**Only one chapter is reachable in the single file.** Chapters were put in the DOM but hidden
(`hidden` attribute) and only revealed by a router. Scrolling hits a dead end. Fix: keep them
in normal flow and render lazily; hide nothing.

**Chapter pages show raw maths.** They were built in `--single` mode, so they contain
same-page anchors and no cross-page links; or the renderer skipped them because it only handled
book mode. Fix: `--single` writes one file only, never chapter pages.

## Images

**57 MB single file.** Base64 PNG at 300 dpi. Fix: convert to WebP, cap width at ~1100 px,
quality 80 → ~10 MB for 250 figures. Keep the PNG crops on disk for editing.

**Figure crops include the printed caption**, so the caption appears twice (once in the image,
once as text). Fix: crop above the caption line; if the caption is inside the image because the
figure bleeds into it, add a `--points` crop that ends a few points higher.

**Crops clip axis labels.** Always inspect the crop. Nudge the box by a few points and re-render;
this is normal and takes 2–3 iterations for dense figures.

**A figure swallowed neighbouring text.** The crop start was "previous block bottom + 3",
which included body text. Fix: crop from the bottom of the last *text* line above the caption,
not from the last block, and verify visually.

**Missing `figures/…png` at build time.** The build errors with `missing image`. Either restore
the file (stale sweeps are easy to over-apply — demo images are referenced too) or fix the path.

## Layout and controls

**Sidebar will not scroll independently.** `position: sticky` inside a grid item that stretches
to full content height has no room to stick. Fix: `.shell { align-items: start }` plus
`height: 100vh; overflow-y: auto` on the sidebar, and `overscroll-behavior: contain`.

**Chevron floats above its label.** A text glyph (`▸`) inserted with `::before` in a block
context sits on its own line. Fix: grid summary (`grid-template-columns: .85rem 1fr`), chevron
as a clipped triangle with `margin-top: .5em`, rotate 90° when open.

**Text-size buttons zoom the whole page.** They set `html { font-size }`, so the sidebar
scales too. Fix: set the size on the article (`main#content`), and express in-article heading
sizes in `em` so they follow.

**Dark mode leaves controls light.** The control background was hard-coded `#fff`. Fix: a
`--ctrl-bg` variable defined per theme, used by toolbar, search, and any raised surface.

**Icons invisible in dark mode.** `fill` inherited a dark ink on a dark button. Fix: inline SVG
using `stroke="currentColor"`, and `color` set by the theme.

**Buttons too small for their icons.** Fix: size the button, not the SVG — 2.3 × 2.15 rem hit
area with a 20 px icon, and a shared border to form a segmented control.

## Performance

**Whole book renders at once.** 4,800 KaTeX spans take seconds and block scrolling. Fix: lazy
render per chapter — IntersectionObserver with a generous rootMargin, plus a
`requestIdleCallback` queue for the rest. First paint stays fast, and by the time the reader
scrolls, the maths is there.

**Single file still feels heavy.** 10 MB parse is fine; decoding 250 images is not. Fix:
`loading="lazy" decoding="async"` on every `<img>`.

## Tooling and environment

**CSS file loads but nothing applies.** Some local servers wrap `.css` in an HTML viewer and
return zero rules. Fix: inline the stylesheet into `<style>` at build time (the renderer does
this) and keep the `.css` file as the editable source.

**`import torch` fails inside IPython.** A user startup profile injected an attribute into
`object.__dict__`, so `dir()` exposes it and torch's init loop trips over it. Unrelated to
bookify, but it blocks validation scripts: run browser/QA scripts with plain `python`.

**`pdftoppm -singlefile` with several pages** silently writes only the first page. Pass `-f`/`-l`
and one page at a time.

**`pdftotext -bbox-layout` output is not valid XML.** Strip the head; parse with regexes.

## Content

**Worker "finished" but skipped 60 pages.** Counts look plausible until you compare equation
numbers with the scan. Fix: `check.py` reports missing runs; send the worker back with the
explicit number list.

**Worker invents solutions/numeric answers.** Ask for one-line reasoning hints, not answers.

**Figure numbers referenced before they exist.** e.g. problem figures printed as a block before
the problems section. Put the figure block immediately before `<problems>` and reference it from
the statements; `<statement>` is inline-only.

**Book prints a figure with no caption** (rare). Give it a descriptive caption and say so in the
`alt`, rather than shipping a bare image.
