# Chapter worker brief

Fill the angle brackets and send this as the task for a subagent. Every constraint exists because
dropping it caused a defect.

---

Convert chapter <N> of a scanned book into hardbound Markdown.

**Book:** "<Title>", <edition or publisher/year>.
**PDF:** `<absolute path>`
**Chapter:** <N>, "<chapter title>", PDF pages **<lo>–<hi>** inclusive.
**Output:** `<book dir>/content/<NN>-<slug>.md`, with crops in `<book dir>/assets/figures/`.
**Exemplar:** `<book dir>/content/<other chapter>.md` — match its fidelity and style.

## Read first

1. `~/dev/pi/skills/hardbound/references/markdown.md` — the dialect.
2. The exemplar chapter.

## Method

- Render pages with
  `pdftoppm -f <page> -l <page> -r 200 -png <pdf> /tmp/ch<NN>/pg` and **read the images**.
- The OCR dump (`/tmp/book/text.txt`, pages split by form feed) is a locator only. It is
  unreliable for symbols and useless for mathematics.
- Work in chunks of 3–5 pages: append to the chapter file, then run `hardbound check` on the book.
  Durable progress beats a perfect single pass.

## File shape

```markdown
# <Chapter title> {#ch<N>}

## <Section title> {#s<N>-1 n="<N>.1"}

Prose with inline maths $k = 2\pi/\lambda$ and a reference [](#eq-<N>-12).

$$
\nabla^2 u + k^2 u = 0
$$ {#eq-<N>-12 n="<N>-12"}

::: figure {#fig-<N>-2 n="<N>.2" .wide}

![<accurate description of what the figure shows>](assets/figures/fig<N>-02.png)

::: caption

<caption text, with $\mathrm{math}$ if it has any>

:::

:::
```

## Rules

- Every heading needs `{#id}`. Use `s<N>-<k>` for sections and `s<N>-<k>-<j>` for subsections.
- `n="…"` is the **printed** number. Copy it exactly. For an unnumbered heading write
  `.unnumbered`; for an anchored but unnumbered equation write `.unnumbered`.
- Keep the author's wording. Silently repair OCR damage; do not invent or paraphrase content.
- Inline maths `$…$`. Display maths:

```markdown
$$
<TeX>
$$ {#eq-<N>-<k> n="<N>-<k>"}
```

  Copy the printed equation number into `n=`. Never guess an unreadable formula: crop it and put
  the crop in an unnumbered figure whose caption names the equation.
- Figures: `::: figure {#fig-<N>-<k> n="<N>.<k>"}`; first block is the image; caption inside
  `::: caption`. Crop at 300 dpi, inspect, re-crop if an axis label is clipped. Do not include the
  printed caption in the image; transcribe it as text.
- Tables: GFM table, then a `: caption {#table-<N>-<k> n="<N>.<k>"}` line directly after it.
- Problems: `### Prob. <N>-<k> {#prob-<N>-<k> .unnumbered .problem}`, then statement prose, then
  `::: fold {label="Show solution" label-open="Hide solution"}` for the solution. Reasoning hints,
  no invented numbers.
- Footnotes: GFM `[^label]` and `[^label]: text`. Labels are displayed verbatim.
- Code listings: fenced code with a language tag (` ```python `).
- Cross-references: `[](#eq-<N>-<k>)` in this chapter, `[](other-slug!eq-<M>-<k>)` across chapters.
  Do not write link text; do not write `#` before a chapter slug. If you must mention the number
  in prose, write `see Eq. [](#eq-<N>-<k>)`.
- Do not write HTML, CSS, or custom classes. The only classes are `.wide`, `.unnumbered`,
  `.problem`, `.demo`, and any class the exemplar already uses.
- Do not add a `::: demo` unless the exemplar shows the book's demo pattern.

## Validate

```bash
hardbound check <book dir>
```

It exits non-zero on errors and prints `file:line`. Fix every diagnostic whose path is **your**
file. Errors in other chapters belong to their owners; report them, do not edit them.

While other chapters are still drafts, unresolved cross-references to them are expected. Report
those, do not remove the links.

If `hardbound` is not installed, use:

```bash
cargo run --release --manifest-path $HOME/dev/hardbound/hardbound/Cargo.toml -- check <book dir>
```

## Boundaries

- Do not modify any other chapter, `book.toml`, `theme.toml`, `templates/`, or `out/`.
- Do not run a build; validate only.
- Do not rename or move another worker's figures.

## Report

When finished, report:

- sections, numbered equations (and whether the run is contiguous), figures, problems, footnotes;
- any page the scan defeats (obscured, torn, missing) and what you did instead;
- the exact `hardbound check` diagnostics that remain in your file, if any, with the reason;
- confirmation that every id follows the table above.
