---
name: latex-writing
description: Write LaTeX math inside Markdown, HTML, or other external documents — correct \mathrm, \mathbf, \star usage and renderer-safe escaping. Use whenever a document you write contains mathematical notation.
license: MIT
---

# LaTeX in written documents

Terminal and chat replies cannot render LaTeX, so the one-line rule stays in `AGENTS.md`. This
skill covers documents written to disk.

## Use math in documents

- In Markdown, HTML, and other external documents, always use LaTeX for math.
- Never use `\bm{..}`. Obsidian MathJax and KaTeX do not ship the `bm` package, so it renders
  literally or errors out. Use `\mathbf{..}` or `\boldsymbol{..}`:
  `\mathbf{x}_{n}`, `\mathbf{A}`, `\mathbf{\theta}`.

## Upright text in sub/superscripts

Words and multi-letter abbreviations such as `CE`, `ACC`, `old`, `new`, `IL` go in `\mathrm{..}` so
they render upright: `\ell_{\mathrm{CE}}`, `\hat{p}_{\mathrm{old}}^{(T)}`. Single-letter math
variables (`i`, `t`, `k`, `n`) stay plain.

## Escape raw angle brackets

Never write a raw `<` inside inline math. Markdown parsers may read `<word` as an HTML tag. Use
`\lt` instead.

## Prefer `\star`

Use `\star` for star or asterisk superscripts: renderers draw it as a proper star glyph
(`$\theta^\star$`, `$a^\star b^\star$`) while `\*` renders as a plain asterisk.

- Never use `\*` inside `$...$` or `$$...$$`.
- `\*` is allowed only in code blocks, for example regex literals, where it is not math.
