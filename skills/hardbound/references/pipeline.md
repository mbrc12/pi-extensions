# Pipeline, step by step

## 0. Look before you build

```bash
pdfinfo book.pdf                      # pages, page size, whether a text layer exists
pdftotext -f 1 -l 3 -layout book.pdf - | head -40
```

- **The text layer decides the method.** Scans from large archives often have one; it is decent
  on prose and useless on maths. Read a dense page: if the symbols are mangled, the layer is only
  a locator.
- Note the page size in points. Crop boxes from `bbox.html` are in points; renders are pixels at
  the chosen DPI.

## 1. Dumps

```bash
python3 ~/.pi/agent/extensions/skills/hardbound/scripts/pdf_probe.py dump book.pdf --work /tmp/book
```

Two files:

- `text.txt` — `pdftotext -layout`, pages separated by form feed. Use it to find headings,
  captions, running heads, and chapter boundaries.
- `bbox.html` — `pdftotext -bbox-layout`. Word boxes in points, for cropping. Do **not** parse it
  as strict XML; strip everything before `<body>` and use regexes for `<page>/<line>/<word>`.

## 2. Chapter ranges

```bash
printf 'Introduction\nThe main idea\nAdvanced topics\n' > /tmp/titles.txt
python3 .../pdf_probe.py ranges book.pdf --titles /tmp/titles.txt --skip 20
```

Running heads repeat the chapter title on every page, so a naive search finds "Chapter 4" twenty
pages early. `ranges` only looks at the first lines of a page and can skip front matter, but
**verify the boundaries by rendering one page either side**:

```bash
python3 .../pdf_probe.py page book.pdf 86 --out /tmp/p86.png --dpi 150
```

A chapter opening has the title at the top and no running head.

## 3. Scaffold the book

```bash
mkdir -p book/content book/assets/figures
cat > book/book.toml <<'EOF'
slug = "my-book"
title = "Book Title"
author = "Author Name"
year = 2005

[[contents]]
slug = "intro"
file = "content/01-intro.md"
title = "Introduction"

[[contents]]
slug = "topics"
file = "content/02-topics.md"
title = "Further topics"
EOF
```

- One manifest entry per chapter, in reading order. The chapter number is its position.
- Add `[[contents]] part = "Part I"` entries for printed part pages.
- Add `[vars.*]` only when the book really has optional content (demos, derivations, answers);
  every variable must be used by an `if=` or it does nothing.

Syntax details: `references/markdown.md`.

## 4. Transcribe per chapter

One worker per chapter, one owner per file. Brief: `agents/chapter-worker.md`.

Ground rules for whoever transcribes:

- Render at 180–220 dpi and **read the image**. The OCR dump only tells you where you are.
- Work in chunks of 3–5 pages; append and re-run `hardbound check` after each chunk, so a crash
  loses little.
- Write prose that reads as English; repair OCR noise silently, but never invent content.
- Start the file with `# Chapter title {#chN}` and give every heading `{#id}`.
- Copy printed numbers into `n="…"` for every heading, equation, figure, and table. The builder
  never invents a printed number.
- Use anchors and empty link text: `[](#eq-4-12)`, `[](foundations!fig-3-2)`.
- Transcribe numbered equations as TeX; set `n=` to the printed number.
- If an equation is genuinely unreadable, crop it and put the crop in an unnumbered `::: figure`
  with a caption naming the equation. Never guess a formula.
- Crop every figure at 300 dpi, inspect it, and re-crop if an axis label is clipped.
- Crop above the printed caption: the caption is transcribed as text, so it must not appear twice.

Crop helper:

```bash
S=~/.pi/agent/extensions/skills/hardbound/scripts
# fractions of the page
python3 $S/pdf_probe.py crop book.pdf 143 --frac 0.12,0.30,0.90,0.62 --out book/assets/figures/fig4-03.png
# or exact points from bbox.html
python3 $S/pdf_probe.py crop book.pdf 143 --points 58,196,432,382 --out book/assets/figures/eq4-11.png
```

