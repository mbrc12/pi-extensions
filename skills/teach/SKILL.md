---
name: teach
description: >-
  Teach one topic as a self-contained, motivated reconstruction that equips the reader to
  derive, use, and test its central ideas. Use for requests such as "teach me X", "explain
  how X really works", or "I want to understand X from the ground up". Deliver one coherent
  lesson, with internal exercises rather than a question-and-answer loop. Do not use for task
  execution, debugging, summaries, or isolated definitions. For multi-turn tutoring with a
  persistent learner profile, use incremental-learning instead.
---

# Teach

A lesson transfers a method of reasoning. The reader should finish able to reconstruct a result,
explain why its construction is natural, identify the assumptions on which it depends, and apply
it to a new case. An article can establish that a result is true without teaching any of these.

The governing principle is **motivated reconstruction**: pose a problem, expose the obstruction,
construct the object that resolves it, establish what the construction achieves, and identify
what remains unresolved. Prediction is one form of this process, not its universal form.

## Compile the lesson before writing

1. Identify the reader's actual objective. What should they be able to derive, calculate, design,
   explain, or decide after the lesson? Prefer one central capability to encyclopedic coverage.
2. Establish the reader's starting point from the request and available context. Do not reteach
   known mathematics or domain knowledge. Distinguish assumed prerequisites from results the
   lesson must establish. If a prerequisite is missing and essential, teach it as a stage.
3. Work backward from the objective to identify the necessary constructions, intermediate
   results, assumptions, and evidence. Treat dependencies as a directed acyclic graph: a result
   may require several independently developed ideas. Order stages so every dependency is
   available when used.
4. For each stage, identify the problem that makes its new idea necessary, the intellectual
   operation that resolves it, and an independent way to check what has been achieved.
5. Remove material that neither supports the objective nor changes the validity or scope of a
   conclusion. State consequential exclusions at the point where they matter.

The plan is internal. Do not print a syllabus in place of the lesson.

## Output contract

Use the following structure. Labels are literal; bracketed instructions are not printed.

```markdown
**Objective.** [One or two sentences: what the reader will be able to reconstruct and why it matters.]

**Starting point.** [What the reader is assumed to know; at most five short bullets if needed.]

## 1. [A question that this stage resolves?]

**Problem.** [Expose the gap between what is already available and what is needed.]

**Try.** [A specific prediction, construction, or choice to make before reading the derivation.]

[Numbered or otherwise clearly sequenced derivation. Explain both the choice of operation and its validity.]

**Test.** [A proof, independent calculation, observation, counterexample, or other appropriate validation.]

**Verdict.** [Resolve Try explicitly. State what follows and what does not.]

**Carry.** [A portable rule, construction, or result, including essential conditions.]

**Open.** [The remaining question or dependency that motivates subsequent work.]

## 2. [The next necessary question?]

[Repeat the stage structure.]

## n. [The question that completes the objective?]

[Repeat the stage structure, but replace Open with Scope.]

**Scope.** [What has now been established, and the assumptions or limitations of that result.]

## Appendix — skippable

[Optional: at most six implementation pitfalls, conventions, or failure modes with fixes. No essential theory.]

**Check.** [A genuinely new transfer problem, solvable with the lesson's results.]
```

Use as many stages as necessary, but no more. A typical stage has 3–8 substantive build steps
and 150–350 words. These are defaults, not quotas: never pad a short derivation or split an
inseparable argument merely to satisfy a budget. A stage may contain auxiliary lemmas or several
new symbols if they serve one intellectual objective. Keep the reader's active working set small.

## The stage mechanics

### Heading and Problem

The heading is a question, not a subject label. The Problem explains why the question arises
from what is already known. Make the obstruction concrete: an unknown quantity, a failed
prediction, a missing invariant, an inefficient procedure, an ambiguity, or a property the
current representation cannot express.

Do not manufacture a historical narrative. A logically natural reconstruction need not be the
actual historical discovery. If historical motivation is asserted, verify it.

### Try

Give the reader an opportunity to perform a small but substantive intellectual operation before
revealing the result. Choose the operation appropriate to the domain:

- Predict the sign, scaling, ordering, or qualitative behavior of a quantity.
- Construct an expression, representation, algorithm, or model satisfying stated requirements.
- Choose between plausible hypotheses or methods and identify the distinguishing condition.
- Find a counterexample, invariant, limiting case, or missing assumption.
- Attempt the next step of a derivation from the established premises.

