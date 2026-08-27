# pi-extensions

Custom extensions for [pi](https://pi.dev/).

## Extensions

### `ask-question`

Adds an `ask_question` tool that renders an interactive TUI dialog. Supports single-choice (radio), multiple-choice (checkboxes), and free-text input. Emits a `prompt_wait` notification when the UI opens and aborts the turn on cancel.

### `code-block-box`

Renders fenced code in assistant messages as one single-line Unicode box-drawing frame with a borderless language label set into its top border. Code lines are numbered and separated by a vertical gutter; long unbroken lines wrap within the frame without overflowing the terminal. Use `/code-block-box off` to restore Pi's native rendering for the session, or `/code-block-box on` to re-enable it.

### `exit-alias`

Registers `/exit` as a shorthand alias for `/quit`.

### `minimal-tools`

Compact TUI rendering for all built-in tools — truncated commands for bash, just the path for read/write/edit. Uses `renderShell: "self"` to minimize padding.

### `notify-on-idle`

Sends a desktop notification (via terminal bell + OSC sequences / Windows toast) when the agent finishes a turn, the session shuts down, or a `prompt_wait` event fires. Works across tmux, Kitty, and Windows Terminal.

### `py-explore`

Adds a `py_explore` tool for running read-only/exploratory Python scripts.

- Use it for quick data inspection, polars/pandas/numpy exploration, and small read-only transformations.
- Prefer it over Python heredocs or `python -c` via `bash` for read-only scripts.
- Prefers the interpreter from `uv python find --no-python-downloads` and falls back to the system Python if uv is unavailable or invalid.
- Collapses submitted code and output by default; use `Ctrl+O` to expand both.
- Code is gated by a regex deny-list and a cheap LLM check that blocks writes, deletes, moves, copies, and destructive subprocesses.
- Also registers `/py-explore-test` to tune the LLM write-check prompt against a built-in test suite.

### `prompt-prefix`

Adds a `»` prefix before the editor prompt to visually distinguish it from assistant output.

### `recap`

Shows a small recap widget after 30 seconds without user input, then hides it as soon as the user types again. The recap gives a brief "Now" summary and "Next" suggestion. Toggle/show with `/recap`, `/recap on`, or `/recap off`.

### `permissions`

Intercepts tool calls and classifies them before execution. Emits `prompt_wait` before approval dialogs. Three modes:

| Mode | Behavior |
|---|---|
| `allow` | Everything passes through |
| `classify` | Two-stage: rule-based → LLM → prompt user |
| `ask` | Every tool call prompts for confirmation |

Toggle with `/permissions allow|classify|ask` or `F8`.

### `statusline`

Replaces the default footer with a compact two-line statusline:
- Line 1: cwd (with git branch) · context · token I/O
- Line 2: model/thinking · cost · extension statuses (permissions first; extras separated by ·)

Toggle with `/statusline`.

### `subagent`

Adds a `subagent` tool that delegates tasks to specialized agents with isolated context windows. Spawns a separate `pi` process per invocation.

Supports three modes:

| Mode | Params | Description |
|---|---|---|
| `single` | `agent` + `task` | Run one agent |
| `parallel` | `tasks` array | Run multiple agents concurrently (up to 16 concurrency, 16 max tasks) |
| `chain` | `chain` array | Run agents sequentially, each sees the previous agent's output via `{previous}` placeholder |

Each single request, parallel task, or chain step may include `models`, an ordered list of scoped names such as `openai-codex/gpt-5.6-luna` or `opencode-go/deepseek-v4-flash`. The tool tries each model in order and uses the first one that responds. Agent frontmatter supports the same list through `models` (with legacy single-value `model` still accepted).

The `agentScope` param controls where agents are loaded from:

| Scope | Source |
|---|---|
| `user` (default) | `~/.pi/agent/agents/` |
| `project` | `.pi/agents/` in the nearest project parent |
| `both` | Both, project agents shadowing user agents of the same name |

Project-local agents require user confirmation by default (`confirmProjectAgents`). Subagent tool-result details include per-task usage stats (tokens, cost, turns), and the statusline aggregates subagent cost into the total.

Progress summaries: a secondary model (GPT-5.4-mini by default) is called every 60s to produce a one-line "Progress: ..." status line shown under the running agent.

### `thinking-tail`

Collapses long thinking blocks to the last 5 non-empty lines. Ctrl+O expands the full thinking run; pressing it again re-collapses. The tail updates live as thinking streams and is applied to restored historical messages on reload. Preserves Pi's native `type="thinking"` rendering throughout.

### `todo-list`

A simplified plan-mode todo list the model can't ignore. Registers a `todo` tool (list/add/complete/clear) plus a `/todo-clear` command.

The model is kept on-task by layering three reinforcement mechanisms:

- `promptGuidelines` instruct the model to call `todo list` at the start of every turn and mark jobs complete as it finishes them.
- `before_agent_start` re-injects the remaining todos each turn so they're never out of context.
- `agent_end` watchdog auto-continues (via a follow-up user message) when the model stops with incomplete todos, capped at 3 consecutive no-progress turns. It also nudges the model once if it stops with all todos marked complete but the list not yet cleared.

`clear` is guarded: blocked while incomplete todos remain, allowed once all are done. Users can force-clear anytime via `/todo-clear`. State is stored in tool-result details and reconstructed from the session branch, so branching keeps the correct state.

Todo mutations are hidden from the transcript (`renderShell/renderCall/renderResult: Container`) so the todo widget and `/todos` command remain the user-facing interface.

### `web-use`

Adds a `web_use` tool for search and fetch:

| Mode | Description |
|---|---|
| `search` | Search DuckDuckGo, return titles/URLs/descriptions |
| `fetch` | Fetch a URL and extract the important text |
| `full` | Fetch the raw HTML of a page via curl (8 KB preview in output) |

Uses DuckDuckGo for search and a local Python script with `readability-lxml` for extraction. Model selection for summarization is configurable via `model-config.json`.

---

## Shared Modules

### `shared/model-config.ts`

Centralized model configuration used by multiple extensions. Defines `ModelConfigPurpose` types:

| Purpose | Used by | Default models |
|---|---|---|
| `recapGeneration` | `recap` | Scoped model fallback list in `model-config.json` |
| `subagentProgressSummary` | `subagent` | Scoped model fallback list in `model-config.json` |
| `webSummarization` | `web-use` | Scoped model fallback list in `model-config.json` |
| `permissionClassification` | `permissions` | Scoped model fallback list in `model-config.json` |
| `pythonWriteClassification` | `py-explore` | Scoped model fallback list in `model-config.json` |

Managed via `model-config.json` in the extensions root.
