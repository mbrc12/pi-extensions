# Pipeline, step by step

## 0. Look before you build

```bash
pdfinfo book.pdf            # pages, whether a text layer exists
pdftotext -f 1 -l 3 -layout book.pdf - | head -40
```

- **Text layer quality decides everything.** Internet Archive scans usually have one, and it is
  good on prose, useless on maths. Read a dense page: if you see `Vxéé=-pu—`, the layer is only
  a locator.
- Note the page size (points). Crops are computed in points and converted at the render DPI.

## 1. Dumps

```bash
python3 scripts/pdf_probe.py dump book.pdf --work /tmp/book
```

Two files:

- `text.txt` — `pdftotext -layout`, pages separated by form feed. Good for headings, captions,
  running heads, and for finding chapter boundaries.
- `bbox.html` — `pdftotext -bbox-layout`. Word boxes in points. **Do not parse it with an XML
  parser**: the document contains characters that break strict XML. Strip everything before
  `<body>` and parse `<page>/<block>/<line>/<word>` with regexes, or only use it for coordinates.

## 2. Chapter ranges

```bash
printf 'Introduction\nScalar diffraction\nFresnel and Fraunhofer diffraction\n' > /tmp/titles.txt
python3 scripts/pdf_probe.py ranges book.pdf --titles /tmp/titles.txt --skip 20
```

Why this is fiddly: running heads repeat the chapter title on every page, so a naive search
finds page 12 for "Chapter 4". The script only inspects the first lines of a page and can skip
the front matter. Even then, **verify the boundaries by rendering one page either side**:

```bash
python3 scripts/pdf_probe.py page book.pdf 86 --out /tmp/p86.png --dpi 150
```

A chapter opening page has the title at the top and no running head.

## 3. Per-chapter conversion

One worker per chapter, one owner per file (`references/delegation.md`).

Ground rules for whoever transcribes:

- Render at 180–220 dpi and **read the image**. Use the OCR dump only to find where you are.
- Work in chunks of 3–5 pages; append and re-validate after each chunk so a crash loses little.
- Write prose that reads as English; repair OCR noise silently but never invent content.
- Transcribe numbered equations in LaTeX. If one is genuinely unreadable, crop it
  (`<eq … src="figures/eqNN-kk.png"/>`). Never guess a formula.
- Crop every figure at 300 dpi, inspect it, and re-crop if an axis label is clipped.
- Use `<ref … soft="yes"/>` for anything that may not exist yet.

Crop helper:

```bash
# fractions of the page, or exact points from bbox.html
python3 scripts/pdf_probe.py crop book.pdf 143 --frac 0.12,0.30,0.90,0.62 --out figures/fig4-03.png
python3 scripts/pdf_probe.py crop book.pdf 143 --points 58,196,432,382 --out figures/eq4-11.png
```

## 4. Validate each chapter

```bash
python3 scripts/bookify.py check book/ch04.xml          # schema + refs, writes nothing
python3 scripts/check.py book/ch04.xml --text /tmp/book/text.txt --range 85,118 --chapter 4
```

`check` is a hard gate (unknown element, bad attribute, unresolved hard ref).
`check.py` is a coverage report: sections, figures, problems, and which printed equation
numbers never made it into the file. Skipped page ranges show up as long missing runs
(`28-50`), which is the signal to send the worker back.

## 5. Make ids unique

```bash
python3 scripts/normalize.py ids book/
```

Workers independently invent `intro`, `problems`, `references`. Namespacing them per chapter
(`intro-6`, `problems-2`) prevents silent cross-link breakage. Run it every time chapters land.

## 6. Build

```bash
python3 scripts/bookify.py build book/book.xml --stats      # index + chapter pages
python3 scripts/bookify.py build book/book.xml --single     # one file, images inlined
```

`--stats` prints element counts and the number of unresolved soft refs. Aim for zero
unresolved refs except the genuinely external ones.

`--single` writes **only** `book.html`; the default writes `index.html` + `chNN.html`. Do not
expect both in one directory: chapter pages built with `--single` would carry same-page
anchors and break.

## 7. Verify the HTML

```bash
python3 scripts/verify_html.py book/*.html
```

Checks anchors (same page and cross-page), missing images, duplicate ids, unbalanced braces
inside maths, and raw `<` inside maths. It strips `<script>`/`<style>` first — inline JS always
contains strings that look like links.

Then check rendering in a real browser (headless is fine):

```js
// KaTeX actually ran, and nothing is left as literal TeX
({ katex: document.querySelectorAll('.katex').length,
   errors: document.querySelectorAll('.katex-error').length,
   dollars: (document.body.innerText.match(/\$/g) || []).length })
```

`errors` must be 0 and `dollars` must be 0 in the visible region. `katex === 0` on a page with
maths means the renderer never ran — see pitfalls.

## 8. Flatten (optional)

```bash
python3 scripts/normalize.py flatten book/book.xml   # → book_all.xml with chapters inlined
```

Useful to ship one source file, or to diff the whole book at once.

## Costs and scale

- A 30-page chapter: one worker, 30–90 minutes, ~150 paragraphs, 40–90 equations, 10–30 figures.
- A 100-page chapter is better split into two workers with different equation ranges, both
  inserting into the same file **sequentially** (never concurrently).
- Cropping is the slow part: each `pdftoppm` call is ~0.2–0.5 s. 250 figures ≈ 2 minutes.
- `--single` on a 500-page book: ~10 MB with WebP at 1100 px and quality 80. PNG at 300 dpi
  gave 57 MB. Downsample, always.