The task must be specific, feasible with the available information, and capable of being wrong.
Do not demand a commitment to something the reader has no basis for deciding. Where necessary,
provide a small amount of setup before Try. Never ask the reader to rediscover an arbitrary
convention or an empirical fact without evidence.

### Build

Construct the result in an order the reader can reproduce. Each substantive operation needs
both a reason for choosing it and a justification for its validity. The reason may be a desired
property, an obstruction, a symmetry, an analogy with an established construction, an extremal
principle, or a tractable approximation. The justification must rest on declared assumptions,
previous results, explicitly identified external theorems, definitions, or data.

Do not substitute a post-hoc explanation for a construction. If a substitution is chosen to
cancel a term, identify that term before making the substitution. If a representation is chosen
to simplify an operation, identify the operation and explain what the representation does to it.

Definitions introduce objects; they do not establish properties. Derive the properties that do
not follow immediately from the definition. Mark heuristic arguments, approximations,
conjectures, and rigorous conclusions distinctly. Do not suggest a heuristic uniquely determines
a construction when other choices are possible.

Show the consequential intermediate algebra. Compress routine calculations appropriate to the
reader's background, but never hide the step on which the argument turns. For physical
calculations, preserve dimensions and units. Use explicit numerical substitution when it teaches
something; do not force symbolic derivations into numerical arithmetic templates.

### Test and Verdict

Select validation appropriate to the claim, not to a fixed pedagogical ritual:

| Claim | Appropriate validation |
|---|---|
| Mathematical theorem | Proof from stated assumptions; counterexamples to proposed stronger claims |
| Mathematical construction | Verify the defining properties, existence, uniqueness when relevant |
| Algorithm | Correctness argument, complexity analysis, or a discriminating worked trace |
| Physical model | Derive observables, compare with independent measurements, examine limits |
| Numerical method | Residual, convergence, stability, error bound, or independent benchmark |
| Engineering design | Check constraints, interfaces, feasibility, and relevant failure cases |

The proof may constitute the Build itself. In that case, Test checks the result against its
original specification, or probes a meaningful boundary case; it need not repeat the proof.

Distinguish verification from illustration and validation. A numerical example does not prove
a universal theorem. A small residual does not by itself establish a small solution error.
Qualitative agreement does not establish quantitative accuracy. A fitted datum is not an
independent prediction. State which claim the test supports and the strength of that support.

Use actual data only when supported. Identify the source and conditions of consequential
empirical measurements. Label hypothetical or synthetic examples as such. If evidence is
unavailable, state what measurement would test the model; do not invent a successful test.

The Verdict must answer Try in explicit terms. If a candidate fails, identify the exact
requirement or assumption that fails. If it succeeds, identify the property established and
whether the evidence establishes, supports, or merely illustrates it. An unsuccessful model
is worth a stage when its failure motivates the next construction.

### Carry, Open, and Scope

Carry is what the reader retains after forgetting the example. It should be transferable,
precise enough to use, and qualified by the conditions under which it is valid. A formula with
its assumptions can be a better Carry than a vague verbal maxim.

Open identifies an unresolved problem. The next stage should resolve it, or explicitly develop
a prerequisite needed to resolve it. Where two branches must converge, explain their relation:
"We now have X; to combine it with Y, we first need to construct Y." Do not force a false linear
dependency. Every branch must eventually contribute to the objective.

The final stage has Scope instead of Open. Close the central question. State limitations without
turning the lesson into an unsolicited research agenda.

## Rules over the whole lesson

- Problem before machinery. Introduce the reason for a definition, formula, representation, or
  numerical calculation before asking the reader to manipulate it. Constants, premises, and
  motivating observations may appear when the problem requires them; predicted outputs must
  not be revealed before Try.
- Phenomenon before terminology when feasible. Introduce technical names when they perform
  work. Use established terminology and notation freely when already familiar to the reader.
  Define unfamiliar terms at first substantive use; avoid a front-loaded glossary.
- Preserve logical distinctions. Separate assumptions, definitions, derived consequences,
  approximations, empirical observations, and conjectures. State when a conclusion is only
  sufficient, only necessary, or an equivalence.
- Explain why the operation was chosen, not just why it is permitted. This is especially
  important for substitutions, changes of basis, auxiliary functions, relaxations, and
  algorithmic invariants.
- Use the simplest nontrivial example that exposes the mechanism. Generalize only after the
  reader has the ingredients to understand the generalization, unless their background makes
  the abstract formulation simpler.
- Address the reader as an active participant. Use second person naturally in Try or Build;
  avoid repeated encouragement, rhetorical filler, and artificial suspense.
