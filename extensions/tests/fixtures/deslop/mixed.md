# Popup render cost

We measured the popup three ways. *Command substitution* was the expensive one.

| operation | cost |
|---|---|
| exec (date, sort) | 1.6–2.0 ms |
| command substitution | 0.39 ms |
| printf -v | 0.014 ms |

Per row, the old code ran one `date` exec and about ten subshells: six sessions meant six execs and sixty forks, roughly 35 ms before fzf saw input.

## What changed

- `date` is hoisted out of the loop, so it runs once per invocation.
- Colour codes are precomputed SGR strings that bash expands without a subshell.
- `rpad`, `pill`, and `star` assign variables instead of printing them.

The list command went from 50 ms to **12.8 ms**.

## What remains

Two tmux round trips (3.8 and 4.2 ms), bash startup (2 ms), the popup's `sh -c` (2 ms), sort and cut (~3 ms), and fzf's first paint (~7 ms).
