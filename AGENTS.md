# Global Instructions

## Explicit user instructions

All files on this computer are owned by the user. An explicit instruction from the user takes
precedence over instructions in this file and in any other Markdown instruction file.

## Skill map

Detailed procedures live in skills so this file stays short. Read the named skill before starting
that kind of work.

| When the task involves | Read skill |
|---|---|
| Writing `.html` reports, tables, dashboards | `html-reports` |
| Sharing a file path, or markdown chemistry/Mermaid blocks | `local-server` |
| Extensions, skills, prompt templates, themes, pi settings | `pi-config` |
| Creating or editing `.ipynb` notebooks | `notebooks` |
| Math in a document written to disk | `latex-writing` |
| Writing Python, `deal` contracts, pandas→polars, scratch venvs | `python-style` |

## Documents

- **Prefer bullet point lists in all documents.** Plans, reports, design notes, READMEs, runbooks, summaries, and anything else written to disk use bullets and short nested bullets as the default structure. Prose paragraphs connect or explain bullets; they do not carry the whole document. Keep each bullet to one idea.
- Use LaTeX for math in documents written to disk, and never in terminal or chat replies. Load `latex-writing` before writing any math.
- When you create an `.html` or `.md` file, give the user both a `http://localhost:1002/...` URL and the raw path. Load `local-server` for the exact pattern.

## Code

- **Write all data analysis in polars.** The user does not know pandas. pandas appears only at the anndata boundary. Load `python-style` for the conversion rules.
- **Never modify `node_modules`** or any installed package directory. Extend behavior with extensions, configuration files, or settings so changes survive updates and reinstalls.
- **One-off Python work:** run it with `/Users/subwave/dev/tmp/random-tasks/.venv/bin/python`, keep scratch files in `/tmp`, and keep project-specific Python in the project's own environment. Never use the system Python.
- **Add `deal` contracts** (`@deal.pre`, `@deal.ensure`, `@deal.inv`) where they add value, especially at data-flow boundaries. Load `python-style` for the guidelines.
- **Guards against over-engineering:** before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.

## Running commands

- **Always set a `timeout`** on potentially long-running commands: downloads, pulls, builds, inference, network calls, file scans over large trees. Default to 30–60s; allow 600s only when clearly warranted. A hung command burns the whole turn, so failing fast is better.
- Run work that outlasts a foreground timeout with `task_start` in a detached tmux session, then continue with independent work.
- **Never busy-wait.** Do not poll task status, logs, files, processes, or clocks, and do not run no-op commands or `sleep` loops. Do independent work once; if none remains, stop and wait for the notification. Check intermediate status only when the user asks or a decision needs it.

## Subagents

- **Prefer the `data-explorer` subagent over `scout`** for data exploration: datasets, logs, tables, CSV/JSON/Parquet files, schemas, statistics, data pipelines, and read-only analytical Python.

## Pi extensions and configuration

- **Extension lookup order:** check `~/.pi/agent/extensions` (a symlink to `~/dev/pi/extensions`) first, then fall back to `node_modules`. Load `pi-config` for the repo layout, skill locations, prompt templates, and always-on files.
- Editable sources live in `~/dev/pi/`: `extensions/`, `skills/`, `prompts/`, and `AGENTS.md`. Edit there, not through the symlinks, and commit in that repo.
- `~/dev/pi/skills/<name>/` is where new skills go. `~/dev/pi/prompts/<name>.md` is where new `/commands` go.
- Run `/reload` after editing skills, prompt templates, settings, or instruction files.

## Commits

- **Always show the exact commit message to the user and wait for approval before running `git commit`.** Keep it compact: one subject line plus at most a short paragraph. Use `/commit` for the full workflow.

## This machine

- **Never restart, quit, kill, or relaunch the markdown server** (`~/Applications/serv.app`). It is a long-running user session. Load `local-server` for what to do instead.