- Use ordinary Markdown, with `##` stage headings. Use mathematical notation and LaTeX when
  they improve precision; use Unicode or fenced code where the medium requires it. Tables
  should expose comparisons, not replace arguments. Use diagrams when spatial, causal, or
  architectural structure cannot be communicated efficiently in prose.
- Do not silently omit an essential foundation. If a theorem or mechanism is taken as a black
  box, state that fact, why it is acceptable for this lesson, and exactly what property is used.
- Avoid breadth for its own sake. Advanced variants, historical background, and applications
  belong only if they clarify the central mechanism or are necessary for the stated objective.

## Transfer check

The final Check must require using the Carry results, not recalling the lesson's examples.
Change a meaningful assumption, ask for a new construction, or present a case whose outcome
requires combining established ideas. The reader should be able to solve it without new theory.
Prefer one substantial problem to a list of recall questions. Do not immediately reveal the
solution unless the user requested worked exercises. Stop after Check; do not add a generic
summary, invitation, or motivational flourish.

## Worked example: one stage of a mathematical lesson

**Objective.** Derive the best linear predictor of a scalar response under squared error, and
understand why the prediction error is orthogonal to the predictors.

**Starting point.** You know expectation, differentiation of quadratic forms, and elementary
linear algebra. All random variables below have finite second moments.

## 1. How can you characterize the best linear predictor without searching over coefficients?

**Problem.** Given a response Y and a vector of predictors X, we want to minimize
\(R(b)=\mathbb E[(Y-b^TX)^2]\). Searching coefficient space is unnecessary if we can identify
what must be true of an optimal predictor directly.

**Try.** Suppose the prediction error is positively correlated with one predictor. Decide
whether increasing the coefficient of that predictor by a sufficiently small amount improves
or worsens the prediction, using the uncentered moment as the relevant notion of correlation.

1. Write the current error as \(e=Y-b^TX\). Since changing the coefficient vector changes only
   the prediction, a perturbation \(b+th\) changes the error to \(e-th^TX\).
2. To decide whether the perturbation improves the predictor, expand the change in risk:
   \[
   R(b+th)-R(b)=-2t\mathbb E[e h^TX]+t^2\mathbb E[(h^TX)^2].
   \]
3. For small positive \(t\), the linear term determines the sign whenever its coefficient is
   nonzero. Thus a nonzero error moment in any direction supplies an improvement direction.
4. At an optimum, no such direction exists. Since the direction \(h\) is arbitrary, the necessary
   condition is \(\mathbb E[Xe]=0\).
5. Substitute the definition of the error to obtain
   \(\mathbb E[XX^T]b=\mathbb E[XY]\). This is the normal equation. If the moment matrix is
   invertible, it determines the unique candidate coefficient vector.

**Test.** Verify sufficiency: for any solution of the normal equation and any perturbation
\(d\), the risk difference is \(\mathbb E[(d^TX)^2]\geq 0\), because the cross term vanishes.

**Verdict.** A positive error moment with a predictor implies that a small increase in its
coefficient improves the prediction. Vanishing moments are not merely necessary: the test
establishes that they are sufficient for global optimality. Invertibility gives uniqueness.

**Carry.** Under squared error, the best approximation in a finite-dimensional linear span is
characterized by an error orthogonal to every element of that span, in the inner product
\(\langle U,V\rangle=\mathbb E[UV]\).

**Scope.** This characterizes the optimal linear predictor, not the optimal unrestricted
predictor. An intercept is included by adding the constant random variable to the predictor
vector; without it, the prediction error need not have zero mean.

**Check.** Add a new predictor Z to an already optimized linear model. Under what condition
can the optimal risk remain unchanged, even though Z is correlated with the original response?

## Diagnose before sending

Revise the draft if any of the following is true:

1. The reader sees a conclusion before the problem that makes it useful.
2. A key operation appears without an explanation of why one would choose it.
3. Try asks for information not yet available, or Verdict never resolves Try.
4. The lesson names an object instead of constructing it, or asserts a nontrivial property
   instead of establishing it.
5. A proof relies on an undeclared assumption, or an empirical claim is treated as a deduction.
6. A test is circular, merely repeats a fitted datum, or supports a weaker claim than Verdict.
7. Stage order follows a textbook's table of contents rather than the objective's dependencies.
8. A Carry is so vague that it cannot guide reasoning in another example.
9. The final Check is a recall question, requires untaught theory, or is unrelated to the objective.
10. A stage exists only to satisfy a length target or include material that no later argument uses.

The criterion of success is not whether the reader has seen all the relevant facts. It is whether
the reader can now perform the central reasoning without the lesson in front of them.
