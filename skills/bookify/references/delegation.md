# Delegating chapters to subagents

A 500-page book is 8–10 chapters; one agent doing them serially is slow and loses context. One
worker per chapter, in parallel, then assemble centrally. This is the single biggest speedup,
and the single biggest source of mess if the brief is loose.

## Division of labour

| role | does | never does |
| --- | --- | --- |
| main agent | page ranges, schema, assembly, cross-chapter refs, verification | transcribe whole chapters |
| worker (per chapter) | transcribe its page range into one XML file, crop its figures, validate it | touch other chapters, build files, or book.xml |

One chapter, one file, one owner. Two workers writing the same file will interleave and corrupt
it — if a chapter is too big for one worker, split by **equation range** and have them run
sequentially.

## Brief template

Copy `agents/chapter-worker.md` and fill the blanks. Non-negotiable contents:

- Absolute PDF path, chapter title, exact page range, output path.
- "Read the schema and an exemplar chapter first."
- "Transcribe from page images; the OCR dump is a locator only."
- Id conventions and numbering conventions (`n=` is the printed number).
- Crop rules: 300 dpi, tight, inspect, re-crop if labels clip.
- Cross-refs `soft="yes"` with `text=` fallback.
- The validation command that must exit 0.
- The explicit "do not touch" list.
- Report counts: sections, equations, figures, problems.

## What goes wrong, and the countermeasure

| failure | countermeasure in the brief |
| --- | --- |
| copies OCR verbatim | "render at 200 dpi and read the image" |
| skips a 40-page stretch | "every numbered equation in the range must appear; report the list" |
| invents numeric answers to problems | "one-line reasoning hints, no numbers you did not read" |
| writes 200 KB then loses it | "work in chunks of 3–5 pages, append and re-validate" |
| touches shared files | explicit do-not-touch list, including build.py and other chapters |
| duplicate ids | the assembler runs `normalize.py ids` regardless |
| silent bad maths | ask for a browser check: `.katex-error` count must be 0 |

## Assembling

After each worker reports:

```bash
python3 scripts/bookify.py check book/chNN.xml     # must say "valid"
python3 scripts/check.py book/chNN.xml --text /tmp/book/text.txt --range LO,HI --chapter N
python3 scripts/normalize.py ids book/
python3 scripts/bookify.py build book/book.xml --stats
python3 scripts/verify_html.py book/*.html
```

Dispatch a follow-up worker only with a precise list — "equations 28–50 and 56–76 are missing,
plus the problems section on pages 393–396" beats "chapter 9 is incomplete".

## When a worker stalls

A worker that has taken more than ~30 minutes with few tool calls is usually stuck on a huge
image or a failing script. Stop it, keep whatever it wrote (the file is durable), inspect the
last section it reached, and relaunch with a narrower range and an explicit starting point.

## Slack for the main agent

While workers run, the main agent should:

- write `book.xml` and the real `index` shell,
- implement the reader UI and test it on a two-chapter stub,
- prepare verification scripts,
- not edit chapter files (ownership).

That keeps wall-clock time proportional to the longest chapter rather than the sum of all.
