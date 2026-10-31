---
description: Summarise your last answer, or given text, as a scannable brief
argument-hint: "[text or file path]"
---
Summarise the source below for fast reading. Return only the summary.

Source: ${@:-your most recent answer in this conversation}

Do it in this order:

1. **Never start with a bullet.** The first line is one plain sentence, no bold, stating the conclusion or the main change. If the source has no conclusion, state its main claim.
2. Then bullets, one fact per bullet, most important first. Every bullet earns its place.
3. Use a table when the source compares options, parameters, or results.
4. Use a numbered list when the source is a sequence of events or steps.
5. **Bold** the numbers, names, and decisions that matter.

Rules:

- Keep every fact, figure, and caveat. Drop only repetition, hedging, and examples that carry nothing.
- Copy identifiers, code, and paths exactly.
- Target 150 words, or about a quarter of the source if it is longer than 600 words.
- No preamble, no "this summary covers", no restating the request.
