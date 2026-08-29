# memory-store

Persistent memory for the pi coding agent, backed by a single SQLite file.

Replaces the markdown-file + subprocess machinery of pi-hermes-memory with:

- **One SQLite database** (`node:sqlite`, WAL mode, `busy_timeout`) — SQLite is
  the lock, so concurrent pi sessions serialize safely. No file fingerprints,
  no temp-file rename dance, no recovery artifacts.
- **In-process LLM calls only** — every model call goes through pi's
  `modelRegistry` via `completeSimple()`. No child `pi` processes, so no
  auth-adapter stripping, no fork storms, no child-boot timeouts.
- **FTS5 + LLM rerank** — keyword search finds candidates, one small LLM call
  reranks them. The rerank output is ids only, so output tokens stay minimal.
- **No system-prompt injection** — standing context is AGENTS.md's job.
  Memory is retrieved on demand with `memory_search`.

## Layout

| Path | Purpose |
|---|---|
| `~/.pi/agent/extensions/memory-store/` | Extension source (auto-discovered, hot-reloadable) |
| `~/.pi/agent/memory-store/memories.db` | Instance data: the SQLite store (created on first run) |
| `~/.pi/agent/memory-store/config.json` | Optional instance config (see below) |

## Tools

| Tool | What it does |
|---|---|
| `memory_search(query, limit?)` | FTS5 top candidates → LLM rerank (ids only) → ranked blurbs. Bumps `last_used_at` on hits |
| `memory_add(content, category?)` | Save a blurb. Exact duplicates are skipped (`UNIQUE(content)`) |
| `memory_remove(old_text)` | Delete blurbs containing the text (case-insensitive substring) |
| `memory_update(old_text, new_content)` | Replace blurbs containing `old_text` with `new_content` |

## Commands

| Command | What it does |
|---|---|
| `/memory-search <query>` | Search and show ranked blurbs in the TUI |
| `/memory-list [category]` | List all blurbs, optionally filtered by category |
| `/memory-stats` | Counts by category and source, plus automation outcomes |
| `/memory-health` | Shows recent background-review, flush, and rerank-fallback outcomes |

## Config

All settings optional. Create `~/.pi/agent/memory-store/config.json`:

```json
{
  "model": "opencode-go/deepseek-v4-flash",
  "fallbackModels": ["openai-codex/gpt-5.6-luna"],
  "dbDir": "~/.pi/agent/memory-store",
  "reviewEnabled": true,
  "flushOnCompact": true,
  "flushOnShutdown": true,
  "nudgeInterval": 10,
  "nudgeToolCalls": 15,
  "minUserTurns": 3,
  "minParts": 4,
  "flushMinTurns": 6,
  "rerankCandidates": 15,
  "searchLimit": 5
}
```

`model` can be any model in your pi catalog (`provider/model-id`). It is used
for background review, session flush, and rerank. `fallbackModels` are tried in
order after a provider, authentication, or empty-response failure. The session's
active model is tried last when it is different from those models.

## When memory gets written

The extension learns from pi-hermes-memory's learning loop (ported from its
source), minus the failure-prone storage layer. Corrections are handled by the
AI inside the background review — there is no regex correction detector.

| Trigger | Rule | Cost |
|---|---|---|
| Background review | `turn_end`: `turnsSinceReview ≥ nudgeInterval` **or** `toolCallsSinceReview ≥ nudgeToolCalls`, and `userTurns ≥ minUserTurns`, and branch has `≥ minParts` messages. The review prompt explicitly asks the AI to capture user corrections and `replace` contradicting blurbs | One flash-model call returning JSON ops |
| Session flush | `session_before_compact` (30s) and `session_shutdown` (10s, awaited so writes land before DB close); needs `≥ flushMinTurns` user turns | One call |
| Explicit tools | `memory_add` / `memory_update` / `memory_remove` from the agent | None |

All LLM flows reply with the same minimal JSON shape:

```json
{ "operations": [{ "action": "add" | "remove" | "replace", "content": "...", "old_text": "..." }] }
```

## Retrieval design

1. **FTS5 keyword search** (`porter unicode61` tokenizer, BM25 ranking) pulls
   up to `rerankCandidates` (15) candidates. User input is quoted token-by-token
   so FTS syntax can't be injected.
2. **LLM rerank** receives the query + candidates as JSON `{id, content}` and
   replies with a JSON array of ids only — no prose, no re-printed blurbs.
3. **Conservative fallback**: if reranking fails (no model, no auth, provider
   error, or unparseable response), search returns only blurbs containing every
   query token. It may return no result, but it never injects a weak broad-FTS
   match after a failed rerank.

The reranker is instructed to return an empty list when no blurb directly helps
with the query. Keyword overlap alone is not enough.

## TUI behavior

Tool rows render compactly by default and expand on `ctrl+o` (`app.tools.expand`):

- `memory_search` shows `✓ N memories (ctrl+o to expand)` collapsed; the full
  blurb list (id + category + content) when expanded.
- `memory_add` / `memory_remove` / `memory_update` show a one-line outcome
  (saved / removed / replaced).

## Design decisions

- **No consolidation.** The store is unbounded; the system prompt never gets
  the whole store injected, and `memory_search` costs stay flat regardless of
  store size. The "memory full → rewrite the file under lock" failure class is
  gone entirely.
- **`last_used_at` aging.** Search hits bump the timestamp, so future pruning
  or compaction can be an ordinary SQL `DELETE`/`UPDATE` in one transaction —
  no markdown rewrite.
- **Visible automation outcomes.** Compact audit events record whether a
  background review or flush updated memory, found no change, or failed.
  `/memory-health` exposes the recent events without storing conversation text.
- **Exact-text dedup only.** Blurbs with the same text are skipped; near-
  duplicates are the model's job (review/correction prompts can emit
  `replace`).

## Development

```bash
# DB + FTS5 logic (creates/uses ~/.pi/agent/memory-store/memories.db)
node test-db.ts

# Extension factory: tools/commands/events register correctly (uses pi's own
# jiti loader with the same aliases pi applies at runtime)
node test-load.ts

# Smoke test in a real pi session
pi -p --no-session "Reply with exactly: OK"
```
