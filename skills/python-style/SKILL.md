---
name: python-style
description: Write Python with deal design-by-contract, polars-only data analysis, and the user's scratch-venv conventions. Use whenever writing or modifying Python code, adding contracts, or handling pandas at an anndata boundary.
license: MIT
---

# Python style

The short versions of these rules stay in `AGENTS.md`. Read this for the detail.

## deal design-by-contract

Add `deal` contracts (`@deal.pre`, `@deal.ensure`, `@deal.inv`) wherever they add value —
especially at data-flow boundaries where correctness matters: no-leakage guarantees, input/label
separation, validation of pure functions.

- Prefer `@deal.ensure` over `@deal.post` when a contract must inspect both the result and the original arguments (`@deal.post` sees only the result).
- Class invariants fire on every attribute set. Guard them with an `_initialized` flag so `__init__` can populate attributes progressively.
- Keep contracts cheap (shape and membership checks). Use `deal.disable()` if runtime overhead ever matters.
- `deal` is a Python package. Install it with the project's package manager: `uv add deal`.

## polars, never pandas

The user does not know pandas, so write all data analysis in polars.

- pandas is allowed only at the anndata boundary, where it is unavoidable: `adata.obs` and `var` ARE pandas DataFrames.
- Convert once with `pl.from_pandas(adata.obs)` and do all further work in polars.
- When constructing an AnnData, build the frame in polars and pass `.to_pandas()` to `ad.AnnData(obs=..., var=...)`.
- Prefer polars for any tabular output, and keep printouts friendly (polars tables) rather than raw pandas screenshots.

## Scratch Python work

- Use the permanent virtual environment at `/Users/subwave/dev/tmp/random-tasks/.venv` for ad hoc scripts, exploration, and other one-off tasks.
- Put temporary scripts and generated scratch files in `/tmp`, but run them with `/Users/subwave/dev/tmp/random-tasks/.venv/bin/python` or `uv` targeting that environment. Do not use the system Python.
- Keep project-specific Python work in the project's own environment.
- Use `py_explore` for read-only exploration. Use bash or write tools for anything that writes files.
