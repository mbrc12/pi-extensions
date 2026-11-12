  Removing the per-row forks. The script ran once per popup, and its cost was almost entirely process spawns:

  ┌──────────────────────┬────────────┐
  │ operation            │ cost       │
  ├──────────────────────┼────────────┤
  │ exec (date, sort, …) │ 1.6–2.0 ms │
  ├──────────────────────┼────────────┤
  │ $( ) subshell        │ 0.39 ms    │
  ├──────────────────────┼────────────┤
  │ printf -v            │ 0.014 ms   │
  └──────────────────────┴────────────┘

  Per row, the old code did one $(date +%s) exec plus about ten $( ) subshells: three fg calls, two rpad calls, pill, star, and the nested age. Six
  sessions meant ~6 execs and ~60 forks, roughly 35 ms before fzf saw any input.

  What changed, in order of payoff:

  1. date hoisted out of the loop. NOW=$(date +%s) once per invocation; age_into does arithmetic and returns the result via printf -v AGO. Removed ~2
     ms per row.
  2. Colours are precomputed SGR strings. FG_C=$'\033[38;2;54;63;85m' is expanded by bash, not by a subshell. All fg/bg calls in the row path are
     gone. Removed ~1.2 ms per row.
  3. Padding and markers assign variables instead of printing. printf -v ago '%4s' and pill=…/star=… replace $(rpad …), $(pill …), $(star …). 0.014 ms
     instead of 0.39 ms each. Removed ~2.5 ms per row.
  4. One printf per row built from a single concatenated string, rather than a printf whose arguments were themselves subshells.
  5. #!/bin/bash instead of #!/usr/bin/env bash, dropping the env exec (~1.6 ms, once).
  6. trunc_into sets TRUNC rather than printing, so the preview's title truncation is fork-free too.

  Result: --list went 50 ms → 12.8 ms, with zero command substitutions inside the session loop.

  Not touched, still in the remaining ~20 ms: two tmux client round-trips (display-message 3.8 ms, list-sessions 4.2 ms), bash startup (2 ms), sh -c
  from display-popup (2 ms), sort+cut (~3 ms), and fzf's own first paint (~7 ms).
