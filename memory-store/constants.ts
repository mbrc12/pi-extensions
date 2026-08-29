/**
 * Constants for the memory-store extension.
 *
 * Single source of truth for prompts, correction patterns, and defaults.
 * Kept intentionally small — this extension replaces the markdown-file +
 * subprocess machinery of pi-hermes-memory with one SQLite file and
 * in-process model calls.
 */

// ─── Paths ───

/** Default directory for the SQLite database (override via config "dbDir"). */
export const DEFAULT_DB_DIR = "~/.pi/agent/memory-store";
export const DB_FILE = "memories.db";

// ─── Defaults ───

/** Model used for review/correction/flush/rerank LLM calls. */
export const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";

/** Background review: fire after this many turns since the last review. */
export const DEFAULT_NUDGE_INTERVAL = 10;

/** Background review: fire after this many tool calls since the last review. */
export const DEFAULT_NUDGE_TOOL_CALLS = 15;

/** Background review: minimum user turns before any review can fire. */
export const DEFAULT_MIN_USER_TURNS = 3;

/** Background review: minimum message parts in the branch before firing. */
export const DEFAULT_MIN_PARTS = 4;

/** Session flush: minimum user turns before a flush writes anything. */
export const DEFAULT_FLUSH_MIN_TURNS = 6;

/** FTS5 candidate pool size before LLM rerank. */
export const DEFAULT_RERANK_CANDIDATES = 15;

/** Default tool result limit for memory_search. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** LLM call timeouts. */
export const REVIEW_TIMEOUT_MS = 120_000;
export const FLUSH_TIMEOUT_MS = 30_000;
export const RERANK_TIMEOUT_MS = 30_000;

// ─── SQLite pragmas ───

export const WAL_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
];

// ─── Background review prompt ───

/**
 * The model replies with the DIRECT_OPS_SCHEMA JSON shape. No prose allowed,
 * which keeps output tokens to the minimum.
 */
export const REVIEW_SYSTEM_PROMPT = `You review coding conversations and extract durable memories worth saving across sessions.

Save these aspects:
- User persona, preferences, expectations about how the agent should behave, work style
- What failed, user corrections, insights, conventions, tool quirks
- Environment facts about the user's machine or setup
- **Corrections**: if the user corrected the agent ("use X instead of Y", "that's not what I meant", "don't do that"), capture the corrected preference or fact. If it contradicts an existing blurb, use a "replace" operation to update it in place.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.
Only save genuinely durable facts.

Respond with JSON only, in this exact shape:
{
  "operations": [
    {"action": "add", "content": "entry text"}
  ]
}
- action: "add" | "remove" | "replace"
- content: required for add/replace (the blurb text)
- old_text: required for remove/replace (substring match on an existing entry)
- If a new fact contradicts an existing entry, use "replace" with the existing entry's text as old_text.
- If nothing is worth saving, return {"operations": []}.`;

// ─── Session flush prompt ───

export const FLUSH_SYSTEM_PROMPT = `The session is ending and about to lose context. Save anything worth remembering from this conversation — prioritize user preferences, corrections, and recurring patterns over task-specific details.

Respond with JSON only, in this exact shape:
{
  "operations": [
    {"action": "add", "content": "entry text"}
  ]
}
- action: "add" | "remove" | "replace"
- content: required for add/replace (the blurb text)
- old_text: required for remove/replace (substring match on an existing entry)
- If nothing is worth saving, return {"operations": []}.`;

// ─── Rerank prompt (minimal output: ids only) ───

/**
 * The model receives the query and a JSON array of candidate blurbs, and must
 * reply with a JSON array of ids only, ranked best first. No prose, no
 * re-printed blurbs — that is the entire output.
 */
export const RERANK_SYSTEM_PROMPT = `You select memory blurbs that directly help answer a search query.

You will receive:
- The search query
- A JSON array of candidate blurbs: [{"id": 1, "content": "..."}]

Be strict: keyword overlap alone is not enough. Do not return entries merely
because they share a generic word, a year, a model name, or a project-adjacent
term. If the store has no direct answer, return an empty array.

Return a JSON array of the ids most relevant to the query, ranked best first.
Rules:
- Return at most the number of ids requested.
- Only include blurbs genuinely relevant to the query.
- Output ONLY a JSON array of numbers, e.g. [7, 3, 12]. No other text, no explanations.
- If none are relevant, return [].`;
