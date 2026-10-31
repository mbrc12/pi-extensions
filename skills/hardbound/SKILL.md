---
name: hardbound
description: Turn a scanned or PDF book into a hardbound source bundle (book.toml + Markdown + assets) and build a self-contained HTML reader with the `hardbound` tool. Covers page-image transcription, figure crops, LaTeX, cross-references, hover previews, search, folds, and view variables. Use when the user asks to convert a PDF or book into HTML/EPUB-like content, transcribe a long book chapter by chapter, or validate and rebuild an existing hardbound book.
---

# hardbound

A book is **a folder**: `book.toml`, Markdown chapters, and assets. The Rust tool `hardbound`
turns that folder into a self-contained HTML reader with a sidebar, search, hover previews,
KaTeX maths, folds, and reader-side view variables.

The source folder is the truth. `out/` is disposable and should be rebuilt, never edited.

This skill replaces the old bookify XML pipeline. There is **no XML layer**, no id-normalisation
step (anchors are namespaced by chapter slug), and no single-file build. Do not write `<chapter>`,
`<ref>`, or `book.xml`.

## When to use

- "Convert this PDF/book into a readable HTML with chapters, figures, equations."
- "Transcribe chapter 3 of this scan", "make a hardbound book from these chapters".
- "Check this book", "the links/images are broken", "rebuild the reader".
- A long technical document that needs a table of contents, cross-references, search, and maths.

Not for: a few pages of notes (write Markdown), or a book that already has clean HTML/EPUB.

## Non-negotiables

1. **Transcribe from page images, never from the OCR text layer.** OCR locates content; it does
   not represent it. A worker that copies OCR produces run-together words, broken ligatures, and
   formulas that look plausible but are wrong.
2. **The manifest and Markdown hold content only.** No CSS classes beyond the documented ones, no
   pixel sizes, no hand-written "Chapter 5" where a link can generate the label.
3. **Every anchor is stable and explicit.** `{#eq-2-13}` and `n="2-13"` carry the printed number.
   The tool never invents a printed number, so explicit `n=` is how labels stay faithful.
4. **Links carry no label when the target can generate one.** `[](#eq-2-13)` renders `Eq. (2-13)`
   in the reader, and `[the shift theorem](signals!eq-2-13)` keeps hand-written prose.
5. **`hardbound check` is the gate.** The build refuses broken books. "It should render" is how
   maths ends up as raw TeX.
6. **Serve the bundle. Never open it from `file://`.** The reader fetches other chapters and
   `data/*.json`; a file URL breaks navigation, previews, and search.

## Pipeline

```
PDF ──pdf_probe dump────▶ text.txt + bbox.html
    ──pdf_probe ranges──▶ chapter page ranges (verify by eye)
    ──workers (1/chapter)▶ content/NN-slug.md + assets/figures/*.png
    ──book.toml─────────▶ identity, contents tree, math macros, view variables
    ──hardbound check───▶ errors + warnings, writes nothing
    ──hardbound build───▶ out/index.html + out/<slug>.html + out/data/*
    ──hardbound serve───▶ real MIME types, then browser verification
```

Details and commands: `references/pipeline.md`.
Markdown and manifest syntax: `references/markdown.md`.
Failure catalogue: `references/pitfalls.md`.
Delegating chapters: `references/delegation.md` and `agents/chapter-worker.md`.
Final checklist: `references/qa.md`.

## Install or rebuild the tool

The tool is a Rust crate. If `hardbound` is not on `PATH`, install it from the crate directory:

```bash
HARDBOUND=~/path/to/hardbound       # the crate directory
cargo install --path "$HARDBOUND"
hardbound --version
```

Without installing, run the same subcommands through Cargo:

```bash
HARDBOUND=~/path/to/hardbound
HB="cargo run --release --manifest-path $HARDBOUND/Cargo.toml --"
$HB check book
```

`--offline` vendors KaTeX and needs `vendor/katex` inside the tool repository; without it, KaTeX
loads from jsDelivr.

## Quick start

```bash
S=~/dev/pi/skills/hardbound/scripts

# 1. Map the scan
python3 $S/pdf_probe.py dump book.pdf --work /tmp/book
printf 'Chapter One\nChapter Two\n' > /tmp/titles.txt
python3 $S/pdf_probe.py ranges book.pdf --titles /tmp/titles.txt --skip 20

# 2. Scaffold the book folder
mkdir -p book/content book/assets/figures
$EDITOR book/book.toml          # see references/markdown.md

# 3. Transcribe one chapter per worker into content/NN-slug.md

# 4. Validate, then build
hardbound check book                       # exits non-zero on errors
hardbound build book -o book/out           # refuses a broken book
hardbound serve book/out -p 4000           # http://localhost:4000/

# 5. Verify in a browser, then ship the out/ folder
```

