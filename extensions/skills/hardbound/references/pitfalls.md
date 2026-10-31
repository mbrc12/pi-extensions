# Failure catalogue

Every entry is something that actually happens, with the fix. Read this before debugging.

## References

**A broken reference is an invisible empty link.** A missing same-file anchor renders
`<a href="#nope"></a>`; a missing cross-chapter anchor renders an empty `<a>` to the other page.
Nothing warns in the browser. `hardbound check` reports both with `file:line`; run it.

**A cross-chapter link was written with a `#`.** `[](#signals!eq-2-1)` is a same-file anchor whose
name happens to contain `!`, not a cross-chapter link. The form is `[](signals!eq-2-1)`.

**A link to a chapter does nothing.** The target is an **anchor**, not a file. Put `{#ch2}` on the
chapter `h1` and link to `[](ch2)` or `[](signals!ch2)`.

**Hand-written labels drift.** `[](#eq-2-13)` is self-updating; `[Eq. (2-13)](#eq-2-13)` is not.
When figures or equations are renumbered, `check` warns if the text still looks like a label.
Either update it or use empty link text.

**A generated label repeats the preceding word.** `see Eq. [](#eq-2-1)` renders "see Eq. Eq.
(2-1)" unless the reader absorbs the prefix. It does absorb `Eq.`, `Fig.`, `Table`, `Section`,
`Prob.`, `Demo`, and `Chapter`, but only when the link text is empty.

**A reference renders as literal `signals!eq-2-1`.** The slug is not in `book.toml` (wrong slug or
missing chapter entry). The build leaves unknown slugs as written and `check` reports it.

## Markdown structure

**A missing `:::` swallows the rest of the chapter.** One forgot close turns the remainder into
figure body text or a single fold. `check` reports `container ::: figure is never closed` at the
opening line. This is the most common structural mistake.

**A fence line with trailing prose is not a fence.** `::: note this is a note` becomes a paragraph
that displays the colons. Attributes must be in `{...}`: `::: note {#n1}`. Keep the fence line
alone.

**Attributes after a paragraph attach to nothing.** `{#id}` on its own line applies to the block
above it only if that block can carry attributes: heading, equation, table, code, container.
After a paragraph it is dropped; `check` warns. Put the id on the heading line instead.

**A condition on a paragraph is ignored.** Same rule: `if=` attaches to the block above it and only
those block types accept it. Wrap several blocks in `::: region {if="…"}`.

**A heading inside a container or fold has no number.** Automatic numbering only walks top-level
headings. If the book prints `2.3.1`, write `n="2.3.1"` on that heading.

**A heading without `{#id}` is unreachable.** No anchor, no sidebar entry, no search entry, no
link target. `check` warns. Add an id.

**A `::: caption` outside a figure is a plain div.** The caption only becomes a `<figcaption>`
inside `::: figure`. `check` warns.

**A figure without an image first renders `<img src="">`.** The image must be the first block, and
an inline image inside a later paragraph does not count. `check` warns.

## Maths

**A `%` comment deletes the rest of the equation.** Display-math lines are joined into one line, so
a LaTeX comment that used to end at a newline now ends at the closing `$$`. Delete `%` comments.

**A display equation broke into paragraphs.** comrak splits on lines that look like list items
(`  + …`) or quotes. The pre-pass already joins `$$ … $$` blocks; if maths still breaks, check for
a stray `$$` earlier in the file that opened a block at the wrong place.

**`\\` is required inside `aligned` and `cases`.** Line breaks are not implied by the source line
breaks once the block is joined.

**An equation is unnumbered although it has an id.** Only an anchored display equation is
numbered, and an explicit `n` wins. `$$ … $$ {#eq}` uses `{…}` on the same line as the closing
fence. A separate `{#eq}` line works only directly after the math block.

**Raw `$` is visible.** KaTeX did not run: the page was opened without its scripts (saved HTML
fragment), the CDN is blocked, or `--offline` was used without `vendor/katex`. Serve the bundle
and check the console.

**A wide equation is clipped.** The reader should shrink the math font to fit. If it is still
clipped, the equation is inside a table cell or a container with its own width; simplify or break
the equation.

## Images

**Missing images are silent in the reader.** The `<img>` simply does not paint. `check` verifies
every path relative to `book.toml`; fix the path or the asset.

**Figure crops include the printed caption**, so the caption appears twice. Crop above the
caption line, then transcribe the caption as text.

