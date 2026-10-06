---
name: ask-question
description: Prefer the ask_question tool whenever you need a decision, preference, or clarification from the user instead of asking them to reply in plain text. Supports single-choice, multiple-choice, and free-form text questions with an optional "Type something" fallback.
license: MIT
---

# ask-question

This skill documents how and when to use the **`ask_question`** tool. You already have this tool available; this skill is the quick reference for using it well.

## Core rule

**`ask_question` is the PREFERRED way to ask the user anything that needs a decision, preference, or clarification.**

Do NOT write a paragraph ending in "Reply with X or Y." Instead, call `ask_question` so the user gets a real interactive UI: arrow keys to navigate, `Space`/`Enter` to select, `Esc` to cancel.

Only fall back to a plain-text question if `ask_question` is unavailable (e.g. in print or JSON mode where its result reports it cannot run).

## When to use it

- You need the user to choose between two or more well-defined options
- You need a preference (library, style, naming, scope)
- You need a yes/no/other decision with more than a binary answer
- You need clarification before a destructive or expensive action
- You need multiple preferences at once (use `multiple` mode)

## When NOT to use it

- The answer is already in the codebase, docs, or session history — look it up instead.
- The user gave an explicit instruction with no ambiguity — just do it.
- The question is rhetorical or explanatory — write prose instead.
- You're in non-interactive mode and the tool already told you to fall back — then ask in plain text.

## Choosing a selection mode

| Mode | Use when | Returns |
|------|----------|---------|
| `single` (default) | The user must pick exactly one option | One string |
| `multiple` | More than one option may apply | One or more strings |
| `text` | The answer is open-ended or free-form | One string |

Pick the most constrained mode that still fits. `single` is almost always better than `text` when you can list realistic choices.

## Writing good options

- Provide **2–8** options. Fewer than 2 is invalid for `single`/`multiple`; more than 8 overwhelms.
- Make options **well-distinguished and non-overlapping**. Don't offer "Fast" and "Quick" side by side.
- Keep labels **short** (a few words). Put longer rationale in the `description` field.
- Order options from most-likely to least-likely, or in a natural progression.
- Always include the realistic "none of the above" path as a real option rather than relying on `allow_other` — but keep `allow_other: true` (the default) so the user can still type something bespoke.

## Parameter reference

```
ask_question({
  question: string,            // required — a complete question
  selection_mode: "single" | "multiple" | "text",  // default "single"
  options: [{ label, description? }],               // required for single/multiple
  allow_other?: boolean,        // default true — adds "Type something..."
  min_select?: integer,         // multiple only, default 1
  max_select?: integer,         // multiple only, 0 = no limit
  placeholder?: string,         // text only
})
```

## Examples

### Single choice — pick one library

```json
{
  "question": "Which database should I use for the new service?",
  "selection_mode": "single",
  "options": [
    { "label": "PostgreSQL", "description": "Relational, mature, great for complex queries" },
    { "label": "SQLite", "description": "Embedded, zero-config, good for local/dev" },
    { "label": "MongoDB", "description": "Document store, flexible schema" }
  ]
}
```

### Multiple choice — pick any number of features

```json
{
  "question": "Which features should the new CLI include? Pick all that apply.",
  "selection_mode": "multiple",
  "min_select": 1,
  "options": [
    { "label": "Watch mode", "description": "Re-run on file changes" },
    { "label": "Verbose logging", "description": "Detailed stdout output" },
    { "label": "Dry-run", "description": "Print actions without executing" },
    { "label": "Config file", "description": "Read options from .mytoolrc" }
  ]
}
```

### Free text — open-ended

```json
{
  "question": "What should we name the new API endpoint?",
  "selection_mode": "text",
  "placeholder": "/api/v1/..."
}
```

## Interpreting the result

The tool returns text describing the user's answer plus structured `details`. Handle the three cases:

- **Answered**: `details.cancelled === false`, `details.answers` is a non-empty array. Use `answers[0]` for `single`/`text`, iterate for `multiple`.
- **Confirms your options**: matching `details.options[index]` gives the chosen label; answers not in `details.options` were custom (the user typed them) — `details.got_custom` flags this.
- **Cancelled**: `details.cancelled === true`. Do NOT guess an answer. Either ask a narrower question, or proceed with a safe default and tell the user you assumed one. If genuinely blocked, ask in plain text.

## Multiple questions

`ask_question` asks one question at a time. If you need several decisions in a row, ask them as separate calls in the same turn (the tool runs sequentially from the user's perspective). Keep the total number of round-trips small — if you need more than ~3, list the remaining decisions in one wrap-up `text` question at the end.

## Style guide

- Phrase `question` as a **complete sentence**, e.g. "Which database should I use for the new service?" not "Database?".
- Don't pre-answer the question ("Should I use Postgres?") — that biases the user toward yes/no. Offer Postgres as an option instead.
- If the decision is reversible and low-stakes, just pick a sensible default and tell the user — only ask when the answer genuinely changes what you'll do.