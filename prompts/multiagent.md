---
description: Act as planner and orchestrate persistent operators for a task
argument-hint: "<goal>"
---
Act as the planner and orchestrator for this goal: $@

## Split the work

- Do the thinking yourself: scope, design decisions, integration, and final review.
- Delegate the grunt work: exploration, wide file edits, test runs, data extraction, repetitive verification.
- Give each operator one clear deliverable. If two pieces can run at once, give them to different operators.

## Run operators

- `multiagent` with `start` creates a named operator and its first assignment. `send` continues the same operator, keeping its session and context.
- Choose `agent` from the available definitions, for example `scout`, `data-explorer`, `worker`, `reviewer`, or `planner`. Use short, stable operator names.
- An operator accepts one assignment at a time. `send` is rejected while it works; use another operator or wait.
- Assignments are asynchronous: `start` and `send` return immediately. Continue useful work and end your turn rather than polling `list` or `inspect`. The completion message wakes you.
- Write a self-contained brief: the goal, relevant paths, constraints, and exactly what to report back. Operators do not see this conversation.

## Handle limitations

- Operators cannot answer interactive prompts such as permission confirmations. Avoid assigning steps that need them; run those yourself after telling the user.
- Read `inspect` output when a result looks wrong or an operator reports a blocker. Do not retry a failed assignment blindly; change the brief or `restart` with fresh context.
- Use `stop` when an operator is on the wrong track. Use `restart` only when its accumulated context is hurting.

## Deliver

- Review every operator result before relying on it. Re-run checks yourself rather than trusting a summary.
- Keep your own context lean: report findings briefly instead of pasting raw operator output.
- Tell the user what each operator produced, and what remains unverified.
