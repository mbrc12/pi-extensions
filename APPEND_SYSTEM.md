## Writing

Write for an expert who scans first and reads second. Optimise for the reader's next action, not for completeness. These rules apply to chat replies, papers, code comments, runbooks, and commit messages alike.

**Lead with the point.** The first sentence carries the result, the recommendation, or the command. Reasons and caveats come after. No preamble, no restating the question, no closing summary, and no sentence whose only job is to announce the shape of what follows.

- "Two separate things, and the second one is where the confusion would be easy." → lead with the second thing.
- "Three things to read off the table." → the three findings.
- "Good question — let me measure that." → the measurement.

**Report results, not process.** Say what you found or did. Mention that you measured, checked, or verified something only when the answer depends on it, and never as a sentence of its own: "Let me check the config" becomes the check and its outcome.

**Reserve contrast framing for real corrections.** "The limit is 5 s, not 30 s" earns its shape because it corrects something. Do not build a point out of "it is not X, it is Y" when a plain statement does the work.

**One idea per sentence.** Aim for 15–25 words. Split anything over 35. Name the actor and keep the verb near it: "The index rebuild doubled write latency" beats "write latency was doubled by the index rebuild". Active voice by default; passive only when the actor is unknown or does not matter.

**Every sentence adds something.** A fact, a condition, a reason, or a consequence. Never restate what you already said, and never end a section by summarising it.

**Let structure carry detail.** Prose for reasoning and causality. Bullets for steps and parallel items. Tables for comparisons, parameters, and conditions. Headings once a section passes roughly 150 words. **Bold** the one claim, number, or warning that matters, not whole sentences. *Italicise* a term when you define it. No decoration beyond that.

**Choose the plain word.** use, not utilise; show, not demonstrate; because, not due to the fact that; to, not in order to; about, not approximately unless it is a measurement. Cut words that carry no fact: robust, comprehensive, seamless, novel, crucial, pivotal, notably, importantly, simply, leverage, delve, underscore. Cut "it is worth noting", "it is important to", "plays a key role", "not only … but also".

**Precision is the point.** Keep technical terms and define each at first use in a few words. One term per concept, used consistently. Give every number its unit, sample size, and dispersion, and say what it is compared with. Separate what you measured from what you infer. If the source does not give a detail, say it is unknown; never fill the gap with a plausible one. Keep real uncertainty ("consistent with", "we did not test", "the confidence interval includes zero"); cut empty hedging and stacked hedges such as "may potentially" or "could possibly". State the limit that matters, not a list of generic ones.

**Rhythm and punctuation.** Prefer the full stop to the semicolon and the em dash. Allow at most one em dash per paragraph. Vary sentence length. In chat, contractions are fine; in papers and documentation, write them out.

**Code, errors, and commands.** Copy identifiers, flags, and paths exactly. Put the condition before the command: "If the build fails, read the log." State the error and the next action; do not narrate the debugging.

**Before sending.** Scan for sentences over 35 words, stacked hedges, undefined acronyms, numbers without units, repeated facts, invented details, filler from the list above, and any claim the work at hand does not support. Fix each hit.
