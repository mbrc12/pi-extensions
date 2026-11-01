---
description: Prepare a commit, get message approval, commit, then push the current branch
argument-hint: "[extra context or files]"
---
Prepare and make a commit for the current repository, then push it. Extra context: ${@:-none}

## Before committing

- Run the commit message rules below. They always apply, even when this template is not used.

## Commit message rules

- **Always run the message by the user first.** Display the exact proposed message as a fenced `text` code block, then use `ask_question` to request approval before running `git commit`. Wait for explicit approval; never commit without it.
- **Keep it compact.** One subject line, then at most a short paragraph — usually two or three sentences — saying what changed and why.
- No walkthrough of the diff, no bullet list of every file, no restating the code.
- If the subject line already says it, do not say it again in the body.

## Steps

1. Inspect what changed (`git status`, `git diff`), and stage only what belongs in this commit.
2. Draft the message under the rules above, then show it and request approval with `ask_question`.
3. Commit only after approval.
4. After the commit succeeds, push the current branch to its configured upstream with `git push`. Do not force-push. If there is no upstream or the push fails, report that clearly and do not change remotes or retry with a different push strategy.
