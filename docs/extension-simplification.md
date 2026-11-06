# Extension simplification plan

Plan to shrink and regroup `~/dev/pi/extensions` from **33 loaders and 18,282 source lines**
to **12 loaders and about 15,000 lines**, without new plugins and without losing anything used.

Basis: 573 session files under `~/.pi/agent/sessions`, 45 days of tool-call history, and a
read of every extension entry point. Sizes exclude tests (**4,628** lines) and
`extensions/disabled/` (**1,776** lines).

## 1. Evidence

### Tool calls per 2-week window

| tool | 0–14 d | 14–28 d | reading |
|---|---|---|---|
| bash / read / edit / write / grep | 23.5k | 29.5k | built-in |
| codemode | 1,485 | 621 | built-in, rising fast |
| py_explore | 1,383 | 1,293 | keep, stable |
| web_use | 1,214 | 869 | keep |
| task_start / status / clear / stop | 826 / 730 / 535 / 47 | 1,266 / 2,009 / 825 / 300 | keep |
| background_subagent (+status, stop) | 515 / 58 / 28 | 416 / 155 / 14 | keep, taking over |
| ask_question | 280 | 322 | keep |
| self_compact | 195 | 236 | keep |
| **subagent** (blocking) | 12 | 143 | collapsing |
| **consult** | 15 | 0 | new, replaces context_recall |
| **multiagent** | 39 | 0 | new, barely used |
| **memory_search / add / update** | 3 / 11 / 1 | 6 / 32 / 4 | fading |
| context_recall | 31 | 107 | already superseded |

- Slash-command usage is not written to session files, so command-only extensions
  (`/explain`, `/rename`, `/fast`, `/profile`, `/cleanup`, `/export-md`) are unmeasured here.
- Of the 12 recent `subagent` calls, all used single or parallel mode and **none used chain mode**.

### Size by folder

| folder | loaders | lines | largest files |
|---|---|---|---|
| `tools/` | 9 | 10,362 | task-backgrounder 1,277 · permissions 1,777 · memory-store 1,654 |
| `tui/` | 10 | 2,982 | statusline 877 · minimal-tools 442 · banner 458 |
| `agents/` | 3 | 2,930 | subagent 1,620 · background-subagent 433 · multiagent 330 |
| `models/` | 6 | 1,772 | tool-summary 579 · provider-status 438 · profile 420 |
| `session/` | 5 | 1,006 | rename 437 · explain 447 |
| `shared/` | — | 654 | model-config 535 |

### Ownership already leaks

The folder taxonomy no longer matches the dependency graph:

- `session/explain.ts:15` imports `agents/shared/session-display.ts`.
- `session/rename.ts:2` imports `askViaUI` from `tools/ask-question.ts`, so a 640-line tool extension is also a UI library.
- `agents/background-subagent/index.ts:5-6` imports `../multiagent/viewer.ts` and `../subagent/index.ts`, so the three agent loaders are one program already.
- `tools/permissions/index.ts:18` imports `promptWait` from `session/notify-on-idle`.
- `tools/self_compact.ts:26` imports `shared/notification-gate.ts`.
- Session JSONL is parsed independently in `consult/sessions.ts`, `explain.ts`, `export-md.ts`, and `multiagent/index.ts`.

### Duplicated primitives

| helper | copies |
|---|---|
| `formatDuration` | `tui/statusline.ts:139`, `models/provider-status.ts:223`, `agents/shared/session-activity.ts:10` |
| `formatTokens` | `tools/self_compact.ts:148`, `agents/subagent/index.ts:62` |
| `truncate` | `tui/statusline.ts:76`, `agents/shared/session-display.ts:69`, `tools/py-explore/index.ts:282`, `agents/subagent/index.ts:480` |
| home-relative path | `tui/minimal-tools.ts:18`, `tui/statusline.ts:64` |

### Cost of one extension, measured

`models/tool-summary.ts` (579 lines) writes **22,683 summary entries and 22,505 resolution
entries in 14 days** for about 33,500 tool calls, so roughly one extra model request per turn.
The entries are 16 MB of 2.27 GB of recent session bytes, so the problem is request volume and
transcript noise, not disk.

### Already installed but unused

- `~/.pi/agent/npm/node_modules/pi-hermes-memory` — the same job as `tools/memory-store`.
- `~/.pi/agent/npm/node_modules/pi-multi-account` — the same job as `models/codex-account-alias.ts` plus `models/provider-status.ts`.
- Both have been idle since 2026-08-29 (`provider-failover-state.json`, debug log), and `settings.json` lists no packages.

## 2. Target layout

Twelve loaders instead of 33: one per job, each owning one piece of state. The six independent
tool extensions stay separate; folding them into one 6,000-line loader would trade a state
problem for a readability one.

