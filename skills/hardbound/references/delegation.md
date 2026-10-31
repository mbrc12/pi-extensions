# Delegating chapters to subagents

A 500-page book is 8–10 chapters. One agent doing them serially is slow and loses context. One
worker per chapter, in parallel, then assemble centrally. This is the biggest speedup, and the
biggest source of mess if the brief is loose.

## Division of labour

| role | does | never does |
| --- | --- | --- |
| main agent | `book.toml`, page ranges, anchor conventions, cross-chapter links, final check, build | transcribe whole chapters |
| worker (per chapter) | one `content/NN-slug.md`, its crops, its own errors fixed | touch other chapters, `book.toml`, `out/` |

One chapter, one file, one owner. Two workers writing the same file interleave and corrupt it. If
a chapter is too big for one worker, split by **equation range** and run the halves sequentially.

## Before dispatch

1. Write `book.toml` with every chapter entry, so every slug exists from the start.
2. Create each `content/NN-slug.md` as a stub with its `# Title {#chN}` heading.
   `hardbound check` then has a complete book to validate.
3. Fix the id conventions (below) so parallel workers do not invent conflicting names.
4. Point workers at a finished exemplar chapter, not at prose instructions alone.

## Brief template

Copy `agents/chapter-worker.md` and fill the blanks. It must contain:

- absolute PDF path, chapter title, exact page range, output path;
- "read the dialect reference and the exemplar chapter first";
- "transcribe from page images; the OCR dump is a locator only";
- anchor and numbering conventions (`n=` is the printed number);
- crop rules: 300 dpi, tight, inspect, re-crop if labels clip;
- cross-reference syntax: `[](#anchor)` in this chapter, `[](slug!anchor)` across chapters;
- the validation command and the fact that other chapters' errors are not theirs to fix;
- the explicit do-not-touch list;
- report counts: sections, numbered equations, figures, problems, footnotes.

## Anchor conventions

Give every worker the same table, derived from the book:

| object | id | number |
| --- | --- | --- |
| chapter | `ch<N>` on the `h1` | `n="<N>"` if printed |
| section | `s<N>-<k>` | `n="<N>.<k>"` |
| equation | `eq-<N>-<k>` | `n="<N>-<k>"` |
| figure | `fig-<N>-<k>` | `n="<N>.<k>"` |
| table | `table-<N>-<k>` | `n="<N>.<k>"` |
| problem | `prob-<N>-<k>` | `n="<N>-<k>"` |
| demo heading | `demo-<N>` | `.unnumbered .demo` |

Ids only need to be unique inside a chapter, so the chapter number in every id is a convention, not
a requirement. Keep it anyway: it makes cross-chapter links easy to write by hand and easy to
review.

## Assembling

After each worker reports:

```bash
hardbound check book                    # whole book; check the lines in their file
hardbound check book --strict           # only when the book is meant to be finished
hardbound build book -o book/out
```

While several chapters are still drafts, `check` will report their errors and unresolved
cross-references. Use `--lenient` for the intermediate state if you need a build, but never ship
it. Send a follow-up worker only with a precise list: "equations 28–50 and 56–76 are missing, plus
the problems section on pages 393–396" beats "chapter 9 is incomplete".

## What goes wrong, and the countermeasure

| failure | countermeasure in the brief |
| --- | --- |
| copies OCR verbatim | "render at 200 dpi and read the image" |
| skips a 40-page stretch | "every printed equation in the range must appear; report the list" |
| invents numeric answers | "reasoning hints, no numbers you did not read" |
| writes 200 KB then loses it | "work in 3–5 page chunks, append, re-check" |
| touches shared files | explicit do-not-touch list |
| invents anchors | the id table, plus "run `hardbound check` and fix errors in your file" |
| hand-writes link labels | "empty link text; the target supplies the number" |
| wrong figure captions | "the caption is a nested `::: caption` block" |
| unclosed containers | "re-check after every chunk; a missing `:::` swallows the rest of the file" |
| silent bad maths | ask for the browser counts: `.katex-error` must be 0 |

## When a worker stalls

A worker with few tool calls after ~30 minutes is usually stuck on a huge page image or a failing
command. Stop it, keep what it wrote (the file is durable), inspect the last heading it reached,
and relaunch with a narrower page range and an explicit starting point.

## Slack for the main agent

While workers run, the main agent should:

- write `book.toml` and the cover metadata,
- choose or write `theme.toml`,
- prepare cross-chapter links and generated indexes,
- build a two-chapter stub to test the reader,
- not edit chapter files (ownership).

Wall-clock time then tracks the longest chapter, not the sum of all chapters.
