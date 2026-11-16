---
name: tikz-scientific-figures
description: >-
  Create publication-grade scientific figures and schematic diagrams with
  TikZ/PGFPlots, output as vector PDF (and SVG for visual editing). Use when the
  user wants a figure for a paper/thesis/report, a data plot (line, scatter,
  bar, error-bar, heatmap, log axis), a multi-panel figure, a circuit diagram, a
  free-body/force or geometry schematic, a biology figure (immunofluorescence
  or tissue, cell, signaling pathway, gene or plasmid map), a CS/ML figure
  (neural network, system architecture, finite-state machine, tree, graph), or a
  molecular structure — especially when they mention TikZ, PGFPlots, circuitikz,
  LaTeX figures, reproducible/vector publication-quality plots, or editing an
  existing .tex figure. Also use when a polars DataFrame must become a
  journal-shaped panel rather than a quick matplotlib chart. Produces
  reproducible .tex + data sources the user can re-edit.
---

# TikZ scientific figures

One figure = one `standalone` `.tex` that compiles to a tightly-cropped vector
PDF. Deliver the PDF plus the `.tex` and any data file, so the figure stays
editable.

## On this machine (read before the first command)

- **Toolchain is already complete.** TeX Live 2025 (`/usr/local/texlive/2025`),
  `pdflatex`, `latexmk`, `dvisvgm`, `pdftoppm`, `mutool`. Every package the
  recipes use is installed: pgfplots, circuitikz, chemfig, siunitx, tikz-cd,
  pgfgantt, forest, tikz-feynman, mhchem. Do not run `tlmgr` unless a compile
  says a package is missing.
- **Scripts live in the skill, the project is the cwd.** Always call them by
  absolute path, or the relative `scripts/...` form fails:
  ```bash
  SKILL=~/.pi/agent/skills/tikz-scientific-figures
  bash "$SKILL/scripts/compile.sh" figures/figure.tex
  ```
- **Figures belong in `<project>/figures/`, not `/tmp`.** Paths under `$HOME` get
  a `http://localhost:1002/...` URL; `/tmp` does not, so a figure there cannot be
  linked back to the user.
- **Compiles take seconds.** Run them in the foreground. Never wrap them in
  `task_start`.
- **Data comes from polars.** `df.write_csv("figures/data.csv")`, then
  `\addplot table[x=t, y=signal, col sep=comma] {data.csv};`. Name columns in
  the plot instead of using `x index`/`y index`; it survives a column reorder.
  pandas appears only at an anndata boundary.
- **Verify with your own eyes.** `scripts/preview.sh` writes a PNG, and the
  `read` tool shows that PNG to you. Look at every revision before saying a
  figure is correct — overlap, clipped labels and misaligned arrows are all
  visible and none of them raise a LaTeX error.
- **The user cannot see inline images.** `read` the preview PNG so the TUI
  renders a clickable `file://` link, and give the PDF as
  `http://localhost:1002/<path from $HOME>/figure.pdf` next to its raw path.
- **`\si{...}` does not travel to Markdown.** The markdown renderer uses KaTeX,
  which has no siunitx. In an `.md` report write units as plain text
  ("Time (s)"), or embed the PNG/SVG instead of pasting LaTeX.
- **Only `~/.pi/agent/skills` paths exist for you.** The editable source is
  `~/dev/pi/skills/tikz-scientific-figures`; edit there if the skill itself needs
  changing, then `/reload`.

## Step 0 — confirm the toolchain (only after a TeX or brew change)

```bash
bash ~/.pi/agent/skills/tikz-scientific-figures/scripts/selftest.sh
```

`SELFTEST PASS` means compile, preview and SVG export all work. For a full
inventory run `scripts/check_env.sh`; if it reports `[MISS]`, show the user its
printed install hints and stop until the toolchain is fixed.

## Workflow

1. **Pick the figure type and read only that recipe.**
   - data plot (line, scatter, bar, hist, box, heatmap, contour, 3D, log axis) → `references/pgfplots-recipes.md`
   - circuit → `references/circuitikz-recipes.md`
   - flowchart, block or signal diagram, force or geometry schematic → `references/diagram-recipes.md`
   - biology (IF or tissue, cell, pathway, gene or plasmid map) → `references/biology-recipes.md`
   - CS/ML (neural net, architecture, automaton, tree, graph, UML, ER, Gantt) → `references/cs-recipes.md`
   - chemistry (molecule, reaction, energy profile, lattice) → `references/chemistry-recipes.md`
   - physics (ray optics, Feynman, vector field) → `references/physics-recipes.md`
   - math (commutative diagram, Venn, number line) → `references/math-recipes.md`
