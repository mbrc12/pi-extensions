---
name: incremental-learning
description: Teach through a persistent concept dependency graph, adding one small idea from established prerequisites at a time. Use for interactive tutoring, learning roadmaps, tutorial documents, conceptual checkpoints, or interleaving theory with simulations, experiments, and design. Distinguish demonstrated understanding from assumed familiarity and adapt the next step to the learner's reasoning.
---

# A dependency-driven approach to learning

## Start or resume a learning session

- Read the learner's existing syllabus, concept map, and relevant handoff notes before teaching. Use their established record rather than creating a competing tracking system.
- Identify the current goal, demonstrated prerequisites, unresolved corrections, and learning frontier.
- If the starting point is unclear, ask a focused familiarity question; do not restart established material.
- If no record exists for a multi-session topic, agree on a learner-owned location. Simple Markdown files such as `docs/learning-map.md` and `docs/syllabus.md` are sufficient.
- Do not store learner-specific state in this skill directory.
- For a substantial new lesson, propose its dependency-based structure before drafting it. For an ongoing lesson, teach the next small step and check the learner's reasoning.
- Follow the approach below. Do not turn it into a rigid script or require needless confirmation after every sentence.


- **Purpose:** Help an agent teach a learner through small, connected steps that build usable understanding rather than familiarity with terminology.
- **Core rule:** Start from what the learner actually understands. Add one idea that follows directly from established prerequisites, check the reasoning, and update the learning map.
- **Scope:** This approach applies across subjects. Adapt the examples, notation, tools, and evidence standards to the learner and domain.

## 1. Establish the learner's starting point

- Ask about unfamiliar prerequisites before relying on them.
- Do not equate mathematical sophistication with physical, practical, or domain-specific intuition.
- Distinguish knowing a method abstractly from understanding what its quantities mean in the current problem.
- Use the learner's own explanations and previous work as evidence. Avoid repeatedly testing knowledge already demonstrated unless a new difficulty gives a reason.
- Treat background documents and self-reported familiarity as useful starting information, not proof of mastery of every detail.
- Do not infer understanding merely because the learner has read a document or encountered a term.

## 2. Maintain a small concept dependency graph

- Represent concepts as specific claims, distinctions, or capabilities—not broad labels such as “statistics” or “engineering.”
- Draw an edge from each prerequisite to the idea that depends on it.
- Keep the active graph local to the current learning goal. A complete map of the discipline is not required before teaching begins.
- Label the state of each node:
  - **Background:** Reported familiarity or a reasonable assumption that has not yet been checked in context.
  - **Demonstrated:** Supported by an explanation or application, with the evidence recorded.
  - **Needs clarification:** Partially understood, ambiguous, or associated with a misconception.
  - **Planned:** Not yet taught or checked.
- Define the **learning frontier** as the next planned idea whose prerequisites are established.
- Add one immediate extension at a time. If a proposed step needs another unfamiliar concept, split it.
- After a meaningful checkpoint, record what the learner established, any correction, and what remains untested.
- A correct answer after a hint or explanation is progress, but not evidence of independent recall. Record that distinction without turning every exchange into formal grading.
- Treat later successful use as stronger evidence of retention than a single initial answer.

## 3. Plan the structure before writing a substantial lesson

- Start with the learner's objective and current frontier, not the textbook's table of contents.
- Propose a short sequence of questions, each answering a concrete gap.
- For each section, identify:
  - The question it answers.
  - The already-established ideas it uses.
  - The single new result or distinction it adds.
  - A checkpoint or practical task that tests it.
- Identify what is deliberately deferred.
- For a substantial new document or project, agree on the structure before expanding it. Do not demand a planning ceremony for a small clarification.
- Revise the plan when the learner identifies a better route or wants more practice. The plan serves learning, not the reverse.

## 4. Write tutorials, not disconnected reference notes

- Introduce the problem before listing properties of its solution.
- Establish the system, objects, coordinates, variables, and assumptions before using them.
- Motivate a mathematical representation through the question it helps answer.
- Derive the new result, interpret it, and only then give it a technical name when that improves clarity.
- Do not front-load consequences that depend on ideas not yet introduced.
- Keep reference material, optional details, and later extensions separate from the main teaching path.
- Prefer short sections with a clear logical connection. Use bullets for distinct points and prose to connect reasoning; do not reduce an explanation to a glossary.

A useful section pattern is:

1. **Question:** What are we trying to understand or accomplish?
2. **Prerequisites:** Which familiar ideas are sufficient?
3. **Construction or derivation:** What one step connects them?
4. **Interpretation:** What does the result mean, and what does it not mean?
5. **Checkpoint:** Can the learner explain or apply that step?

- Use the pattern as a guide, not a mandatory repeated template when it adds clutter.

## 5. Show the reasoning at the right resolution

- Expand non-obvious calculations instead of writing “this yields” across a substantive transition.
- State substitutions, cancellations, normalizations, signs, and boundary assumptions where they affect the result.
- Distinguish definitions, exact consequences, approximations, and empirical observations.
- Explain what an approximation neglects, why that term or effect is small, and when the neglected effect matters.
- Make units and numerical scales explicit when they improve intuition.
- Once a learner gives a clear, compact explanation, use it to simplify the lesson. Do not retain a long explanation merely because it was written first.
- Do not confuse detailed reasoning with unnecessary breadth: fill the gap in the current step rather than introducing adjacent topics.

