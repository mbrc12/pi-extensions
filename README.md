# pi config

My personal configuration for [pi](https://pi.dev/): extensions, skills, prompt templates,
themes, and the global instruction file. This repo is the source of truth; `~/.pi/agent` is just
a set of symlinks into it.

## Layout

| Path | What it holds |
|---|---|
| `AGENTS.md` | Global instructions: skill map, document and code rules, commit rules |
| `keybindings.json` | Keybinding overrides: fullscreen line scrolling on `Shift+Up` / `Shift+Down` |
| `extensions/` | TypeScript extensions, grouped as `tui/`, `tools/`, `agents/`, `models/`, `session/`, and `shared/` helpers |
| `skills/<name>/SKILL.md` | Procedures loaded on demand — one folder per skill |
| `prompts/<name>.md` | Prompt templates, exposed as slash commands such as `/commit` and `/multiagent` |
| `agents/<name>.md` | Subagent definitions: `scout`, `data-explorer`, `worker`, `planner`, `reviewer`, `markdown-linter`, `image-describer` |
| `themes/<name>.json` | Colour themes; `tokyo-rain` is active, `melange-light` is the alternative |

The full extension list, with one line per extension, lives in
[`extensions/README.md`](extensions/README.md). Do not duplicate it here.

## How it is wired

Pi reads resources from `~/.pi/agent`. Seven symlinks point at this repo:

```text
~/.pi/agent/AGENTS.md        -> ~/dev/pi/AGENTS.md
~/.pi/agent/agents           -> ~/dev/pi/agents
~/.pi/agent/extensions       -> ~/dev/pi/extensions
~/.pi/agent/keybindings.json -> ~/dev/pi/keybindings.json
~/.pi/agent/prompts          -> ~/dev/pi/prompts
~/.pi/agent/skills           -> ~/dev/pi/skills
~/.pi/agent/themes           -> ~/dev/pi/themes
```

- Edit files here, never through the symlinks, and commit in this repo.
- Run `/reload` in pi after editing instructions, skills, prompt templates, themes, or settings.
- Extension code is loaded at startup, so restart pi after changing it.

## Extensions

- Each subfolder has a `package.json` whose `pi.extensions` array lists the files to load.
- `extensions/disabled/` is the only way to disable an extension: move the file there and remove it
  from its folder's `pi.extensions` array. Nothing there is listed by a manifest, so nothing loads.
- Do not disable extensions through the `extensions` setting in `~/.pi/agent/settings.json`. That
  file is not tracked here, so a `!` exclusion would not survive a fresh checkout.
- `extensions/model-config.json` holds the model fallback lists used by `subagent`,
  `multiagent`, and the capability tiers.
- Tests: run `bun test` from `extensions/`.

## Skills

- One folder per skill, with the instructions in `SKILL.md`.
- The frontmatter `name` and `description` are what pi matches against, so keep the description
  specific and action-oriented.
- A `.disabled` suffix on `SKILL.md` hides a skill without deleting it.

## Agents

- One Markdown file per subagent in `agents/`.
- Frontmatter sets `name`, `description`, `tools`, and a `capability` tier of `low`, `medium`,
  `high`, or `image`; `model-config.json` maps each tier to model fallbacks.
- Used by `subagent`, `background_subagent`, and `multiagent`.

## Commits

- Show the proposed message and wait for approval before committing.
- Keep it compact: one subject line, then at most a short paragraph.
- Use `/commit` for the full workflow.
