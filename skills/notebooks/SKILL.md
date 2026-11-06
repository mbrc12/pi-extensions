---
name: notebooks
description: Create, edit, validate, or convert notebook-style work as either a standard Jupyter .ipynb notebook or an Iron.nvim Python file. Use whenever the user asks for a notebook, notebook cells, or a notebook-to-HTML conversion.
license: MIT
---

# Notebooks

The user can choose either a standard Jupyter notebook or an Iron.nvim-style Python file. If the user does not specify a format, ask which one they want before creating the artifact. Do not create both unless they ask.

## Choose a format

- **Jupyter**: Produce a standard `.ipynb` file in nbformat 4 JSON, normally under `notebooks/`. The user opens and runs it in JupyterLab.
- **Iron.nvim**: Produce a plain `.py` file, normally under `notebooks/`. The user's Neovim config uses Iron.nvim with Python and `block_dividers = { "# %%" }`. Put `# %%` on its own line between logical code blocks so Iron can send each block to the REPL. These dividers are valid Python comments and do not collide with Markdown headings inside `_exposition()` strings. This format has no Markdown cells; use concise Python comments for headings and explanation.

## Never install or launch Jupyter tooling

- Do not install `jupyterlab`, `notebook`, `ipykernel`, `nbformat`, `nbclient`, or `nbconvert`.
- Do not launch a notebook server. The user handles kernels and execution in JupyterLab.
- If a notebook will not run because of a missing dependency, report it instead of installing Jupyter tooling.
- These restrictions apply to both formats. Iron.nvim uses the user's configured Python REPL; do not launch it on the user's behalf.

## Write Jupyter notebooks

- Write the JSON directly. Use one code cell per logical step.
- Add a short Markdown cell before any derivation or claim.
- Do not store outputs: use `"outputs": []` and `"execution_count": null`.
- Keep cells runnable top-to-bottom in order, repeating imports only where a cell needs them.
- End a cell with a bare expression when you want JupyterLab to display that value.

## Write Iron.nvim notebooks

- Write valid, ordinary Python. Use `# %%` divider lines between logical code blocks; do not use Jupyter-only syntax such as `%%` magics or Markdown cells.
- Aim for 80 columns per line. Allow occasional lines up to 88 columns when wrapping would reduce readability; do not exceed 88.
- Keep blocks runnable top-to-bottom in the configured Python REPL. Repeat imports only where a block needs them.
- Use comments for titles and brief explanations. End expressions with an explicit `print(...)` when the user needs to see output in the REPL.
- The user's Iron REPL is terminal IPython, which loads `~/.ipython/profile_default/startup/99-ipython-html.py`. Do not recreate its display helpers in notebook code.
  - Use `_exposition("""...Markdown with $inline$ or $$display math$$...""")` to add a Markdown and KaTeX-rendered item to the HTML gallery. Separate paragraphs with blank lines; Markdown soft line wraps do not create paragraph breaks. Math is rendered by `marked-katex-extension`, and `_exposition` normalises display math onto its own lines, so `\;`, `\,` and multi-line formulas survive. Escape a literal dollar sign as `\$`. This uses browser-side JavaScript, so it adds no Markdown package requirement to Python environments; the browser needs access to the CDN libraries.
  - Rich objects can be saved as standalone HTML with `save_html(obj)`. The startup exposes this helper without monkeypatching built-in types. Run `ipyserv` to serve the recent-results gallery at `http://127.0.0.1:8765/`; it refreshes once per second. Its executable is `~/.local/bin/ipyserv` and uses micromamba `env-1` to run `~/.local/share/ipython-html/serv.py`.
  - Use this for figures and rich objects that the terminal REPL cannot display inline. `_repr_html_` is used when available; Plotly outputs fill the viewer, py3Dmol views save as full-page HTML, and Polars tables show all columns and up to 20 rows.
  - Run `ipyserv --clean` to remove all saved HTML gallery items; it exits without starting the viewer.
  - Each executed IPython cell also prints its elapsed time to stderr.

## Convert a notebook to HTML

Use `pandoc` as the default. It reads `.ipynb` natively, is already installed on this machine, and needs no Python packages.

```bash
pandoc -f ipynb -s --embed-resources --mathjax nb.ipynb -o nb.html
```

- `-s` emits a standalone document. Without it, pandoc returns a fragment.
- `--embed-resources` inlines images as data URIs, so the HTML is one portable file.
- `--mathjax` renders maths properly. The default HTML math output loses spacing, turning `mc` into adjacent `<em>` spans.
- Style with `--css style.css` or `--template`. The default is plain pandoc prose, max-width 36em.
- Pandoc passes `text/html` cell outputs through unescaped, so tables and rich objects survive.

Measured on a 4-cell notebook with markdown, stream output, an HTML table, and a PNG: pandoc 0.07 s and 7 KB, `nbconvert --to html` 0.35 s warm and 280 KB.

Alternatives, in order of how much machinery they add:

- `jupyter nbconvert --to html` — richest output (notebook chrome, anchors, widgets, bundled MathJax), roughly 40x the file size. Use only when it is already installed and the user wants the JupyterLab look. Never install it for this.
- `quarto render nb.ipynb --to html` — themes, cross-references, self-contained output. Requires the Quarto binary, about 200 MB.
- `marimo export html nb.py` — an interactive reactive page. Needs conversion to marimo's `.py` format first.
- `voila` — a live dashboard, not static HTML.

Neither pandoc nor nbconvert executes cells; both render stored outputs only. If the notebook has `"outputs": []`, the HTML will show code without results. Report that to the user rather than installing tooling to run the notebook.

## Validate

- For `.ipynb`, extract code cells in order and run them in one namespace with `uv run python`, so ordering and import bugs surface early. Do not install Jupyter packages for validation.
- For Iron `.py`, check Python syntax and, when appropriate, run the file with the project's Python environment. Do not assume `# %%` blocks are independent modules; validate their top-to-bottom behavior.
- Do not execute code that can modify data or have other side effects without the user's approval.

## Output

- Save figures to the project's `figures/` directory rather than relying on stored notebook outputs.
- Prefer polars DataFrames over pandas in notebook code.
