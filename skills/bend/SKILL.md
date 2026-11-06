---
name: bend
description: Write, check, prove, and teach Bend (bend/bend-2), the pure affine language with laws, proofs, and GPU parallelism. Use whenever a task involves .bend files, Bend laws or proofs, LAWS.bend or PROOF.bend, the bend CLI, or learning Bend.
license: MIT
---

# Bend

Bend is a pure, affine language whose compiler checks termination and proofs. Types are terms, so
a law is a type and a proof is a `def` of that type.

## Start here

- **Run `bend guide` before writing any Bend.** It is the authoritative manual, it changes between
  releases, and it is short enough to read in one pass.
- Run `bend guide shaders` before a graphical or parallel app, and `bend guide effects` before a
  custom C/JS effect.
- Run `bend base` for the Base library, `bend base --types` for types only, `bend base Map` for one
  name and everything under it.
- Trust the installed guide over this skill when they disagree. This skill carries the workflow and
  the traps, not the full syntax.

## Project convention

Every Bend project keeps two files at its root.

| File | Owner | Content |
|---|---|---|
| `LAWS.bend` | The human | Imports the code and states each law as an open claim. Never edit, weaken, or skip it to make a proof pass. |
| `PROOF.bend` | The agent | Imports `LAWS.bend` and proves each law with a `def` of the same name: `law sorted` is proven by `def Laws.sorted`. |

Workflow for every change:

1. Read `LAWS.bend` and treat it as the specification.
2. Implement or fix the code.
3. Write the proof in `PROOF.bend`.
4. Run `bend PROOF.bend`, then `bend PROOF.bend --verdict`, before committing.

- `bend PROOF.bend` is the gate. It prints `ALL PROOFS CHECK` or `SOME PROOFS FAIL` and names each
  open or failing law.
- `--verdict` rechecks with the small Lean-verified kernel. Use it before any commit that matters.
  It needs Lean v4.34.0 through elan (`leanprover/lean4:v4.34.0`) or a prebuilt kernel in `$BENDTT`.
  A newer elan toolchain makes it fail with a version error, which is an environment problem, not a
  proof problem.
- Bend refuses a `PROOF.bend` that sits beside a `LAWS.bend` without importing it.
- A law with no paired def is an open claim and fails the gate. `?name` prints the current goal;
  `?TODO` leaves a goal open on purpose. Both report `SOME PROOFS FAIL` with the expected and
  observed terms.
- `@unsafe` (or its sugar `def f?`) and foreign code fall outside the proof guarantee. `--verdict`
  reports every def that relies on them.

## Language traps

- **Affine by default.** Every variable is used at most once, and dropping one is free. Write `+x`
  to make it reusable, which requires a `Data` type, and `-x` to erase it into types and proofs.
- **Datatypes are affine unless declared `is Data`.** `is Type` keeps a value single-owner. Only
  `Data` values can be copied, so functions, arrays, and IO handles never can.
- **Almost no inference.** Annotate when the checker cannot decide: `{3 : U32}`, `(x + y : U32)`.
- **There is no `if`.** Match on `True{}` and `False{}`.
- **Termination is mandatory and mutual recursion is forbidden.** A recursive call must pass a
  smaller part of a parameter, read left to right, so put the shrinking parameter first.
- **A `match` inspects a parameter or a pattern-bound variable, never a computed value.** `match
  sum(xs, 0):` is rejected, and no `let` may precede a `match` on a parameter. Pass computed values
  to a helper that matches on its parameter.
- **Operators are sugar and need a type.** `(a + b : U32)` calls `U32.add`. `==` is only the
  equality type; value equality is a call, `U32.is_eq(a, b)`.
- **Arrays are single-owner.** `a[i] <- v` rebinds `a`; a read returns the array beside the element.
  For non-`U32` elements use `Array.get`, `Array.set`, `Array.swap`, and `Array.clone`.

## Parallelism

- **Parallelize independent calls by default.** `a b = f(x) g(y)` runs both concurrently. This is
  the only parallel primitive.
- **`!` sends work to the GPU:** `pow2!(20n)` hands that call, and every parallel call under it, to
  the GPU. Without `!` a parallel call uses the CPU cores. A machine without a GPU runs `!` on the
  CPU, and the JavaScript target runs everything sequentially.
- **Keep both promises.** The calls are independent, which purity and affinity give you for free,
  and they take roughly the same time, which is your job. Bend uses a contention-free binary
  fork-join scheduler: an unbalanced call kills the speedup.
- **Keep shared data small.** Any `+` value read by every lane costs an atomic per read.
- Divergent work such as n-queens stays faster on the CPU. Uniform numeric work such as mandelbrot
  and n-body belongs on the GPU. Read `bend guide shaders` before writing either.

## Commands

| Command | Purpose |
|---|---|
| `bend f.bend` | Check, then run `main`. An `IO` main runs compiled; a value is normalized and printed. |
| `bend f.bend --check-only` | Check the file and its imports, run nothing. |
| `bend f.bend -o out` | Native binary. `-o out.c`, `-o out.js`, and `-o out.mjs` emit other targets. |
| `bend f.bend --verdict` | Check, then recheck with the proven kernel. |
| `bend f.bend --publish [name@version]` | Publish the file and its imports to the hub. |
| `./out +RTS --threads 8` | Run a native binary on 8 CPU threads. |
| `./out +RTS --gpu 4GB` | Cap the GPU heap. |

- A binary that uses `!` also writes `out.gpu`, which must stay beside it.
- Native builds need clang 14+, and 19+ when the program uses `!`.
- A file with no `main` is only checked.

## Teaching Bend

When the user wants to learn rather than ship, load `incremental-learning` and keep the learner's
map in a file they own, such as `docs/learning-map.md`.

Teach in this order, one small idea at a time:

1. Types, constructors, `def`, and `match`.
2. Termination: recursion on a smaller part, no `if`, tail calls.
3. Quantities and kinds: `+`, `-`, `Type` versus `Data`, why `main` marks nothing.
4. Laws and proofs: a proposition is a type, `{==}`, induction, `%e : P`.
5. Parallelism: parallel lets, `!`, load balance.
6. Effects and apps: `do IO`, `IO.fork`/`IO.join`, `App.run`.

For each step, write one small file in `/tmp`, run `bend` on it, and ask a question that tests the
learner's reasoning. Do not lecture from the guide in one block.