**Crops clip axis labels.** Inspect every crop; nudge the box a few points and re-render. Two or
three iterations is normal for dense figures.

**A crop swallowed neighbouring text.** Start the box at the bottom of the last *text* line above
the caption, not at the last block's bottom, and look at the result.

**The bundle is enormous.** The builder copies assets byte for byte. A 300 dpi PNG book can pass
100 MB. Downsample to about 1100 px wide before adding, or accept a slow first load.

**The page jumps while images load.** Images have no width/height attributes in the bundle. Keep
crops at consistent widths and avoid very tall scans in the flowing text.

## Manifest and numbering

**The sidebar chapter title is blank.** `title` on the `[[contents]]` entry is what the sidebar and
cover show; it does not fall back to the `h1`. Always set it.

**A rebuilt `out/` still contains a deleted chapter.** The build writes current files and never
deletes. Remove `out/` before a clean build, especially after removing or renaming a chapter.

**Printed numbers drift from the auto numbers.** Chapters are numbered by position in `contents`,
sections by position, equations by count. That is right for a clean book and wrong for a reprint
with front matter or skipped numbers. Copy the printed numbers into `n="…"`.

**Two blocks share an anchor.** The first wins; the second loses its id and every link to it
lands on the first. `check` reports the second line and the first line. Ids only need to be unique
within a chapter; the same id in two chapters is fine.

**An id is empty after a migration.** A heading `{n=""}`-style attribute with no `#` gives a
number but no anchor. Check the attribute: `{#id n="…"}`.

## Footnotes

**Footnote numbers do not match the page.** The displayed number is the GFM label verbatim
(`[^6]` shows 6; `[^Note]` shows `note`), and notes are listed in definition order, not
first-reference order. Renumber the labels in the source if the book's numbering matters.
Labels are lowercase and single-word: `[^two words]` is not a footnote and renders as text.

**A footnote reference shows the raw `[^label]` text.** The definition is missing, or the label
has a typo. comrak renders an unresolved reference as literal text; `check` warns with the line.

**Footnotes in a folded solution render at the end of the chapter**, not inside the fold. That is
how the Notes section works; avoid footnotes inside short folds.

## Reader and serving

**Navigation, previews, and search do nothing.** The bundle was opened from `file://`, where
`fetch()` is blocked by CORS. Run `hardbound serve out -p 4000` and use the URL.

**A generic static server breaks the styles.** Some viewers serve `.css`, `.js`, and `.json` as
`text/html`. `hardbound serve` sets correct MIME types and disables caching in development.

**The page is unstyled after a rebuild.** The stylesheet URL carries a content hash and the server
sends `Cache-Control: no-store`; a hard reload fixes a stale tab from an older server.

**Hover previews show the wrong content.** The link points at an anchor that exists in the target
chapter, but the preview extracts the element with that id. Duplicate anchors in one chapter make
the first one win.

**Search returns nothing for a chapter.** The search index is built from `h2`+ sections and their
paragraphs. A chapter with only an `h1` and no section headings contributes one entry and little
text. Add sections.

**A hidden block is still reachable by link.** By design: navigating to a hidden target reveals
that one block and marks it "hidden by current view" rather than failing.

**A variable has no effect.** Defining `[vars.demos]` only adds the control. Gate the blocks with
`if="demos"`; `check` warns about select options that no condition uses, but cannot know that a
bool is unused.

## Mobile

**The page scrolls sideways on a phone.** Check `document.documentElement.scrollWidth ===
innerWidth`. A wide equation or a table is the usual cause. Prefer tables that fit at 390 px, and
avoid inline fixed-width images.

**The sidebar eats the first screen.** Below 860 px it becomes a block above the article with a
45vh cap. That is a known layout trade-off, not a bug; test the reading flow at 390 px.

**Tap targets are small.** Controls are about 2.3 rem, but table links and footnote back-links are
text-sized. Acceptable for reading; do not shrink further.

## Tooling and environment

**`pdftoppm -singlefile` with several pages** silently writes only the first page. Pass `-f`/`-l`
and render one page at a time.

**`pdftotext -bbox-layout` output is not valid XML.** Strip the head and parse with regexes.

**`hardbound check` reports a line that is a few lines off.** The parser reports the source line
of the block, not the exact character. Look at the block, not the exact column.

**`--offline` fails with a missing `vendor/katex`.** Fetch KaTeX once into the tool repository as
the error message describes, or build without `--offline`.
