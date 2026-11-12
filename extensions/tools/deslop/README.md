# deslop

Rewrites AI-shaped prose into something a person can read. The rewrite runs on a
model call of its own, inside this extension, so the caller's context only ever
sees the result.

## Why it exists

Asking the main agent to "rewrite this more clearly" puts the whole draft, the
critique, and the rewrite into the reasoning thread. `deslop` keeps that work out
of the context and replaces opinion with a number:

```
measure → rewrite failing sections → guard fidelity → re-measure → keep the better text
```

The score is deterministic, so the model never decides whether it improved
anything. A pass is kept only when the number rises and no fact was lost.

## Use: the tool

```jsonc
{ "path": "docs/post.md" }                          // returns the rewritten text
{ "path": "docs/post.md", "in_place": true }        // writes it back, returns the report only
{ "text": "…" }                                     // ad-hoc text
{ "path": "docs/post.md", "score_only": true }      // measure, no model call
{ "path": "docs/post.md", "target": 90, "max_passes": 2, "profile": "technical" }
```

The tool row updates while it runs: score bar, current pass, sections done, and
any guard rejection. Expanded output lists the remaining rules by penalty.

`score_only` is the cheap first move: if the text already scores at or above the
target, no rewrite is attempted and no model call is made.

## Use: the command

| Command | Effect |
|---|---|
| `/deslop` | rewrite the last assistant answer, show it in a scrollable preview |
| `/deslop --file docs/post.md` | rewrite a file |
| `/deslop -e` | put the rewrite straight into the editor |
| `/deslop -s out.md` | save the rewrite |
| `/deslop --score` | score only, no rewrite |

Preview keys: `j`/`k` scroll, `g`/`G` top or bottom, `space`/`b` page, `e` editor,
`s` save, `q` close. `esc` during the rewrite aborts it.

In print or JSON mode the command writes the text to stdout and the report to
stderr.

## The rule pack

One file, `rules.ts`, is the source of truth for both halves. A rule carries the
detector the scorer uses and the instruction the rewriter receives, so the two
cannot drift apart.

- **Plain (30%)** — sentence length, reading grade, nominalizations, passive voice, stacked hedges, filler openers.
- **Human (30%)** — the five strongest tells first (not X but Y, one-line closer, deep saying, staged run-up, arguing with no one), then AI vocabulary with a concrete substitution table, inflated significance, borrowed authority, sales talk, chat residue.
- **Structured (25%)** — paragraph and section length, bullet shortfall, heading echoed in the first sentence, listicle stems, emoji, bold as decoration.
- **Dense (15%)** — sentence-length variance, repeated openers, duplicated phrases, hedge density, sentences that start with nothing.

Variables are only reported, never scored: an LLM cannot be trusted to grade the
same text the same way twice.

## Guards

A rewrite is rejected unless all of these hold:

- every `[[n]]` placeholder survives exactly once (code, links, math, tables, paths, flags)
- no number, name, or link disappears, and no number appears that was not there
- word count stays between 70% and 115% of the **original**, not the previous pass
- the rewrite is not empty

Rejected passes are never applied, even when their score rose. The score can rise
because content disappeared.

When a pass is rejected for length, the model gets one retry that names what it
broke ("your previous attempt was 64% of the original length"), which lands far
more often than a silent rejection.

## House rules from AGENTS.md

`policy.ts` reads `AGENTS.md` from the working directory upward plus the pi agent
directory. Only lines that match a known concern are lifted: bullets, links,
LaTeX, contractions, punctuation limits, plain-language demands. Instructions
addressed to an agent ("load the `latex-writing` skill") are filtered out.

Links are the hard case, so they are enforced twice: the whole inline link is a
protected span, and the guard fails any rewrite that drops one.

## Knobs

| Setting | Default | Notes |
|---|---|---|
| `target` | 80 | stop when the score reaches it |
| `max_passes` | 3 | also stops when a pass gains less than 2 points |
| `profile` | `docs` for files, `general` for text | sentence and grade caps |
| `voice` | — | a writing sample sets the sentence and grade targets numerically |
| `DESLOP_DEBUG=1` | off | append prompts and guard verdicts to `/tmp/deslop-debug.log` |

The rewriter model comes from the `deslopRewrite` purpose in
`extensions/model-config.json`.

## Limits

- Scores writing patterns, not truth. It cannot tell whether a claim is correct.
- A saturated fixture (300 words of pure slop) gains 20–25 points per run and
  lands around 85. Weak source material constrains the ceiling.
- Literal-word substitution is the failure mode of a cheap rewriter: the prompt
  forbids mechanical swaps, but an awkward phrase can still survive.

## Tests

```sh
cd ~/dev/pi/extensions && bun test tools/deslop
```

The scorer, guard, mask, chunker, and policy loader are dependency-free, so they
test without a model or a network.