Downsample before adding. The builder copies assets byte for byte; a 300 dpi PNG book can reach
hundreds of megabytes. About 1100 px wide at quality 80 is plenty for screen reading.

## 5. Check

```bash
hardbound check book
```

- Exit status is non-zero on errors; every message is `file:line`.
- Fix errors before adding more chapters. Do not use `--lenient` on a finished chapter.
- `--strict` also fails on warnings; use it for a clean final pass.
- A draft full of OCR noise can use `hardbound check book --lenient` while work is in progress,
  but ship with zero errors and no `--lenient`.

Coverage against the scan (printed equation numbers that never made it into the file):

```bash
# what the scan prints, from the per-chapter page range
pdftotext -layout -f 85 -l 118 book.pdf - | grep -oE '\([0-9]+-[0-9]+[a-z]?\)' | sort -u > /tmp/scan-eq.txt
# what the chapter claims, from its n= attributes
grep -oE 'n="[0-9]+-[0-9]+[a-z]?"' book/content/04-chapter.md | cut -d'"' -f2 | sed 's/.*/(&)/' | sort -u > /tmp/book-eq.txt
comm -23 /tmp/scan-eq.txt /tmp/book-eq.txt     # printed but missing
```

Skipped page ranges show up as long runs of missing numbers, which is the signal to send the
worker back. Column layout and OCR noise make this a rough check, not a proof: eyeball it.

## 6. Build

```bash
hardbound build book -o book/out             # KaTeX from jsDelivr
hardbound build book -o book/out --offline   # vendor KaTeX, needs vendor/katex in the tool repo
```

The build runs the same validation as `check` and stops before writing if there are errors.
It prints a summary: chapters, anchors, links, images, errors, warnings.

The output is the deliverable:

```text
out/
  index.html            cover + contents
  intro.html            one complete page per chapter
  signals.html
  assets/               app.js, book.css, figures (copied from book/assets)
  data/manifest.json    nav, variables, macros
  data/targets.json     anchor registry
  data/search.json      section-level search text
```

`build` writes the current chapters but does not delete files from an earlier run. Delete `out/`
before a clean build, especially after removing or renaming a chapter.

## 7. Serve and verify

```bash
hardbound serve book/out -p 4000
```

Use this, not `file://` and not a generic static viewer. Opening the HTML directly blocks
`fetch()` of the other chapters and `data/*.json`, so the SPA, previews, and search break. Generic
servers often return `.css`, `.js`, and `.json` as `text/html`, which breaks the reader too.

Browser checks (headless is fine):

```js
({
  katex: document.querySelectorAll(".katex").length,
  errors: document.querySelectorAll(".katex-error").length,
  dollars: (document.body.innerText.match(/\$/g) || []).length,
  brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
  emptyLinks: [...document.querySelectorAll("a")].filter(a => !a.textContent.trim()).length,
})
```

- `errors` and `dollars` must be 0 in the visible region.
- `katex === 0` on a maths page means KaTeX never ran; check the console.
- `emptyLinks` > 0 usually means a reference whose target is missing. `check` reports those.

Then click through: sidebar, a cross-chapter link, a link into a fold, search, the theme and font
controls, and a 390 px viewport. Full checklist: `references/qa.md`.

## 8. Package

- Zip or copy the **`out/` folder**. It is self-contained except for KaTeX when built without
  `--offline` (or the Google Fonts links in `theme.toml`).
- For an offline deliverable, build with `--offline`; the tool vendors KaTeX from `vendor/katex`.
- There is no single-file build. If the user wants one file, say so; do not fake it by opening
  the folder from `file://`.

## Costs and scale

- A 30-page chapter: one worker, 30–90 minutes, ~150 paragraphs, 40–90 equations, 10–30 figures.
- A 100-page chapter is better split into two workers by equation range, writing the same file
  **sequentially**. Never concurrently.
- Cropping is the slow part: each `pdftoppm` call is 0.2–0.5 s. 250 figures ≈ 2 minutes.
- Build time is seconds for a 10-chapter book; image size dominates the bundle.
