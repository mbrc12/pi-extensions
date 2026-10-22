# Chapter worker brief

Fill the angle brackets and send as the task for a subagent. Keep every constraint; each one
exists because dropping it caused a defect.

---

Convert chapter <N> of a scanned book into this project's XML format.

**Book:** "<Title>", <edition>.
**PDF:** `<absolute path>`
**Chapter:** <N>, "<chapter title>", PDF pages **<lo>–<hi>** inclusive.
**Output:** `<book dir>/ch<NN>.xml` plus crops in `<book dir>/figures/`.

## Read first

1. `<book dir>/README.md` or the schema reference at
   `~/.pi/agent/extensions/skills/bookify/references/schema.md`.
2. `<book dir>/ch<exemplar>.xml` — the finished chapter whose fidelity you must match.

## Method

- Render pages with
  `pdftoppm -f <page> -l <page> -r 200 -png <pdf> /tmp/ch<NN>/pg` and **read the images**.
  Transcribe from the image, not from the OCR dump.
- The OCR dump (`/tmp/book/text.txt`, pages split by form feed) is a locator only. It is
  unreliable for symbols and useless for mathematics.
- Work in chunks of 3–5 pages: append to the XML, then re-validate. Durable progress beats a
  perfect single pass.

## Structure

- `<chapter n="<N>" title="Chapter <N> — <title>" eyebrow="<Author> · <Book> · <edition>">`
- `<section id="s<N>-<n>" n="<N>.<n>" title="…">`; nest for `<N>.<n>.<m>`. Unnumbered headings
  get `n=""` and stay nested at the level they appear.
- `<p>` paragraphs. Keep the author's wording; silently repair OCR damage; do not invent.
- Inline maths `$…$`; escape `<` as `&lt;` and `&` as `&amp;`.
- Display equations: `<eq id="eq-<N>-<k>" n="<N>-<k>">LaTeX</eq>`, numbered as printed.
  If one is genuinely unreadable, crop it: `<eq id="eq-<N>-<k>" n="<N>-<k>" src="figures/eq<N>-<kk>.png"/>`.
  Never guess a formula.
- Figures: `<fig id="fig-<N>-<k>" n="<N>.<k>" src="figures/fig<N>-<kk>.png" alt="…">caption</fig>`,
  cropped at 300 dpi, tight, inspected; re-crop if an axis label is clipped.
- Tables: `<table id="table-<N>-<k>" n="<N>.<k>" caption="…">` with `<columns>/<col>` and
  `<row>/<cell>`.
- Problems: `<problems><problem id="prob-<N>-<k>" n="<N>-<k>"><statement>…</statement><solution>one-line hint</solution></problem>…</problems>`.
  Omit if the book prints none. No invented numeric answers.
- Cross-references: `<ref to="eq-<N>-<k>" soft="yes" text="(<N>-<k>)"/>`, likewise for `fig-`,
  `s`, `prob-`, and `<ref to="ch<k>" soft="yes" text="Chapter <k>"/>`.

## Validate

```bash
python3 ~/.pi/agent/extensions/skills/bookify/scripts/bookify.py check <book dir>/ch<NN>.xml
```

Must print `valid`. Fix every error it reports.

Optionally check coverage against the scan:

```bash
python3 ~/.pi/agent/extensions/skills/bookify/scripts/check.py <book dir>/ch<NN>.xml \
    --text /tmp/book/text.txt --range <lo>,<hi> --chapter <N>
```

## Boundaries

- Do not modify any other chapter, `book.xml`, `bookify.py`, `style.css`, `template.html`, or
  any HTML output.
- Do not run a whole-book build; validate your chapter only.

## Report

When finished, report: sections, numbered equations (and whether the run is contiguous),
figures, problems, footnotes, any page the scan defeats, and confirmation that validation
passed.
