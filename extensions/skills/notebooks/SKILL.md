---
name: notebooks
description: Write or repair Jupyter .ipynb notebooks for the user, who opens and runs them in VS Code. Use whenever creating, editing, or validating a notebook file.
license: MIT
---

# Notebooks (`.ipynb`, opened in VS Code)

The user opens and runs notebooks in **VS Code**. Produce standard `.ipynb` files (nbformat 4 JSON)
in `notebooks/`.

## Never install Jupyter packages

- No `jupyterlab`, `notebook`, `ipykernel`, `nbformat`, `nbclient`, or `nbconvert`.
- Do not launch a notebook server. The user handles kernels and execution in VS Code.
- Bad kernels are not yours to fix by installing things. If a notebook will not run for the user,
  report the missing dependency instead of adding Jupyter tooling.

## Write the JSON directly

- One code cell per logical step.
- A short Markdown cell before any derivation or claim.
- No stored outputs: `"outputs": []` and `"execution_count": null`.
- Keep cells runnable top-to-bottom in order, repeating imports only where a cell needs them.
- End a cell with a bare expression when you want VS Code to display that value.

## Validate without Jupyter

Extract the code cells in order and run them in one namespace with `uv run python`, so ordering and
import bugs surface early.

## Output

- Save figures to the project's `figures/` directory rather than relying on stored outputs.
- Prefer polars DataFrames over pandas in notebook code.
