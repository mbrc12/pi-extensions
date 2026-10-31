---
name: pi-config
description: Find, edit, or install pi extensions, skills, prompt templates, themes, or settings — including the lookup order between ~/.pi/agent and the npm package. Use whenever the user mentions an extension, skill, slash command, prompt template, theme, or pi configuration.
license: MIT
---

# pi configuration and resource lookup

## Extension lookup order

**When the user mentions an extension, first check `~/.pi/agent/extensions`.** Only if it is not
found there, fall back to `node_modules` (the built-in bundled extensions live under
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`).

This ensures local user-level extensions take precedence over bundled or package-installed ones.

## Layout of the user config

The editable sources live in the repo at `~/dev/pi/`, and the agent directory links to them:

| Agent directory entry | Points to |
|---|---|
| `~/.pi/agent/AGENTS.md` | `~/dev/pi/AGENTS.md` |
| `~/.pi/agent/extensions` | `~/dev/pi/extensions` |
| `~/.pi/agent/skills` | `~/dev/pi/skills` |
| `~/.pi/agent/prompts` | `~/dev/pi/prompts` |
| `~/.pi/agent/themes` | `~/dev/pi/themes` |

Edit files under `~/dev/pi`, never through the symlinks, and commit the change there.
`~/.pi/agent/settings.json`, `auth.json`, and `mcp.json` stay in the agent directory.

## Skills location

**Skills live in `~/.pi/agent/skills/<name>/`, a symlink to `~/dev/pi/skills/<name>/`.** This is
pi's default skill directory, so `settings.json` needs no `skills` entry.

- A skill is a directory with `SKILL.md` (YAML frontmatter: `name`, `description`) plus optional `references/`, `scripts/`, `assets/`, and `agents/`.
- Add a new skill by creating `~/dev/pi/skills/<name>/SKILL.md`. The agent directory picks it up through the symlink.
- Bundled skills under the npm package are read-only; extend behaviour with a user skill that wraps or overrides it.
- When a downloaded skill is a repository with many skills, copy only the subdirectory you need.
- Check what loaded: the skill's `name` and `description` appear in the available-skills list; a malformed `SKILL.md` is skipped with a warning at startup.
- Write descriptions that say both what the skill does and when it applies. Vague descriptions such as "Helps with PDFs" do not route.

## Extensions location

Extension code lives in `~/dev/pi/extensions/`, linked from `~/.pi/agent/extensions`. Its history
comes from the `pi-extensions` repo, imported under the `extensions/` prefix.

## Prompt templates

- Live in `~/.pi/agent/prompts/<name>.md` and become `/<name>` commands.
- Frontmatter: `description`, optional `argument-hint`. Substitutions: `$1`, `$2`, `$@`/`$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`.
- They load only when invoked, so they never self-trigger. Use a skill instead when the model must decide on its own.

## Always-on files

| Path | Effect |
|---|---|
| `~/.pi/agent/AGENTS.md` | Injected into every session as project instructions |
| `~/.pi/agent/APPEND_SYSTEM.md` | Appended to the system prompt |
| `~/.pi/agent/SYSTEM.md` | Replaces the system prompt |
| `AGENTS.md` in any directory | Applies when pi runs in that directory or below |

Run `/reload` after editing any of these, a skill, or a prompt template.
