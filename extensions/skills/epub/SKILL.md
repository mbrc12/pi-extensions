---
name: epub
description: Creates, repairs, and validates reflowable EPUB books from web articles, PDFs, HTML, Markdown, or mixed sources while preserving full text, headings, lists, links, figures, captions, footnotes, and tables. Use when the user asks to convert documents to EPUB or review a generated EPUB for content and formatting fidelity.
compatibility: Requires common document tools such as curl, pdfinfo, pdftotext, pdftohtml, pandoc or Calibre ebook-convert, unzip, and a Python environment for semantic extraction.
---

# EPUB

Create a readable, reflowable EPUB that preserves the requested source material. Treat EPUB creation as document reconstruction, not plain-text conversion.

## Core requirements

- Include the full requested text unless the user explicitly asks for an abridgment.
- Do not summarize, paraphrase, silently omit, or reorder source content.
- Preserve headings, paragraphs, lists, block quotes, emphasis, links, footnotes, figures, captions, and tables.
- Remove webpage controls, navigation, subscription prompts, comments, and repeated PDF running headers or footers unless the user asks to retain them.
- Use proportional body text. Use monospace only for content that is genuinely code or preformatted data.
- Produce reflowable semantic HTML/XHTML. Do not put an entire PDF extraction in `<pre>` or embed the PDF as the book's content.
- Keep charts and other meaningful figures as images with captions and useful alt text.
- Reconstruct tables as semantic tables when their row and column structure can be recovered.
- Do not represent each PDF page as a screenshot unless the user explicitly asks for a fixed-layout facsimile.

## Temporary Python environment

For one-off work on this computer:

1. Put extraction and build scripts in `/tmp`.
2. Put downloaded and generated scratch files in `/tmp`.
3. Run scripts with `/Users/subwave/dev/tmp/random-tasks/.venv/bin/python`.
4. Install reusable one-off dependencies into that environment with `uv pip install --python /Users/subwave/dev/tmp/random-tasks/.venv/bin/python ...`.
5. Do not put one-off scripts in `/Users/subwave/dev/tmp/random-tasks/`; that directory holds only the permanent environment.
6. Keep only the final user deliverable in the requested permanent output directory.

On macOS, `/tmp` resolves to `/private/tmp`. Keep the generated HTML and its image assets under the same resolved document root. Calibre may reject images when one path resolves through `/tmp` and another through `/private/tmp`.

## Step-by-step workflow

### 1. Define the book

Record:

- every source and its intended order;
- whether each source must be complete or excerpted;
- the title, authors, language, and output path;
- whether comments, appendices, original tables of contents, and footnotes are in scope.

When the user says "full text," default to the article body and document body, including footnotes, figures, captions, tables, and appendices. Exclude website chrome and reader comments.

### 2. Acquire exact source files

Download source HTML and files instead of relying on search snippets or extracted summaries.

```bash
curl -L --fail --silent --show-error --max-time 60 '<article-url>' -o /tmp/article.html
curl -L --fail --silent --show-error --max-time 120 '<pdf-url>' -o /tmp/report.pdf
```

Inspect each file before extraction:

```bash
file /tmp/report.pdf
pdfinfo /tmp/report.pdf
```

Record the PDF page count, whether it is tagged, and whether it contains extractable text. Confirm that the downloaded file matches the source the user named.

### 3. Extract a web article semantically

1. Parse the downloaded HTML with BeautifulSoup or another HTML parser.
2. Identify the actual article container from the DOM, such as `article`, `.post`, `.body.markup`, or `.dt-post-body`.
3. Extract the article title, subtitle, byline, date, body, footnotes, links, and meaningful inline images.
4. Remove controls and decorative elements inside the article, such as share buttons, anchor buttons, SVG icons, visibility checks, and subscription widgets.
5. Preserve semantic tags instead of flattening the article to plain text.
6. Check the first and last substantive paragraphs against the source to catch a selector that starts late or stops early.

Do not convert the entire webpage. That usually includes comments, menus, reactions, and footer promotions.

### 4. Inspect PDF structure before choosing an extractor

Use more than one representation during inspection:

```bash
pdftotext -layout /tmp/report.pdf /tmp/report-layout.txt
pdftotext /tmp/report.pdf /tmp/report-flow.txt
pdftohtml -xml -hidden /tmp/report.pdf /tmp/report.xml
```

Use the outputs for different purposes:

- `pdftotext -layout` helps read the original page organization.
- flow text helps search and compare continuous prose.
- `pdftohtml -xml` exposes page positions, font IDs, links, and embedded image locations needed for semantic reconstruction.

A clean-looking `pdftotext` file is not enough evidence that the EPUB will be correct. Plain extraction often loses heading levels, lists, tables, figures, and paragraph boundaries.

If the PDF has no useful text layer, use OCR before reconstruction. State that OCR may introduce errors and verify names, numbers, and headings carefully.

### 5. Reconstruct PDF prose as semantic HTML

For an untagged PDF, rebuild the document from XML geometry:

1. Read every page, font specification, text fragment, link, and image record.
2. Exclude repeated running headers, publisher marks, and page numbers by position and repetition.
3. Group text fragments that share a baseline into lines, while keeping distinct table columns separate.
4. Infer heading levels from font size, weight, indentation, numbering, and surrounding space.
5. Join wrapped heading lines before emitting one `h2`, `h3`, or `h4`.
6. Infer paragraph breaks from vertical gaps and indentation.
7. Carry a paragraph across a page boundary only when the final line is visibly incomplete.
8. Convert bullet glyphs and their indented continuation lines into `ul` and `li` elements.
9. Preserve numbered prose lists. Use `ol` when the structure is unambiguous; otherwise retain the source numbering in paragraphs.
10. Preserve external links from XML elements where practical.
11. Remove source line wrapping after paragraph structure is established.

Never solve uncertain layout by wrapping a whole page or report in `<pre>`. That preserves line breaks but destroys ordinary reading, reflow, accessibility, and typography.

### 6. Recover figures and captions

Run `pdftohtml -xml` without image suppression when the PDF contains figures. It should produce `<image>` records and extracted image files.

For each figure:

1. Match the image to its page and nearby caption.
2. Copy the image into the same scratch directory as the generated HTML.
3. Emit semantic markup:

```html
<figure>
  <img src="figure-2.png" alt="Description based on the source caption">
  <figcaption>Exact source caption.</figcaption>
</figure>
```

4. Keep the image within the viewport with `max-width: 100%; height: auto`.
5. Verify that every meaningful PDF figure appears in the EPUB archive and manifest.

Do not use a page background image in place of extracted text. Page background images from `pdftohtml` may contain only lines, decorations, or a low-quality full-page rendering.

### 7. Reconstruct tables by coordinates

Plain text is especially unreliable for tables. Use horizontal positions and repeated headers to recover columns.

For a multi-page table:

1. Identify its header labels and the x-coordinate range for each column.
2. Detect each new row from a stable key, such as a date, identifier, or first-column position.
3. Append wrapped lines to the current cell based on x-coordinate.
4. Ignore repeated column headers on later pages.
5. Continue an open row across page boundaries when necessary.
6. Emit `table`, `caption`, `thead`, `tbody`, `tr`, `th`, and `td`.
7. Count source rows and generated rows; the counts must agree.
8. Spot-check the first, middle, and final rows against the PDF.

Do not merge same-baseline fragments before assigning table columns. Text from two columns often shares a baseline and will otherwise become one corrupted line.

### 8. Build one semantic source document

Assemble the sources in the requested order. Use one top-level `h1` for each major work and the original hierarchy beneath it.

Use restrained EPUB CSS:

```css
body {
  font-family: Arial, Helvetica, sans-serif;
  line-height: 1.5;
  color: #111;
}
h1 { page-break-before: always; }
h1:first-of-type { page-break-before: avoid; }
h2, h3, h4 { page-break-after: avoid; }
figure { page-break-inside: avoid; text-align: center; }
figure img { max-width: 100%; height: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #999; padding: .45em; vertical-align: top; }
```

Avoid web-only styling, fixed widths, external fonts, JavaScript, and layout that depends on a large screen.

### 9. Convert to EPUB