## Layout to create

```
book/
  book.toml               # identity, contents tree, math macros, view variables
  content/01-intro.md     # one chapter per file
  content/02-signals.md
  assets/figures/         # crops, named fig<chapter>-<k>.png, eq<chapter>-<k>.png
  theme.toml              # optional: fonts, palettes, base size
  templates/*.html        # optional: override any page template
```

Paths inside Markdown (`assets/figures/fig2-01.png`) are relative to **`book.toml`**, not to the
chapter file.

## What the builder gives you

- Per-chapter HTML pages and a cover/contents page.
- Sidebar: parts → chapters → sections, scroll-spy, conditions respected.
- Search over a section-level index, with a matching snippet and keyboard navigation.
- Hover previews on internal links, with inert links inside the preview.
- SPA navigation, deep links, and back/forward.
- Folds as native `<details>`, opening ancestors when a link lands inside one.
- View variables (`[vars.*]`) shown as a Book options panel; `if="…"` hides blocks.
- Generated indexes of figures, equations, demos, problems, or any class.
- KaTeX with `[math.macros]`; theme, font, width, leading, size, justification, image tint.
- Footnotes, tables with captions, wide figures.

## What `hardbound check` catches

Errors (stop a build):

- a link `slug!anchor` or `#anchor` whose chapter or anchor does not exist;
- an image path that does not exist on disk;
- a duplicate `{#id}` in one chapter (the first wins at render time);
- an unclosed `:::` (the rest of the file is swallowed) or a stray `:::`;
- an invalid `if=`: unknown variable, select used as a boolean, mixed-type comparison, syntax
  error;
- manifest errors: unknown key, bad slug, missing chapter file, duplicate slug, bad variable.

Warnings (`--strict` promotes them):

- a heading without `{#id}` (no anchor, no sidebar entry, cannot be linked);
- an attribute block that attaches to no block;
- `::: caption` outside a figure;
- a figure whose first block is not an image;
- an `::: index` whose `of=` matches no kind or class;
- a select option no condition uses;
- link text that looks like a generated label but no longer matches its target;
- a footnote reference with no definition (it renders as literal `[^label]` text), or a definition
  that nothing references.

`--lenient` lets a build continue despite errors. Use it only for a machine-extracted draft, and
only until the draft is cleaned.

## Migrating an existing XML or HTML book

- There is **no XML layer and no import command** in the binary. The source is `book.toml` +
  Markdown, so write a one-off converter and keep it with the book.
- Approach: parse each source chapter into a DOM, walk the tree, and emit Markdown blocks.
  Emit inline content recursively so mixed text, emphasis, links, and maths keep their order.
  Keep ids and printed numbers verbatim; derive missing ids from the printed number.
- Structural mapping:

  | Source | Markdown |
  | --- | --- |
  | chapter | `# title {#chN}` + a `[[contents]]` entry |
  | section / subsection | `## … {#id n="…"}` at the right level |
  | display equation | `$$ … $$ {#id n="…"}` |
  | figure + caption | `::: figure {#id n="…"}` + image + `::: caption` |
  | table + caption | GFM table + `: caption {#id n="…"}` |
  | internal reference | `[](slug!anchor)`, or explicit text when prose needs it |
  | problem + solution | heading + `::: fold` for the solution |
  | footnote | GFM `[^label]` / `[^label]: text` |
  | code listing | fenced code with a language tag |

- Copy images into `assets/` and rewrite paths to be relative to `book.toml`. Do not carry the
  source's CSS or templates into the Markdown; express structure, not styling.
- Links to chapters that do not exist yet are errors. Convert in dependency order, or run
  `hardbound check --lenient` while the tree is incomplete, then fix chapter by chapter.
- Verify the migration by comparing counts against the source: sections, equations, figures,
  tables, problems, footnotes, and prose words. Text must match; layout may not.

## Cost control

- One chapter per worker, in parallel; the main agent writes `book.toml`, assembles, checks.
- Never let two agents write the same file. One chapter = one owner.
- Ask workers to run `hardbound check <book>` before reporting; errors point at
  `chapter-file:line`.
- Run `hardbound check` after each batch; fix errors before adding more chapters.
