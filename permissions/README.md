# permissions

Permission system for pi — intercepts tool calls and classifies them before execution. Inspired by Claude Code's permission modes.

## Modes

| Mode | Behavior |
|---|---|
| `allow` | Everything passes through, no interception |
| `classify` | Two-stage classification: rule-based → LLM → prompt user |
| `ask` | Every tool call prompts for confirmation |

Toggle modes with `/permissions allow|classify|ask` or press `F8` to cycle.

## Classification pipeline (classify mode)

```
Tool call
  │
  ├─ Stage 1: Rule-based classifier (fast, deterministic)
  │     ├─ allow      → execute
  │     ├─ dangerous  → ⛔ prompt user
  │     └─ defer      → escalate to LLM
  │
  ├─ Stage 2: LLM classifier (cheap model)
  │     ├─ allow      → execute
  │     ├─ dangerous  → ⛔ prompt user
  │     └─ escalate   → prompt user
  │
  └─ Stage 3: User prompt
```

### Rule-based checks

- **Read tools** (`read`, `grep`, `find`, `ls`): always allowed
- **Write tools** (`write`, `edit`): allowed inside cwd, blocked outside
- **Bash**: checks for dangerous patterns (sudo, chmod 777, force push), defer patterns (rm, mv, git push), file redirects, Python heredocs, and safe commands

### LLM classifier

All Python heredocs are deferred to the LLM, which judges by path context:

| Pattern | Classification |
|---|---|
| Relative paths (in cwd) | `allow` |
| Absolute paths outside cwd | `dangerous` |
| `/tmp` paths | `escalate` |
| Variable/constructed paths | `escalate` |

Uses a cheap model when available (deepseek-v4-flash, gpt-4o-mini, claude-haiku, etc.) and falls back to the session model or user prompt.

## Commands

| Command | Description |
|---|---|
| `/permissions` | Show current mode |
| `/permissions allow\|classify\|ask` | Switch mode |
| `/permissions-test-llm` | Run LLM classifier test suite |

## Keybinding

`F8` — cycle through modes: ask → classify → allow