| loader | absorbs | now | target |
|---|---|---|---|
| `tui/chrome.ts` | banner, banner-data, prompt-prefix, statusline, provider-status, fast, vscode-theme | 1,979 | ~1,590 |
| `tui/transcript.ts` | code-block-box, odin-highlight, thinking-tail, image-links, codemode-compact | 1,114 | ~950 |
| `tui/tool-display.ts` | minimal-tools, tool-summary (deterministic only) | 1,021 | ~650 |
| `agents/index.ts` | subagent, background-subagent, multiagent, agents.ts, viewer, session-display, session-activity | 2,930 | ~2,600 |
| `sessions/index.ts` | consult, summary, explain, explain-view, export-md, rename, cleanup, exit-alias | 2,069 | ~1,650 |
| `models/index.ts` | profile, codex-account-alias, opencode-go-account-alias | 640 | ~640 |
| six tool loaders | ask_question, self_compact, permissions, py_explore, web_use, task-backgrounder | 6,145 | ~5,795 |
| `shared/` (no loader) | model-config, notification-gate, fast-mode, notify-on-idle, **new:** session-log, session-display, duration, ui-ask, gate | 730 | ~1,100 |
| **deleted** | memory-store | 1,654 | 0 |

Line budget: 18,282 → about 14,975. `shared/` grows by ~370 lines on purpose: that is the code
that used to live inside three extensions at once.

Where the 3,300 lines go:

| change | lines |
|---|---|
| delete `tools/memory-store` | −1,654 |
| replace `models/tool-summary` with a deterministic line | −371 |
| one footer state instead of three status keys | −389 |
| trim `banner` against `quietStartup: "header"` | (inside chrome) |
| drop `subagent` chain mode and its runner | −330 |
| one sessions reader, writer, and dialog | −419 |
| renderer rewrite and one transcript pass | −350 |
| one classifier for permissions and py_explore | −150 |
| shared modules and `shared/` growth | +370 |
| delete `extensions/disabled/` | −1,776 (outside the baseline) |

## 3. Phases

Each phase ends with a working pi: `cd ~/dev/pi/extensions && bun test`, then `/reload` or a
restart, then one smoke call of the affected tool.

### Phase 1 — Delete dead weight

- Remove `tools/memory-store/` (1,654 lines, 3 tools, `memories.db` 2.1 MB, 2 test scripts).
  It is the only extension with its own model and auth resolution (`llm.ts`, 397 lines).
- Remove `extensions/disabled/` (1,776 lines, nine files; `plan-mode.ts` does not even import).
  Git history keeps them.
- Remove `~/.pi/agent/npm` packages `pi-hermes-memory` and `pi-multi-account`, plus
  `provider-failover.json`, `provider-failover-state.json`, and `provider-failover-debug.log`.
- Update `extensions/README.md`: drop the memory-store row and the whole Disabled section.
- Verification: no `memory_*` call in a smoke session; `bun test` still green.
- Risk: low. Only `memory_add` (11 calls in 14 days) stops working.

### Phase 2 — Make `shared/` real

- `shared/session-log.ts` — lift from `tools/consult/sessions.ts`: discovery, streaming, metadata, search. It becomes the only JSONL reader.
- `shared/session-display.ts` — move from `agents/shared/`, already used by `explain` and the viewers.
- `shared/duration.ts` — one `formatDuration` with the current `precise` and `clock` styles; the statusline and `provider-status` reset-countdown keep their own reset formatting.
- `shared/ui-ask.ts` — the dialog half of `tools/ask-question.ts`; the tool registration keeps using it.
- `shared/prompt-wait.ts` — `promptWait` out of `session/notify-on-idle`.
- Replace the local copies in `subagent`, `minimal-tools`, `statusline`, `tool-summary`.
- Verification: `bun test` covers `session-activity`, `subagent-display`, `consult`.
- Risk: low, mechanical.

### Phase 3 — One tool-display extension, one transcript extension

- Replace the seven `pi.registerTool` re-registrations in `minimal-tools.ts` with one
  `registerToolRenderer` resolver, the same hook `codemode-compact` and `image-links` already use. This removes the duplicated `create*Tool` instances and the module-load `process.cwd()`.
- Move `codemode-compact`, `image-links`, `code-block-box`, `odin-highlight`, and
  `thinking-tail` into one transcript loader, registering one resolver chain ordered so the
  codemode one-line rule runs before the generic collapse rule.
- Delete `models/tool-summary.ts`. Keep one deterministic muted line per turn (the command or
  path, truncated to 160 characters) in tool-display, and keep `TURN_SUMMARY_SUPPRESSORS`
  behaviour for `todo` bookkeeping.
