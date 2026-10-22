---
name: bookify
description: Convert a scanned or PDF book into a structured XML source and a screen-reading HTML book (single file or per-chapter pages), with figures cropped from the scan, LaTeX equations, cross-references, a sidebar, in-page search, and optional numerical demos. Use when the user asks to turn a PDF book into HTML/EPUB-style content, asks for a chapter-by-chapter transcription pipeline, or wants a long technical document assembled with navigation and maths.
---

# bookify

Turn a book into two artifacts: **XML that carries only meaning** and **HTML rendered from it**.
The XML is the source of truth; the HTML is disposable.

This skill exists because scanning→HTML looks easy and is not. OCR mangles mathematics,
independent chapter workers collide on ids, single-file books choke the browser, and maths
silently fails to render because of script ordering. Every rule below comes from a failure.

## When to use

- "Convert this PDF/book into a readable HTML (or EPUB) with chapters, figures, equations."
- "Transcribe chapter 3 of this scan", "make a book from these chapters".
- A long technical document that needs a TOC, cross-references, search, and maths.

Not for: a few pages of notes (write Markdown), or a book that already has clean HTML/EPUB.

## Non-negotiables

1. **Transcribe from page images, never from the OCR text layer.** OCR is a locating aid only.
   A worker that copies OCR produces text like `hePhenomenon`, `n;`, `vj} = c/n`.
2. **XML holds content and meaning only.** No CSS classes, no pixel sizes, no "Chapter 5" typed
   into prose where a label can be referenced.
3. **References are by label.** `<ref to="eq-4-12"/>` renders `(4-12)` by itself, and becomes
   `(4-12)` on the page or `ch04.html#eq-4-12` across pages. Never hand-write link text.
4. **The build is the gate.** Unknown elements, missing attributes, missing `alt`, duplicate ids
   and unresolved hard refs are errors. Soft refs (`soft="yes"`) degrade to text instead.
5. **Verify with the browser, not by hope.** "It should render" is how maths ends up raw.

## Pipeline

```
PDF ──pdf_probe dump──▶ text.txt + bbox.html
     ──pdf_probe ranges─▶ chapter page ranges (verify by eye)
     ──workers (1/chapter)──▶ chapters/chNN.xml + figures/*.png
     ──normalize ids──────▶ unique anchors across chapters
     ──bookify build──────▶ book.html  |  index.html + chNN.html
     ──verify_html────────▶ links, images, ids, math
     ──browser check──────▶ KaTeX error count, no raw "$"
```

Details and commands: `references/pipeline.md`.
XML schema: `references/schema.md`.
Failure catalogue: `references/pitfalls.md`.
Delegating chapters to subagents: `references/delegation.md` and `agents/chapter-worker.md`.
Final checklist: `references/qa.md`.

## Quick start

```bash
S=~/.pi/agent/extensions/skills/bookify/scripts
python3 $S/pdf_probe.py dump book.pdf --work /tmp/book
printf 'Chapter One\nChapter Two\n' > /tmp/titles.txt
python3 $S/pdf_probe.py ranges book.pdf --titles /tmp/titles.txt --skip 20

mkdir -p book/figures
cp assets/book.xml book/book.xml          # edit title/author/includes
cp assets/chapter.xml book/ch01.xml       # edit; one per chapter
python3 $S/bookify.py check book/ch01.xml
python3 $S/bookify.py build book/book.xml           # pages
python3 $S/bookify.py build book/book.xml --single  # one file, images inlined
python3 $S/verify_html.py book/*.html
```

## Layout to create

```
book/
  book.xml            # <book> with <include src="chNN.xml"/>
  ch01.xml … chNN.xml # one <chapter> per file
  figures/            # crops named fig<chapter>-<number>.png, eq<chapter>-<NN>.png
  book.html           # or index.html + chNN.html
```

Keep `template.html` and `style.css` **next to book.xml** to override the skill defaults;
otherwise the copies in `assets/` are used.

## What the renderer gives you

- Sidebar: chapter/section tree with scroll-spy, auto-expanding current chapter, collapsible
  (state persisted).
- Reader controls: theme, text size (article only), progress bar, scroll position restored.
- Search: walks headings already in the DOM; no index build, no server.
- Lazy maths: single-file mode renders one chapter at a time on approach and the rest in idle
  time; per-chapter pages render their own chapter only.
- Demos: hidden by default, revealed from the contents switch, and their index hides with them.
- Images: inlined as WebP (max width ~1100 px) in `--single` mode, so the file needs no assets.

## The two output shapes

| | `--single` | default |
| --- | --- | --- |
| files | `book.html` | `index.html` + `chNN.html` |
| images | inlined WebP | paths into `figures/` |
| best for | sharing, offline, printing | reading long books, fast first paint |

Both use the same shell. Do not mix them: a `--single` build writes no chapter pages, and a
chapter page has no `.chapter-slot` (the renderer handles that case — see pitfalls).

## House style for the output

- Body serif (ET Book via CDN, or any serif stack in `style.css`), ~70 characters per line,
  maths set to `1em` so it matches body text instead of towering over it.
- Headings in regular weight; italics for run-in subheads.
- Icons as inline SVG, sized to the button (≥ 20 px), with `aria-label` on every control.
- Colour through CSS variables (`--ink`, `--muted`, `--rule`, `--ctrl-bg`, `--mark`) so dark
  mode is a variable swap, not a second stylesheet.

## Cost control

- One chapter per worker, in parallel; the main agent only assembles and verifies.
- Never let two agents write the same file. One chapter = one owner.
- Ask workers to validate with `bookify.py check chNN.xml` (writes nothing) and to report
  counts; use `check.py` yourself to spot skipped page ranges.