Calibre's `ebook-convert` works well for a self-contained semantic HTML file:

```bash
ebook-convert /private/tmp/book.html /path/to/book.epub \
  --title 'Book title' \
  --authors 'Author One; Author Two' \
  --language en \
  --level1-toc '//h:h1' \
  --level2-toc '//h:h2' \
  --level3-toc '//h:h3' \
  --no-default-epub-cover
```

Use Pandoc when the source is already clean Markdown or semantic HTML. Do not assume a successful conversion means the content is correct.

### 10. Validate the archive and package

Run structural checks:

```bash
unzip -t /path/to/book.epub
unzip -l /path/to/book.epub
```

If `epubcheck` is installed, run it too. Verify:

- the EPUB opens as a valid ZIP package;
- metadata is present;
- all expected images, stylesheets, and content files are included;
- internal image and footnote links resolve;
- the generated navigation contains sensible headings;
- there are no `<pre>` blocks around ordinary prose.

### 11. Validate content fidelity

Content review is mandatory. Archive validation alone is insufficient.

1. Round-trip the EPUB to text for inspection:

```bash
ebook-convert /path/to/book.epub /tmp/book-review.txt
```

2. Compare the first and final paragraphs of every source.
3. Compare every major section heading and subsection heading.
4. Check at least one passage from the beginning, middle, and end of each long document.
5. Compare the number of figures, captions, footnotes, and table rows with the source.
6. Search for known distinctive phrases from the PDF and confirm they occur in the EPUB.
7. Inspect boundaries between PDF pages for joined words, duplicated lines, or false paragraph breaks.
8. Inspect headings that wrapped in the PDF to ensure they became one heading.
9. Confirm list items appear before the following paragraph, not after it.
10. Confirm the final table row and final paragraph are present.
11. Compare approximate source and EPUB word counts after excluding running headers, page numbers, and duplicated tables of contents. Investigate material differences.
12. If an EPUB viewer is available, inspect typography, table readability, figure scaling, navigation, and footnotes. Do not claim visual validation when only structural checks were run.

### 12. Deliver and report accurately

Provide the EPUB path or browser-download link. Briefly state:

- which sources are included;
- whether the text is full or abridged;
- whether figures and tables were reconstructed;
- which structural and content checks passed;
- any known OCR, layout, or accessibility limitations.

Do not claim the result was checked against the source unless the content-fidelity steps were actually performed.

## Common failure modes and fixes

### Whole report is monospace

Cause: PDF text was inserted into `<pre>` to preserve page layout.

Fix: reconstruct paragraphs and headings semantically, use proportional body CSS, and reserve `<pre>` for code.

### Text order or content is wrong

Cause: a two-column table or positioned PDF text was flattened without using coordinates.

Fix: use XML geometry, process columns separately, compare section starts and endings, and count rows.

### Headings split into multiple navigation entries

Cause: each wrapped PDF heading line was emitted independently.

Fix: join adjacent fragments with the same heading font and indentation before creating the heading element.

### Lists appear after the following paragraph

Cause: the list buffer was not flushed when normal body text resumed.

Fix: flush a pending list before appending non-indented prose or a new heading.

### Figures are missing from the EPUB

Cause: images were suppressed during extraction, stored outside the HTML document root, or omitted from the package.

Fix: extract images, place them beside the scratch HTML under the same resolved path, then inspect the EPUB file list.

### EPUB validates but reads badly

Cause: ZIP/package checks verify structure, not semantics or typography.

Fix: round-trip to text, inspect representative sections, compare counts, and visually review in an EPUB reader when available.

## Completion checklist

- [ ] Exact source files downloaded and identified.
- [ ] Full requested article text and PDF text included.
- [ ] Website chrome and PDF running furniture removed.
- [ ] Body text uses a proportional font.
- [ ] Heading hierarchy and navigation are coherent.
- [ ] Lists occur in the correct position.
- [ ] Figures and exact captions are present.
- [ ] Tables are semantic and row counts match.
- [ ] First, middle, and final passages match each source.
- [ ] EPUB archive validation passes.
- [ ] Content round-trip review passes.
- [ ] Any unperformed visual or OCR check is disclosed.
