# pi-extensions

Custom extensions for [pi](https://pi.dev/).

## Extensions

### `ask-question`

Adds an `ask_question` tool that renders an interactive TUI dialog. Supports single-choice (radio), multiple-choice (checkboxes), and free-text input. Emits a `prompt_wait` notification when the UI opens and aborts the turn on cancel.

### `exit-alias`

Registers `/exit` as a shorthand alias for `/quit`.

### `minimal-tools`

Compact TUI rendering for all built-in tools — truncated commands for bash, just the path for read/write/edit. Uses `renderShell: "self"` to minimize padding.

### `notify-on-idle`

Sends a desktop notification (via terminal bell + OSC sequences / Windows toast) when the agent finishes a turn, the session shuts down, or a `prompt_wait` event fires. Works across tmux, Kitty, and Windows Terminal.

### `permissions`

Intercepts tool calls and classifies them before execution. Emits `prompt_wait` before approval dialogs. Three modes:

| Mode | Behavior |
|---|---|
| `allow` | Everything passes through |
| `classify` | Two-stage: rule-based → LLM → prompt user |
| `ask` | Every tool call prompts for confirmation |

Toggle with `/permissions allow|classify|ask` or `F8`.

### `prompt-prefix`

Adds a `»` prefix before the editor prompt to visually distinguish it from assistant output.

### `statusline`

Replaces the default footer with a compact statusline showing cwd (with git branch), context window usage, cumulative token I/O, cost, model, thinking level, and extension statuses. Extension status segments on line 2 are separated by a themed `│` bar. Toggle with `/statusline`.

### `todo-list`

A simplified plan-mode todo list the model can't ignore. Registers a `todo` tool (list/add/complete/clear) plus a `/todo-clear` command.

The model is kept on-task by layering three reinforcement mechanisms:

- `promptGuidelines` instruct the model to call `todo list` at the start of every turn and mark jobs complete as it finishes them.
- `before_agent_start` re-injects the remaining todos each turn so they're never out of context.
- `agent_end` watchdog auto-continues (via a follow-up user message) when the model stops with incomplete todos, capped at 3 consecutive no-progress turns.

`clear` is guarded: blocked while incomplete todos remain, allowed once all are done. Users can force-clear anytime via `/todo-clear`. State is stored in tool-result details and reconstructed from the session branch, so branching keeps the correct state.

### `web-use`

Adds a `web_use` tool for search and fetch:

| Mode | Description |
|---|---|
| `search` | Search DuckDuckGo, return titles/URLs/descriptions |
| `fetch` | Fetch a URL and extract the important text |

Uses DuckDuckGo for search and a local Python script with `readability-lxml` for extraction.