2. **Composing a paper figure?** Multi-panel (a)(b)(c), insets, significance
   brackets, fit plus CI band, or labelling a real microscopy image →
   `references/figure-composition.md`.
3. **Start from a known-good source, do not type from a blank page.**
   ```bash
   mkdir -p figures && cp "$SKILL"/assets/preamble.tex figures/
   cp "$SKILL"/assets/standalone-template.tex figures/figure.tex   # single panel
   # or the verified two-panel skeleton, which ships its own CSVs:
   cp "$SKILL"/assets/example/* figures/
   ```
   Keep the `TUNABLES` block at the top of the file: it is what lets a
   non-expert hand-edit later without reading TikZ.
4. **Put data in an external CSV** for data plots, so editing the plot means
   editing the CSV.
5. **Compile, then look.**
   ```bash
   bash "$SKILL/scripts/compile.sh" figures/figure.tex      # -> figures/figure.pdf
   bash "$SKILL/scripts/preview.sh" figures/figure.pdf      # -> figures/figure.preview.png
   ```
   Then `read` the PNG. On an error, match `figures/figure.log` against
   `references/common-errors.md`. Repeat until the picture is right.
6. **Deliver** PDF + `.tex` + CSV, the localhost URL, the raw path, the PNG
   preview link, and the figure's edit state (TeX branch or SVG branch).

## Publication-grade rules (defaults, not options)

- Vector output (PDF/SVG). Never ship only a raster.
- Colour-blind-safe palette (Okabe–Ito / viridis), already wired into
  `preamble.tex` as `cbBlue`, `cbOrange`, `cbGreen`, `cbVermillion`, `cbPurple`,
  `cbSky`, `cbYellow`. Never hard-code raw red/green, never use `jet`.
- Size to the target: 89 mm single column, 183 mm double column, body font
  7–9 pt. Set it once in the `TUNABLES` block.
- Every axis labelled with units; error bars state SD, SE or CI; panels numbered
  (a)(b)(c).
- Math and units in LaTeX (`$\alpha$`, `\si{\micro\metre}`) so the figure matches
  the paper's typography. Available siunitx units only — `\arbitraryunit` does
  not exist; write `(a.u.)` as plain text.
- Ship the source: `.tex` + data, not just an image.

If the user names a venue (IEEE, Nature, a thesis template), adjust `\figwidth`,
font sizes and `compat` in `preamble.tex` before drawing.

## Editing an existing figure

Read `references/editing-guide.md`. The rule that must not be broken:

- Default: edit the `.tex` or `.csv` in place and recompile, model-driven or via
  the `TUNABLES` block. Never redraw from scratch when a source file exists.
- `bash "$SKILL/scripts/export_svg.sh" figures/figure.tex` exports an SVG for
  Inkscape or TikZiT and **forks the figure to the SVG branch** (it writes
  `figure.svg.frozen`). From then on the SVG is authoritative and the `.tex` is
  a frozen archive: never recompile the `.tex` over the user's SVG edits, and
  always tell the user which branch the figure is on.
- Free-form polish in the browser, with save-back to the same file:
  ```bash
  bash "$SKILL/scripts/edit_svg.sh" figures/figure.svg
  ```
  Starts a stdlib-only Python server on 127.0.0.1 with an ephemeral port, opens
  Method Draw with the SVG loaded, and Cmd+S writes back. Ctrl+C stops it. It is
  unrelated to the menu-bar server `~/Applications/serv.app` — never restart,
  quit or kill that one.
- A figure is one or the other, never both. If the user wants parametric edits
  after forking, say so and let them choose: keep editing the SVG, or abandon
  the SVG edits and return to the `.tex` branch.

## Skill maintenance

- `scripts/selftest.sh` compiles the bundled example end to end; run it after any
  change to `preamble.tex`, the example, or the scripts.
- `bash scripts/tests/test_edit_svg_sh.sh` and
  `/Users/subwave/dev/tmp/random-tasks/.venv/bin/python -m unittest discover -s scripts/tests -t scripts`
  cover the SVG editor plumbing.
- Recipes are plain Markdown. Add a new figure type as a new file in
  `references/` and one line in the recipe list above.
