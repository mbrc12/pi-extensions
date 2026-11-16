---
name: python-env
description: Create and maintain Python projects and virtual environments on this machine with uv, using the local basedpyright and ruff from ~/.local/bin and a standard quiet type-checker config. Use whenever a new Python project, venv, or dependency is created, an environment is repaired, or type-checker warnings need quieting.
license: MIT
---

# Python environments

Create every environment with `uv`. Never use `python -m venv`, `virtualenv`, `pip install`,
`conda`, or `micromamba` for a new project.

## Tool layout on this machine

| Tool | Path | Use |
|---|---|---|
| `uv` | `/opt/homebrew/bin/uv` | all environment and dependency work |
| `basedpyright` | `~/.local/bin/basedpyright` | type checking, LSP |
| `ruff` | `~/.local/bin/ruff` | lint and format |

## Never install a language server or linter

`basedpyright`, `pyright`, `ruff`, `mypy`, `pylsp`, `python-lsp-server`, `ruff-lsp`, and
`jedi-language-server` already exist outside every project environment. Do not add them as
dependencies and do not install them into a `.venv`.

- Add them only to a project when an editor config names an explicit executable path.
- If a tool appears in `.venv/bin`, remove it with `uv remove <name>`.
- Never upgrade or reinstall the `~/.local/bin` copies as part of project work.

## New project

```bash
uv init --python 3.13 myproj        # writes pyproject.toml and .python-version
cd myproj
uv add polars deal                  # every dependency goes through uv
uv run python -c "import polars; print(polars.__version__)"
```

- `uv init --package` for an importable library; plain `uv init` for scripts and analysis folders.
- For a scratch or script-only folder, add `[tool.uv] package = false` so nothing is built.
- Pin the interpreter in `requires-python` and in `.python-version`. Both must name the same minor
  version.
- Commit `uv.lock`. Recreation is then `uv sync`.

## Standard `pyproject.toml` tail

Copy this block into every new project. It keeps basedpyright's recommended mode while silencing
the diagnostics that fire on untyped third-party data code and short scripts.

```toml
[tool.basedpyright]
reportMissingTypeStubs = false
reportMissingParameterType = false
reportUnknownArgumentType = false
reportUnknownLambdaType = false
reportUnknownMemberType = false
reportUnknownParameterType = false
reportUnknownVariableType = false
reportAny = false
reportExplicitAny = false
reportUnusedCallResult = false
reportUnusedParameter = false
reportUnreachable = false
reportImplicitOverride = false
reportPrivateUsage = false
reportImportCycles = false
reportImplicitStringConcatenation = false
```

What stays enabled, deliberately: `reportMissingImports`, `reportUndefinedVariable`,
`reportAttributeAccessIssue`, `reportArgumentType`, `reportAssignmentType`,
`reportReturnType`, `reportIndexIssue`, `reportCallIssue`.

- The `reportUnknown*` family and `reportMissingParameterType` are what produce "Type of X is
  unknown" floods on polars, deal, jax, and gdsfactory code.
- `reportExplicitAny` and `reportAny` reject `Any` even where the annotation is honest.
- `reportUnusedCallResult` flags every ignored return value, which is normal in scripts.
- Do not raise `typeCheckingMode` above `recommended` for analysis code.

If a project needs per-directory exceptions, use `pyrightconfig.json` with an `include`/`exclude`
split rather than re-enabling the rules above.

## Checking a project

```bash
uv run basedpyright src        # from the project root; finds .venv automatically
uv run ruff check --fix .
uv run ruff format .
```

Here `uv run` inherits PATH, so it finds the `~/.local/bin` executables without installing them.
If discovery fails, pass the interpreter explicitly instead of installing a copy:

```bash
basedpyright --pythonpath .venv/bin/python src
```

## Views and editors

basedpyright finds `.venv` at the project root on its own. Do not write an absolute
`venvPath`/`venv` pair into `pyproject.toml`; it breaks when the project moves.

## Existing or broken environments

- Add a package: `uv add <pkg>`. Never `pip install` into `.venv`.
- Rebuild a drifted environment: delete `.venv` and run `uv sync`. Keep `uv.lock`.
- Switch interpreter: `uv python pin 3.14`, then `uv sync`.
- A venv created outside uv is worth replacing, not repairing, unless it holds work you cannot
  reproduce from a lockfile.

## Scratch work

Ad hoc scripts use the permanent environment at `/Users/subwave/dev/tmp/random-tasks/.venv`, run
as `/Users/subwave/dev/tmp/random-tasks/.venv/bin/python`. Pass `venv` to `py_explore` when it needs
that environment's packages. Do not create a new venv for a one-off script.
