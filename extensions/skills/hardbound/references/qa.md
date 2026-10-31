# QA checklist

Run this before calling a book finished. Each line has caught a real defect.

## Per chapter

- [ ] `hardbound check book` reports no errors in this chapter.
- [ ] Equation numbers in `n="…"` match the printed page; coverage check shows no long runs of
      missing numbers (`references/pipeline.md` §5).
- [ ] Section count matches the printed headings, including unnumbered subheads.
- [ ] Every figure in the range exists and its crop shows all axis labels.
- [ ] Problems section present if the book prints one; each solution is a `::: fold`.
- [ ] No heading lacks `{#id}` (warnings from `check`).
- [ ] No duplicate anchors in the chapter.
- [ ] No unresolved footnote references (they render as literal `[^n]` text).
- [ ] Spot-read two paragraphs against the page image: wording faithful, no OCR artefacts.
- [ ] Display maths has no `%` comments and no unreadable guesses.

## Book level

- [ ] `hardbound check book` exits 0 with zero errors; consider `--strict` for zero warnings.
- [ ] Every chapter in `book.toml` exists; every `title` is set; part entries have no `slug`.
- [ ] Cross-chapter links resolve (included in `hardbound check`).
- [ ] Every `[vars.*]` is used by at least one `if=`; every select option is used.
- [ ] Total equation and figure counts roughly match the printed book.
- [ ] No orphan crops in `assets/figures/`:

```bash
grep -rhoE 'assets/[^)" ]+' book/content | sed 's/[.,;:]$//' | sort -u > /tmp/used.txt
(cd book && find assets -type f | sort) > /tmp/all.txt
comm -13 /tmp/used.txt /tmp/all.txt
```

- [ ] Images are a sensible size. The bundle should not be hundreds of megabytes.

## Build and serve

- [ ] `hardbound build book -o book/out` exits 0 and prints the summary.
- [ ] `book/out/` contains `index.html`, one page per chapter, `data/*.json`, `assets/`.
- [ ] No stale pages: delete `out/` and rebuild after removing or renaming a chapter.
- [ ] `hardbound serve book/out -p 4000`; open `http://localhost:4000/`.
- [ ] Cover lists every chapter in order; "start reading" opens the first chapter.

## In the browser (headless is fine)

Paste into the console on a maths-heavy chapter:

```js
({
  katex: document.querySelectorAll(".katex").length,
  errors: document.querySelectorAll(".katex-error").length,
  dollars: (document.body.innerText.match(/\$/g) || []).length,
  images: document.images.length,
  broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
  empty: [...document.querySelectorAll("a")].filter(a => !a.textContent.trim()).length,
})
```

- [ ] `errors === 0`, `dollars === 0`, `katex > 0` on a page with maths.
- [ ] `broken === 0`; scroll to lazy images before trusting the count.
- [ ] `empty === 0`; an empty link is almost always an unresolved reference.
- [ ] Sidebar scrolls independently; the current chapter expands; parts are labelled.
- [ ] A cross-chapter link lands on the right page and anchor.
- [ ] A link into a fold opens the fold.
- [ ] Search finds a section, shows a snippet, and Enter opens it.
- [ ] Hover previews show figure, equation, section, and table targets; links inside a preview do
      not navigate.
- [ ] Theme and font switches work; text size changes the article, not the sidebar.
- [ ] Dark mode: no white panels, no invisible icons, readable fold labels.
- [ ] Print preview hides the chrome and expands folds.
- [ ] Keyboard: Tab reaches search and controls; focus is visible; `Esc` closes previews and
      search.

## Variables and optional content

- [ ] Turning a variable off hides its blocks, its sidebar/TOC entries, and its generated index
      entries.
- [ ] Numbers do not change when a block is hidden.
- [ ] The URL reflects the variables (`?demos=0&level=full`) and a copied URL opens that view.
- [ ] Hiding a variable does not hide unrelated content (a condition on a heading does not hide
      its body; wrap a whole section in `::: region` if that is intended).

## Mobile (375–430 px wide)

- [ ] `document.documentElement.scrollWidth === innerWidth` (no sideways scroll).
- [ ] Display equations keep their number on the same line; wide formulas scroll or shrink inside
      their box.
- [ ] The sidebar does not hide the article; it is capped and scrollable.
- [ ] Tap targets ≥ 2.3 rem; nothing overlaps the toolbar.
- [ ] Images and tables stay inside the viewport.

## Sign-off message

State plainly:

- chapters covered and page ranges, equation/figure/table totals;
- what was machine-extracted (EPUB text, OCR text layer) versus transcribed from page images;
- warnings still present, and why they are acceptable;
- pages the scan itself defeats (obscured, torn, missing);
- how to rebuild: `hardbound check book`, `hardbound build book -o book/out`, `hardbound serve
  book/out -p 4000`;
- that the deliverable is the `out/` folder, with no single-file variant.
