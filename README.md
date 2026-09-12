# pi-extensions

Custom extensions for [pi](https://pi.dev/).

## Extensions

### `cleanup`

Registers `/cleanup`, which sends the model a hidden comprehensive instruction to stop active processing and clean up session-related local and cloud resources. It steers the current turn when the agent is busy and does not directly execute cleanup actions.

### `ask-question`

Adds an `ask_question` tool that renders an interactive TUI dialog. Supports single-choice (radio), multiple-choice (checkboxes), and free-text input. Emits a `prompt_wait` notification when the UI opens and aborts the turn on cancel.

### `code-block-box`

Renders fenced code in assistant messages as one single-line Unicode box-drawing frame with a borderless language label set into its top border. Code lines are numbered and separated by a vertical gutter; long unbroken lines wrap within the frame without overflowing the terminal. Use `/code-block-box off` to restore Pi's native rendering for the session, or `/code-block-box on` to re-enable it.

### `codex-account-alias`

Registers `openai-codex-2` as a second independent Codex OAuth provider. It reuses Pi's built-in Codex models and request implementation while keeping a separate credential under the alias provider ID. It does not perform account rotation or automatic failover.

### `exit-alias`

Registers `/exit` as a shorthand alias for `/quit`.

### `fast`

Registers `/fast` to toggle OpenAI priority processing for the current session. Use `/fast on`, `/fast off`, or `/fast status` for an explicit action. The setting applies to direct OpenAI and OpenAI Codex providers, including numbered Codex account aliases, and survives session reloads and branching. Subagents inherit it only when their selected model uses `openai-codex` or a numbered alias such as `openai-codex-2`; other subagent providers do not receive the setting. Priority processing may use paid API capacity or plan credits faster.

### `minimal-tools`

Compact TUI rendering for all built-in tools — truncated commands for bash, just the path for read/write/edit. Uses `renderShell: "self"` to minimize padding.

### `notify-on-idle`

Sends a desktop notification (via terminal bell + OSC sequences / Windows toast) when the agent finishes a turn, the session shuts down, or a `prompt_wait` event fires. Works across tmux, Kitty, and Windows Terminal.

### `provider-status`

Adds provider-specific limits to the statusline. Two adapters are available:

- `openai-codex` and numbered aliases such as `openai-codex-2`: each 5-hour or 7-day window as its remaining percentage and reset countdown.
- `opencode-go`: the rolling 5-hour, weekly, and monthly Go plan windows, read from `https://opencode.ai/zen/go/v1/usage` with the stored API key.

Usage refreshes every five minutes, while countdowns update every minute. Run `/provider-status` to force a detailed refresh.

### `py-explore`

Adds a `py_explore` tool for running read-only/exploratory Python scripts.

- Use it for quick data inspection, polars/pandas/numpy exploration, and small read-only transformations.
- Prefer it over Python heredocs or `python -c` via `bash` for read-only scripts.
- Prefers the interpreter from `uv python find --no-python-downloads` and falls back to the system Python if uv is unavailable or invalid.
- Collapses submitted code and output by default; use `Ctrl+O` to expand both.
- Code is gated by a regex deny-list and a cheap LLM check that blocks writes, deletes, moves, copies, and destructive subprocesses.
- Also registers `/py-explore-test` to tune the LLM write-check prompt against a built-in test suite.

### `profile`

Adds `/profile` to limit model use in the current session. Run `/profile` to choose a profile, or use `/profile <name>` directly. Each profile has an `allow` list of JavaScript regular expressions matched against the full `provider/model-id` string. It also has a `defaultModel`. Selecting a profile switches the main session to that model.

The profile filters Pi's model picker and model cycling. It also filters every fallback list read through `shared/model-config.ts`, including subagents, summaries, web extraction, permission checks, and Python write checks. These background operations still use their own model-config entries; they do not use the profile's default model. Spawned subagents inherit the active filter while preserving the model selected for their capability tier. If the session already has a model scope, the profile is applied as an additional filter. When `/fast` is enabled in the caller, a subagent attempt inherits priority processing only if its selected provider is `openai-codex` or a numbered alias such as `openai-codex-2`.

The selected profile is stored in the session and restored on resume. New sessions start with `home`. Profiles are configured under `profiles` in `model-config.json`. At startup, the extension checks every profile's regular expressions and default model. It also checks that every shared model category and each subagent capability tier has at least one allowed model in Pi's model catalog. Invalid profiles are reported and cannot be activated.

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

Plan mode is disabled. Permission controls remain available through `/permissions allow|classify|ask` and the `F8` shortcut.

### `statusline`

Replaces the default footer with a compact three-line statusline:

- Line 1: cwd (with git branch) · context · cumulative token input/output · generation speed (`tok/s`) · current or last subagent time
- Line 2: provider/model · thinking level · cost · provider limits
- Line 3: `🧩:` followed by statuses supplied by other extensions, such as permissions, todo, and thinking-tail

The `sub` timer on line 1 restarts at `0s` for each new subagent tool call. It updates once per second while a subagent runs, then keeps the duration of the last completed subagent.

The `tok/s` item shows output speed in tokens per second as an exponential moving average with a 20-second half-life. Streamed deltas are what move it, and each tick uses the model's learned characters-per-token density so the estimate stays close to the reported token counts. A finished response seeds the first value and re-learns that density, but never re-blends the exact rate: the number does not jump when generation stops. Idle time between responses and while tools run does not lower the value. The item first appears when the session's first response finishes, and after a model switch the average converges over that model's first response instead of holding the previous model's rate.

Costs use US dollars by default. Use `/rupees on` to replace the USD cost with INR and `/rupees off` to switch back to USD.

Toggle with `/statusline`.

### `subagent`

Adds a `subagent` tool that delegates tasks to specialized agents with isolated context windows. Spawns a separate `pi` process per invocation.

Supports three modes:

| Mode | Params | Description |
|---|---|---|
| `single` | `agent` + `task` | Run one agent |
| `parallel` | `tasks` array | Run multiple agents concurrently (up to 16 concurrency, 16 max tasks) |
| `chain` | `chain` array | Run agents sequentially, each sees the previous agent's output via `{previous}` placeholder |

Each agent frontmatter sets `capability: low`, `medium`, `high`, or `image`. The caller can set one invocation-level `strength` override (`low`, `medium`, or `high`) for every selected agent. The tool description tells callers to use the lowest strength that can reliably complete the task. The subagent UI shows the requested override and each agent's effective strength.

A caller can also set `wise: true` for any subagent. Use top-level `wise` in single mode, or set it on an individual item in `tasks` or `chain`. Wise mode sends the caller's active, compaction-aware conversation context to the cheap `wiseCompacter` model, then passes its compact Markdown packet to that subagent as untrusted background beside the normal delegated task. It omits assistant thinking and bounds unusually large source text before compaction. Parallel and chain calls generate the packet once and share it only with items that set `wise: true`. `wise` is a caller option, not agent frontmatter.

```json
{"agent":"worker","task":"Implement the fix","wise":true}
```

```json
{"tasks":[{"agent":"scout","task":"Inspect the code","wise":true},{"agent":"reviewer","task":"Review this file"}]}
```

Model lists live only in `model-config.json`. `subagentModels` controls agent execution: the tool cycles general-purpose tiers as `low → medium → high`, `medium → high → low`, or `high → low → medium`; the `image` tier tries only its listed image-capable models. `wiseCompacter` is an independent cheap-model fallback list for wise-mode context compaction. Within any list, Pi uses the first model that responds.

For example:

```yaml
---
name: data-explorer
description: Read-only data exploration specialist
capability: low
---
```

The `agentScope` param controls where agents are loaded from:

| Scope | Source |
|---|---|
| `user` (default) | `~/.pi/agent/agents/` |
| `project` | `.pi/agents/` in the nearest project parent |
| `both` | Both, project agents shadowing user agents of the same name |

Project-local agents require user confirmation by default (`confirmProjectAgents`). Subagent tool-result details include per-task usage stats (tokens, cost, turns), and the statusline aggregates subagent cost into the total.

Subagent progress summaries are disabled. Their generation, activation, and rendering code remains commented in `subagent/index.ts` so it can be restored later.

### `thinking-tail`

Collapses long thinking blocks to the last 5 non-empty lines. Ctrl+O expands the full thinking run; pressing it again re-collapses. The tail updates live as thinking streams and is applied to restored historical messages on reload. Preserves Pi's native `type="thinking"` rendering throughout.

### `working-indicator`

Replaces the default working loader with a ping-pong dots spinner, 200 randomly selected deadpan technical excuses, live tool activity, and elapsed time. Consecutive fallback messages never repeat.

### `tool-summary`

Shows one compact, muted line after each turn that uses tools: `Tool: <summary>`. The italic ASD-STE100 text prefers a few words over a full sentence and focuses on tool actions and key results. It keeps the conversation context in mind without summarizing overall progress or repeating an obvious file name from the tool call.

The extension immediately reserves one transcript position after the turn's tool calls with `Tool: Summarizing…`, then replaces that text in place when asynchronous generation finishes. It never blocks the main agent loop or the next tool. Summaries are stored as custom session entries and never enter the main model's context. Any turn that uses `todo` gets no summary, even if it also uses other tools. The blacklist in `tool-summary.ts` omits `ask_question` and `web_use` from summaries; turns containing only blacklisted tools also produce no summary. Toggle summaries for the current session with `/tool-summary on` or `/tool-summary off`; the setting survives reloads within that session.

Each stored resolution entry also records the provider and model that produced the summary, such as `opencode-go/mimo-v2.5`, so a session can be audited for the model that really answered.

Run `/tool-summary-model` to probe the configured fallback list. It sends one minimal request through the same selection path and shows the candidate order, the active profile, every skipped or failed candidate with its error, and the model that answered. The same report is written to a widget above the editor.

Summary generation asks OpenCode models to answer without reasoning. `mimo-v2.5` otherwise spends 700–1750 tokens reasoning about a one-line summary, and a small token cap is then consumed before it writes any text, so the selector treats the response as empty and moves to the next model. The request allows 1024 output tokens so a reasoning fallback model still fits. For the same reason the `toolSummaryGeneration` list is short: `opencode-go/mimo-v2.5`, then the two Codex Luna accounts.

### `todo-list`

A simplified plan-mode todo list. Registers a `todo` tool (list/add/complete/clear), a `/todo-clear` command, and a `/todo-inject on|off` toggle.

The model is kept on-task by layering three reinforcement mechanisms:

- `promptGuidelines` tell the model when to create todos, inspect their state, and mark jobs complete.
- Optional `before_agent_start` injection adds the remaining todos to the model context each turn. It is off by default. Use `/todo-inject on` to enable it and `/todo-inject off` to disable it for the current session. When injection is on, the existing todo status shows `📌`; when it is off, the status has no injection marker.
- While injection is enabled, the `agent_end` watchdog auto-continues (via a follow-up user message) when the model stops with incomplete todos, capped at 3 consecutive no-progress turns. It also nudges the model once if it stops with all todos marked complete but the list not yet cleared. `/todo-inject off` disables both watchdog behaviours.

`clear` is guarded: blocked while incomplete todos remain, allowed once all are done. Users can force-clear anytime via `/todo-clear`. Tool actions store state in tool-result details. User commands store state as custom session entries. State is reconstructed from the session branch, so settings survive resume and branching keeps the correct state.

Todo mutations are hidden from the transcript (`renderShell/renderCall/renderResult: Container`) so the todo widget and `/todos` command remain the user-facing interface.

### `web-use`

Adds a `web_use` tool for search and fetch, implemented in TypeScript in `web-use/web.ts`:

| Mode | Description |
|---|---|
| `search` | Search the web via Exa, return titles/URLs/descriptions |
| `fetch` | Fetch a URL and extract the important text |
| `full` | Fetch the raw HTML of a page via curl (8 KB preview in output) |

Backend order lives at the top of `web-use/web.ts`. Swap or drop entries in these two arrays to change which backend runs first; a request tries them left to right until one succeeds.

| Constant | Default | Order |
|---|---|---|
| `SEARCH_BACKENDS` | `["ddg", "exa"]` | DuckDuckGo, then Exa |
| `FETCH_BACKENDS` | `["curl", "exa"]` | curl, then Exa |

The backends:

- `ddg` — DuckDuckGo's no-JS endpoint at `https://html.duckduckgo.com/html/`. DuckDuckGo gates its JS result payload (`links.duckduckgo.com/d.js`) behind an anti-bot challenge, so that route returns an anomaly page; the HTML endpoint still answers a browser-like GET.
- `exa` — keyless Exa MCP (`https://mcp.exa.ai/mcp`) for search and fetch. Set `EXA_API_KEY` to send `x-api-key` and lift the free-plan rate limits, or `EXA_MCP_URL` to point at another endpoint.
- `curl` — plain page fetch, with the text extracted by the HTML parser in the same file.

Model selection for summarization is configurable via `model-config.json` (`webSummarization`).

---

## Shared Modules

### `shared/model-config.ts`

Centralized model configuration used by multiple extensions. It defines fallback purposes and subagent capability tiers:

| Config key | Used by | Model selection |
|---|---|---|
| `profiles` | `profile` and all shared model selection | Named `allow` regex lists and main-session default models |
| `recapGeneration` | `recap` | Scoped model fallback list in `model-config.json` |
| `toolSummaryGeneration` | `tool-summary` | Scoped model fallback list in `model-config.json` |
| `subagentModels` | `subagent` | `low`, `medium`, and `high` cyclic model lists, plus an image-only `image` list |
| `subagentProgressSummary` | `subagent` | Reserved fallback list for the currently disabled progress-summary code |
| `wiseCompacter` | `subagent` | Cheap-model fallback list for caller-selected wise context compaction |
| `webSummarization` | `web-use` | Scoped model fallback list in `model-config.json` |
| `permissionClassification` | `permissions` | Scoped model fallback list in `model-config.json` |
| `pythonWriteClassification` | `py-explore` | Scoped model fallback list in `model-config.json` |

Managed via `model-config.json` in the extensions root.

The shared selector also adds the `x-opencode-session` and `x-opencode-client` headers for OpenCode-hosted models. Pi adds these only inside its own agent loop; extension requests call the model registry directly, and the OpenCode gateway rejects them with `MissingSessionID` without the headers. Every purpose list that starts with an `opencode-go` model needs this, or the first candidate fails and the request silently falls through to the next model. Pass `onCandidateFailure` to a completion call to see those failures.

Set `disableReasoning` in the same options to send `reasoning_effort: "none"` for OpenCode-hosted models. Other providers reject that value, as do OpenCode's own `minimax-m2.7` and `glm-5.3`, so keep it off for any purpose list that contains them.
