# pi-extensions

Custom extensions for [pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

### `permissions`

Intercepts tool calls and classifies them before execution. Three modes:

| Mode | Behavior |
|---|---|
| `allow` | Everything passes through |
| `classify` | Two-stage: rule-based → LLM → prompt user |
| `ask` | Every tool call prompts for confirmation |

Toggle with `/permissions allow|classify|ask` or `F8`.

### `web-use`

Adds a `web_use` tool that lets the model search DuckDuckGo or fetch and summarize a URL's content. Uses DuckDuckGo for search and a local Python script with `readability-lxml` for fetching/extraction.

| Mode | Description |
|---|---|
| `search` | Search DuckDuckGo, return titles/URLs/descriptions |
| `fetch` | Fetch a URL and extract the important text |

### `ask-question`

Adds an `ask_question` tool that renders an interactive TUI dialog for the user. Supports single-choice (radio), multiple-choice (checkboxes), and free-text input. Rings a terminal bell on open and aborts the turn on cancel.
