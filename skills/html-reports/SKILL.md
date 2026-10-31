---
name: html-reports
description: Build or edit a standalone HTML report or data page — sortable tables, sticky headers, WCAG 2.2 AA accessibility, and restrained document-style CSS. Use whenever writing a .html report, dashboard, data page, or table-heavy document.
license: MIT
---

# HTML reports

Read this before writing a new `.html` report or editing an existing one.

## Tables must sort

Make every data table sortable with Tablesort 5.3.0 from cdnjs. Put these scripts in the header:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/tablesort/5.3.0/tablesort.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/tablesort/5.3.0/sorts/tablesort.number.min.js"></script>
```

- Give each data table a `<thead>` and `<tbody>`, and `class="sortable"` on the table.
- At the end of the document, run `new Tablesort(table)` for every `.sortable` table.
- Use `data-sort-method="number"` on numeric headers.
- Render missing numeric values as `NA`, and add a small local comparator so `NA` stays last.
- Keep the visible sort direction that Tablesort adds to the header.

## Table layout

- Keep every table inside its container: `width: 100%`, `max-width: 100%`.
- Budget column widths by content. Give short, important values only the space they need and more space to columns with long labels or text. Use explicit widths or `table-layout: fixed` when needed. Do not equalise all columns unless the content warrants it.
- Let long cells wrap with `overflow-wrap: anywhere` and `word-break: break-word`. Do not use `white-space: nowrap` for long keys or text cells.

## Sticky headers

Headers must stay visible while the page scrolls past a table.

- Show the whole table at its natural height: no bounded-height container, no vertical scrollbar.
- Make the `th` elements sticky, not only `thead`.
- Do not put an ancestor with `overflow: auto`, `overflow: scroll`, or `overflow: hidden` between the table and the page; it breaks stickiness.
- Keep the header background and bottom border visible so rows cannot show through.

```css
.sortable thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fff;
  border-bottom: 1px solid #767676;
}
```

## Semantics and accessibility (WCAG 2.2 AA)

- Use native landmarks, a single `h1`, and ordered headings.
- Use real `button` and `a` controls, and no redundant ARIA.
- Support keyboard operation with visible focus; keep logical source order and descriptive links.
- Give images meaningful `alt` text (`alt=""` when decorative).
- Meet AA contrast (4.5:1 for normal text); never use colour as the only signal.
- Give tables a `caption` and scoped header cells. Keep sorting accessible.
- Give charts a text summary and an equivalent data table or download.
- Avoid horizontal page overflow on narrow screens.
- Use GOV.UK and USWDS as visual references, not as framework dependencies.

## Styling

Write restrained, document-like pages, not dashboards or marketing pages.

- Load **Hanken Grotesk** from Google Fonts and set `font-family` on `body`:

  ```html
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">
  ```

- Use 14px body text, 1.45–1.6 line-height, near-black text, white or very light neutral background.
- Use one centered column: `max-width: 1200px; margin: 0 auto; padding: 24px`, and 16px on narrow screens.
- Use a simple heading hierarchy and a neutral palette with at most one muted accent.
- Use spacing to group content. Use plain, lightly bordered panels only when they clarify structure.
- Keep images, charts, and tables within the viewport. Charts need a title and axes or legend.
- Avoid gradients, glass effects, hero sections, decorative cards, animation, and strong shadows unless asked for.
- Put local CSS in one small `<style>` block. Do not import a design framework.
- No clipping and no horizontal overflow. Check the layout at about 375px and 1280px.

## Links

Link finished reports with the `localhost:1002` URL pattern described in the `local-server` skill.
