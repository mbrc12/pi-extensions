# Extensions

Custom extensions for [pi](https://pi.dev/). The source lives here; `~/.pi/agent/extensions` is a
symlink to this folder.

| Extension | Purpose |
|---|---|
| `tui/banner` | Replaces the startup header and resource listing with two compact lines |
| `tui/code-block-box` | Draws fenced assistant code in a single-line Unicode box |
| `tui/codemode-compact` | Collapses codemode calls to one line each; `Ctrl+O` expands |
| `tui/image-links` | Adds a clickable link for images a tool returns (tmux drops inline images) |
| `tui/minimal-tools` | Compact rendering for built-in tools: truncated commands, bare paths |
| `tui/odin-highlight` | Adds Odin syntax highlighting for `odin` fenced blocks |
| `tui/prompt-prefix` | Puts a `»` before the editor prompt |
| `tui/statusline` | Replaces the footer with cwd, tokens, speed, model, cost, and limits |
| `tui/thinking-tail` | Shows only the last 5 displayed lines of long thinking blocks |
| `tui/vscode-theme` | Switches theme inside a VS Code terminal without touching global settings |
| `tui/working-indicator` | Ping-pong spinner with tool activity, elapsed time, and dry one-liners |
| `tools/ask-question` | `ask_question` dialog: single-choice, multi-choice, or free text |
| `tools/context` | `context_recall`: search and read messages hidden by compaction |
| `tools/export-md` | `/export-md` writes the session branch as a Markdown transcript |
| `tools/memory-store` | Persistent memory in SQLite with FTS5 search plus LLM rerank |
| `tools/permissions` | Classifies and approves tool calls (`allow`, `classify`, `ask`) |
| `tools/py-explore` | `py_explore` runs read-only Python, gated by deny-list and LLM check |
| `tools/quiz` | `quiz` tool that grades an inline answer (currently unloaded) |
| `tools/self_compact` | `self_compact` lets the model compact at a boundary it chooses, with a note |
| `tools/task-backgrounder` | `task_start`/`status`/`stop`/`clear` run commands in detached tmux |
| `tools/todo-list` | `todo` tool and `/todo-*` commands; optional per-turn injection (currently unloaded) |
| `tools/web-use` | `web_use` search and fetch over DDG, Exa, and curl backends |
| `agents/subagent` | `subagent` delegation in single, parallel, and chain modes |
| `agents/background-subagent` | `background_subagent` runs one agent without blocking the caller |
| `agents/multiagent` | `multiagent` manages persistent named operators |
| `models/codex-account-alias` | Adds `openai-codex-2` as a second Codex OAuth account |
| `models/fast` | `/fast` toggles OpenAI priority processing for the session |
| `models/profile` | `/profile` limits usable models to a named allow-list |
| `models/provider-status` | Adds Codex and opencode-go usage limits to the statusline |
| `models/tool-summary` | One muted `Tool: <summary>` line after each tool turn |
| `session/cleanup` | `/cleanup` tells the model to stop and clean up session resources |
| `session/exit-alias` | `/exit` alias for `/quit` |
| `session/notify-on-idle` | Desktop notification when a turn ends, on shutdown, or on `prompt_wait` |
| `session/recap` | "Now" and "Next" recap widget after 30s idle (currently unloaded) |
| `session/rename` | `/rename [hint]` proposes session names from broadest to narrowest and asks you to pick one |
| `shared/` | Imported helpers: model config, fast-mode, notification gate |
| `model-config.json` | Model fallback lists and profiles used by the extensions above |

- `multiagent` tries the configured capability models in order. It retries a failed request only before the operator has used any tools; otherwise it reports the failure without replaying the assignment.

Run the tests with `cd ~/dev/pi/extensions && bun test`.
