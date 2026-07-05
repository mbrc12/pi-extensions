# pi-extensions

Custom extensions for [pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

### `ask-question`

Adds an `ask_question` tool that renders an interactive TUI dialog. Supports single-choice (radio), multiple-choice (checkboxes), and free-text input. Rings a terminal bell on open and aborts the turn on cancel.

### `exit-alias`

Registers `/exit` as a shorthand alias for `/quit`.

### `minimal-tools`

Compact TUI rendering for all built-in tools — truncated commands for bash, just the path for read/write/edit. Uses `renderShell: "self"` to minimize padding.

### `notify-on-idle`

Sends a desktop notification (via terminal bell + OSC sequences / Windows toast) when the agent finishes a turn or the session shuts down. Works across tmux, Kitty, and Windows Terminal.

### `permissions`

Intercepts tool calls and classifies them before execution. Three modes:

| Mode | Behavior |
|---|---|
| `allow` | Everything passes through |
| `classify` | Two-stage: rule-based → LLM → prompt user |
| `ask` | Every tool call prompts for confirmation |

Toggle with `/permissions allow|classify|ask` or `F8`.

### `prompt-prefix`

Adds a `»` prefix before the editor prompt to visually distinguish it from assistant output.

### `statusline`

Replaces the default footer with a compact statusline showing cwd (with git branch), context window usage, cumulative token I/O, cost, model, thinking level, and extension statuses. Toggle with `/statusline`.

### `web-use`

Adds a `web_use` tool for search and fetch:

| Mode | Description |
|---|---|
| `search` | Search DuckDuckGo, return titles/URLs/descriptions |
| `fetch` | Fetch a URL and extract the important text |

Uses DuckDuckGo for search and a local Python script with `readability-lxml` for extraction.