- Verification: `tests/minimal-tools.test.ts` and `tests/codemode-compact.test.ts` after
  porting; visually confirm bash, read, edit, a fenced code block, an Odin block, an expanded
  thinking block, codemode output, and an image result.
- Risk: medium. This is the only phase that changes what the transcript looks like, and four of
  the five moved files touch rendering order, so migrate one renderer at a time.

### Phase 4 — One agents extension

- One loader registering `subagent`, `background_subagent`, and `multiagent`, on one runner and one viewer.
- Keep blocking `subagent` single and parallel modes: `skills/markdown-lint`, `skills/hardbound/references/delegation.md`, and `skills/usage-report` all depend on it. **Delete chain mode** (0 uses).
- Keep `background_subagent` as the default for work that can run while you continue.
- Keep `multiagent`; it is new and cheap once it shares the runner, but do not extend it until it earns use.
- Verification: `tests/subagent-display`, `tests/background-subagent`, `tests/multiagent`, `tests/multiagent-viewer`; one `/markdown-lint` run; one background start/status/stop cycle.
- Risk: medium, this is the largest single module. Move files before rewriting behavior.

### Phase 5 — One chrome extension

- One loader for header, footer, and theme: `banner`, `statusline`, `provider-status`, `fast`, `prompt-prefix`, `vscode-theme`.
- One footer state object replaces the string-keyed handoff where `statusline` reads
  `statuses.get("provider-status")` and `fast.ts` writes a third status.
- Trim `banner`: `quietStartup: "header"` already removes the loaded-resource listing; keep only
  the two-line identity row if it still earns its place.
- Verification: footer renders on a named and an unnamed session, limits appear for Codex and
  opencode-go, `/fast` toggles, VS Code terminal still picks its theme.
- Risk: low-medium, presentation only, but it is on screen constantly.

### Phase 6 — One sessions extension

- `consult`, `explain`, `export-md`, `rename`, `cleanup`, `exit-alias` behind one loader, all
  reading through `shared/session-log.ts` and rendering through `shared/session-display.ts`.
- `rename.ts` (437 lines) keeps only the proposal flow; use the built-in `setSessionName`, and
  reuse `shared/ui-ask.ts` instead of importing `askViaUI` across folders.
- `export-md` becomes a thin writer over the shared reader. Built-in `/export` covers HTML and
  JSONL, so it must not grow a second exporter.
- Verification: `tests/consult`, `tests/explain`, `tests/rename`; `/export-md` on a short session; `consult` self mode on this session.
- Risk: low. `consult` is days old and still cheap to move.

### Phase 7 — One classifier

- `tools/permissions/llm-classifier.ts` and `tools/py-explore/classifier.ts` ask the same
  question: does this call mutate state outside the sandbox? Give them one module in
  `shared/gate.ts` with one prompt builder, one fallback path, and one result type, with the
  py_explore regex deny-list kept as the cheap first stage.
- Verification: `tools/permissions/test.ts` (1,271 lines) is the safety net; run it and a
  `py_explore` write attempt.
- Risk: medium. Same completion plumbing, different prompts, so migrate prompts verbatim before
  tuning.

## 4. Decisions recorded

- **Keep blocking `subagent`.** Its 12 recent calls understate it: three skills invoke it by name.
- **Drop `subagent` chain mode** and the extra runner that supports it.
- **Delete `memory-store`, and the two idle npm packages too.** Neither implementation is in use; keeping the custom one only keeps 1,654 lines and a second model plumbing path in the repo. Reinstalling `pi-hermes-memory` later takes a minute if the need returns.
- **Keep `provider-status`.** Provider quota windows are not in pi's footer; only the plumbing around it is redundant.
- **Keep `/explain` and `/export-md`,** grouped under `sessions/`. Built-in `/name` and `/export` cover the trivial cases, not these.
- **No new extension gets created** by this plan. Every phase reduces the loader count.

## 5. Non-goals

- No changes to `tools/task-backgrounder` (1,277 lines, heavily used). Its size is the price of
  the work it does; revisit only if polling drops.
- No changes to `tools/web-use`, `tools/ask-question`, or `tools/self_compact` bodies beyond the
  shared-module moves.
- No changes to `shared/model-config.ts` beyond adding a purpose if a name is reused.
- No attempt to shrink `tools/permissions` prompts before Phase 7.

## 6. Verification

- `cd ~/dev/pi/extensions && bun test` after every phase.
- Restart pi after each phase: extension code loads at startup.
- Smoke list: one `py_explore`, one `web_use`, one background task start/status/stop, one
  `background_subagent`, one `ask_question`, one `self_compact`, one `/reload`.
- Re-run the 14-day tool-call scan after two weeks and compare against the table in section 1; the
  point of the exercise is to keep only what the numbers defend.
