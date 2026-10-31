---
description: Prepare a commit, show the proposed message for approval, then commit
argument-hint: "[extra context or files]"
---
Prepare and make a commit for the current repository. Extra context: ${@:-none}

## Before committing

- Run the commit message rules below. They always apply, even when this template is not used.

## Commit message rules

- **Always run the message by the user first.** Display the exact proposed message as a fenced `text` code block, then ask for approval before running `git commit`. Wait for explicit approval; never commit without it.
- **Keep it compact.** One subject line, then at most a short paragraph — usually two or three sentences — saying what changed and why.
- No walkthrough of the diff, no bullet list of every file, no restating the code.
- If the subject line already says it, do not say it again in the body.

## Steps

1. Inspect what changed (`git status`, `git diff`), and stage only what belongs in this commit.
2. Draft the message under the rules above, then show it and ask for approval.
3. Commit only after approval. Do not push unless asked.
