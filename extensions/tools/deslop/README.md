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
| `/deslop --force` | on by default for the command: run one pass even when the text already scores well |

The preview header always states the score before and after, the band, and why the
text is unchanged when it is ("already scores 93.2, at or above target 90").

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
- **Structured (25%)** — does the document use the medium it has? Paragraph and section length, medium variety, missed lists, missed tables, missing bold, unitalicised terms, heading echoed in the first sentence, listicle stems, emoji, bold on everything.
- **Dense (15%)** — sentence-length variance, repeated openers, duplicated phrases, hedge density, sentences that start with nothing.

Variables are only reported, never scored: an LLM cannot be trusted to grade the
same text the same way twice.

## Using the medium

Formatting is part of the writing, not decoration, and the structured axis scores
it as content:

| Signal | What fires it |
|---|---|
| `medium_variety` | fewer than two formats in a document of 120+ words: headers, lists, tables, code, bold, italics |
| `list_opportunity` | a paragraph of three or more parallel or labelled statements and no bullet list anywhere |
| `table_opportunity` | a paragraph with four or more numbers compared and no table anywhere |
| `bold_missing` | 150+ words with nothing bolded |
| `italic_terms` | a term defined ("X is a …") and no italics |
| `bold_density` | bold on everything, above 9 per 100 words |
| `paragraph_length` | more sentences in one paragraph than the profile allows |

The rewriter is told the same rules, so the loop does not just reword, it
restructures: prose lists become bullets, prose comparisons become a table, the
one number that matters gets bold, a defined term gets italics.

Measured on `wall.md` → `mixed.md`, the same facts with and without the medium:
**74 C → 96 A**. Rewriting `wall.md` in one pass reaches **98**.

## Global audit

Sentence rules cannot see the document. Before any rewriting, one model call
reads the **spine** — heading, first sentence, last sentence, numbers, length for
every section — and answers twelve document-level rules:

`promise_fulfilment` · `answer_first` · `thesis_drift` · `use_before_definition` ·
`given_new_flow` · `redundancy` · `underived_number` · `proportion` ·
`heading_accuracy` · `dependency_order` · `one_sentence` · `stated_limits`

Sources: higher-order-concern revision practice (Writing Commons, Purdue OWL),
reverse outlining, Gopen & Swan's topic and stress positions, and the two gaps
CLEAR-100 names in its own checker.

How it stays honest:

- The audit is **not scored**. It returns findings; the deterministic scorer
  judges whatever edit the findings produce. No LLM number enters the total.
- Every finding is validated against the spine: unknown rule, unknown section id,
  or severity outside 1–3 is dropped. Answers that are prose rather than JSON are
  discarded and retried once.
- Only `reorder`, `merge`, and `delete` are applied mechanically, by section id.
  A reorder must name every section exactly once, and an order identical to the
  current one is rejected. A delete must name the section that supersedes it.
- Structural edits are checked with the same fact diff as a rewrite: no number,
  name, or link may disappear, and a deletion that removes more than 30% of the
  words is refused.
- Measured pair similarity is passed to the auditor as an observation, never
  acted on directly. Section-level redundancy detection by word overlap alone is
  not reliable; the model decides, the hints help it look.
- Findings that need prose (`rewrite_opening`, `rename_heading`, `split`,
  `expand`) become instructions in the rewrite prompt rather than edits.

Cost: one call per document at 150+ words with two or more sections. Disable with
`audit: false` on the tool or `--no-audit` on the command.

## Guards

A rewrite is rejected unless all of these hold:

- every `[[n]]` placeholder survives exactly once (code, links, math, tables, paths, flags)
- no number, name, or link disappears, and no number appears that was not there
- word count stays between 70% and 115% of the **original**, not the previous pass
- the rewrite is not empty

Rejected passes are never applied, even when their score rose. The score can rise
because content disappeared.

## Calibration

The total is not a hand-picked curve. Four mechanisms make it strict, each fixed
by a test:

- **Density, not presence.** A rule costs 35% of its weight when it appears at
  all, and the rest ramps with tells per 100 words. Eighteen AI words in 300 cost
  more than one in 2,000.
- **Applicability.** A rule only carries weight when the text could break it.
  Heading rules are skipped without headings, rhythm rules without five
  sentences, bullet rules under 300 words.
- **Opportunity.** The denominator scales with `words / 250`, floored at 20%.
  Three tells in seventeen words means every opportunity was used.
- **Severity caps.** A content defect at 80% or more caps the total at 79; a
  strong tell or a wall of prose caps it at 74. Only curated content rules can
  cap: a missed table or missing bold is an opportunity, not a failure. Averaging
  ten rules per axis would otherwise let one serious defect disappear.

The curve is fitted by least squares over seven anchors, residual 2.7% RMS:

| Anchor | Score |
|---|---|
| tiny slop, 17 words | 25 |
| `bad.md` | 35 |
| `links.md` | 50 |
| `wall.md` (clean prose, no formatting) | 70 |
| `ok.md` | 82 |
| `good.md` | 93 |
| `mixed.md` (same facts, full medium) | 95 |

The fitted exponent lands on 1.0, so the curve is linear: `100 · max(0, 1 −
1.65·x)`. Refit (`CURVE` in `score.ts`) if the rule pack changes; do not tune it
by eye.

The reading grade is Flesch–Kincaid, which rewards short sentences more than
simple ideas. A technical note with 11-word sentences reads as grade 4 even when
the vocabulary is ordinary, so the metric is reported with FK and the mean
sentence length beside it, never on its own.

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

## Performance

- **Sections are rewritten in parallel**, four at a time by default (ceiling six),
  with results reassembled in document order.
- **Clean sections are not called at all.** A section with no findings is returned
  untouched; on a five-section document that is usually one or two calls fewer.
- **Retries are waves, not queues.** Every section that failed goes back out at
  the same time with the criterion it broke named in the prompt, up to three
  attempts. A section is only left alone after that, and the report says why
  ("section 2: dropped_fact after 3 attempts").
- **The system prompt is cached** (`cacheRetention: "short"`), since it is
  identical across sections in a pass, and `maxTokens` is sized to the section.
- **One audit call per document**, re-run never.

Client-side parallelism only helps if the provider allows it. Measured on
`opencode-go`: four requests dispatched in the same millisecond came back over the
following five seconds, so the gateway appears to serialise. On a provider that
does not, the same code scales.

## Knobs

| Setting | Default | Notes |
|---|---|---|
| `target` | 90 | stop when the score reaches it |
| `max_passes` | 3 | also stops when a pass gains less than 2 points |
| `profile` | `docs` for files, `general` for text | sentence and grade caps |
| `voice` | — | a writing sample sets the sentence and grade targets numerically |
| `DESLOP_DEBUG=1` | off | append prompts and guard verdicts to `/tmp/deslop-debug.log` |

The rewriter model comes from the `deslopRewrite` purpose in
`extensions/model-config.json`.

## Limits

- Scores writing patterns, not truth. It cannot tell whether a claim is correct.
- A saturated fixture (300 words of pure slop) gains 20–25 points per run and
  lands around 85–90. Weak source material constrains the ceiling, not the loop.
- Literal-word substitution is the failure mode of a cheap rewriter: the prompt
  forbids mechanical swaps, but an awkward phrase can still survive.

## Tests

```sh
cd ~/dev/pi/extensions && bun test tools/deslop
```

The scorer, guard, mask, chunker, and policy loader are dependency-free, so they
test without a model or a network.
