# QA checklist

Run this before calling a book finished. Nothing here is optional; each line has caught a real
defect.

## Per chapter

- [ ] `bookify.py check chNN.xml` prints `valid`.
- [ ] `check.py` reports no long missing equation runs.
- [ ] Section count matches the printed headings (including unnumbered subheads).
- [ ] Every figure in the range exists and its crop shows all axis labels.
- [ ] Problems section present if the book prints one.
- [ ] No duplicate ids (`normalize.py ids` has run).
- [ ] Spot-read two paragraphs against the page image: wording faithful, no OCR artefacts.

## Book level

- [ ] `bookify.py build book.xml --stats` → unresolved soft refs only for genuinely external
      targets.
- [ ] `normalize.py ids` has run after the last chapter landed.
- [ ] `verify_html.py` prints `ok` for every page.
- [ ] Cross-chapter links land on the right file and anchor.
- [ ] Total equation count roughly matches the sum of `check.py` expectations.

## In the browser (headless is fine)

- [ ] `.katex` count > 0 on a maths page; `.katex-error` count is 0.
- [ ] No `$` in the visible text of the current viewport.
- [ ] Scrolling to a new chapter renders its maths without a long blank moment.
- [ ] Sidebar scrolls independently of the article; current chapter auto-expands.
- [ ] Collapse hides the sidebar; the reopen control appears and works; state survives reload.
- [ ] Text-size buttons change article text only — sidebar stays put.
- [ ] Dark mode: no white control on a dark panel, no invisible icon.
- [ ] Search returns hits with chapter and snippet; clicking a hit jumps to the section.
- [ ] Optional content (demos) hidden by default, revealed by the switch, and its index hidden
      alongside it.
- [ ] Images all load (`[...document.images].filter(i => i.naturalWidth === 0).length === 0`).
- [ ] Keyboard: Tab reaches search, controls, and sidebar links; focus is visible.

## Files

- [ ] Only the intended HTML exists (a `--single` build leaves no chapter pages).
- [ ] No stray `_preview.xml`, `book_all.xml`, or temporary crop directories in the book folder.
- [ ] `figures/` contains no orphans: every file is referenced by some XML.

Orphan check:

```bash
python3 - <<'PY'
import re, pathlib
book = pathlib.Path("book")
used = set()
for xml in book.glob("*.xml"):
    used |= set(re.findall(r'src="(figures/[^"]+)"', xml.read_text()))
all_figs = {f"figures/{p.name}" for p in (book / "figures").glob("*")}
print("orphans:", sorted(all_figs - used)[:20])
PY
```

## Sign-off message

State plainly:

- page range covered, chapter count, equation and figure totals;
- what was machine-extracted versus transcribed;
- any pages the scan itself defeats (obscured by a note, torn, missing);
- how to rebuild (`bookify.py build book.xml --single`);
- the two entry points (single file, and index + chapter pages).