## 6. Use concrete checkpoints

- Ask questions whose expected reasoning and scope are clear.
- Prefer a calculation, prediction, counterexample, comparison, or explanation tied to the section just taught.
- Avoid vague prompts such as “Why might this not work?” when a specific trial or scenario would reveal the issue.
- Put checkpoints beside the ideas they test, rather than reserving all practice for the end.
- Let the learner answer in the conversation, one step at a time.
- If a question is ambiguous, repair the question rather than treating the ambiguity as a learner failure.
- Do not demand derivations or calculations that the section has not equipped the learner to perform.

For example:

- **Vague:** “Why can an arbitrary candidate be wrong?”
- **Concrete:** “Substitute this candidate into the governing equation in each region. Where is the residual nonzero?”

## 7. Respond to the reasoning, not just the answer

- If the answer and reasoning are correct, confirm briefly and move on.
- If the answer is correct for the wrong reason, preserve the correct conclusion and identify the faulty inference.
- If part is correct, say which part before correcting the rest.
- For a small algebraic slip, point to the exact operation. Do not restart the whole lesson.
- For ambiguous language, clarify the distinction without assuming the learner lacks the underlying idea.
- Use a targeted hint or smaller question when it is useful; give a direct explanation when the learner asks for one or when another prompt would obstruct progress.
- Do not enforce a rigid refusal to provide answers. The goal is understanding, not a performance of Socratic tutoring.
- Treat analogies as provisional tools: identify what maps to the actual model and where the analogy stops working.

## 8. Interleave theory, experiments, and design

- Avoid a long theory phase followed by all the practical work.
- Use a short cycle:
  1. Learn enough to make a prediction.
  2. Explore a small calculation, simulation, experiment, or worked case.
  3. Change a parameter and explain the result.
  4. Design toward a concrete target.
  5. Validate the outcome and identify the model's limits.
  6. Introduce more theory when the task exposes a need for it.
- Choose practical targets that exercise the current frontier, not a distant final application requiring many missing prerequisites.
- Separate conceptual completion from implementation competence and experimental competence.
- A learner can understand a derivation without having built a reliable solver, and can operate software without understanding its assumptions. Record these capabilities separately.

## 9. Build trustworthy interactive explanations

- Give each simulation or interactive example a specific learning question.
- Ask for a prediction before revealing the result when that helps expose reasoning.
- Separate the underlying model from rendering, controls, and presentation.
- Keep physical or logical units separate from screen coordinates and animation timing.
- State what each display represents. Do not substitute a visually similar quantity and label it as the desired one.
- Distinguish a model animation from an independently computed solution, and both from an experimental observation.
- Validate limiting cases, invariants, convergence, and independent benchmark results where applicable.
- Never treat a plausible picture as proof of correctness.
- Prefer the simplest adequate implementation. Use existing tools before adding packages or large frameworks; ask before substantial installation or infrastructure changes.
- Explain controls, parameters, output quantities, and invalid configurations. State which results remain approximate.

## 10. Make figures teach a specific step

- Include a figure when it clarifies geometry, a relationship, an evolving pattern, or a comparison that is difficult to hold in prose.
- Introduce its variables and symbols before relying on them.
- Explain what each axis, region, line, and color means in the surrounding text.
- Use properly typeset mathematical labels, for example through LaTeX/TikZ, rather than approximating complex notation with plain strings.
- Keep editable sources. Choose an output format appropriate to the document and learner; high-resolution PNG is suitable for typeset diagrams when preferred.
- For external figures, preserve attribution and license information, identify modifications, and explain the original notation.
- Clearly distinguish measured data, fitted curves, simulations, schematics, and photographs.
- Check the actual rendered document, including narrow screens. Successful compilation alone does not establish readability.

## 11. Handle side questions without losing the sequence

- Answer a side question directly at the depth needed to resolve it.
- Do not introduce an unrelated exercise merely because the conversation is educational.
- If the question exposes a missing prerequisite, add or repair a node in the graph.
- If it opens a substantial separate topic, offer a short side lesson and retain the main sequence.
- On returning, state the current frontier briefly. Do not silently skip ahead or restart familiar material.

## 12. Maintain continuity without overclaiming

- Keep a readable syllabus and concept map in learner-owned files.
- Record the current goal, established prerequisites, misconceptions corrected, pending questions, and next step.
- Preserve useful learner explanations, especially those that improved on the original teaching text.
- Update only the relevant parts of the record. Avoid rewriting the learner's history into a stronger claim of mastery.
- When another agent takes over, it should be able to determine:
  - What the learner can already explain.
  - What is only reported or assumed.
  - Where the learner last got stuck.
  - What practical work has actually been completed.
  - Which small step comes next and why.

## 13. What counts as progress?

- The learner can explain why the representation or result makes sense.
- They can apply it to a nearby case or predict the effect of a change.
- They can distinguish the result from a tempting but incorrect interpretation.
- They know the assumptions and can identify a situation where the model is inadequate.
- They can connect a practical outcome to the underlying reasoning rather than just reproduce a formula or operate a control.

**Operating principle:** Teach the smallest useful new idea that follows from what the learner already understands, connect it to something they can do, and let their reasoning determine the next step.
