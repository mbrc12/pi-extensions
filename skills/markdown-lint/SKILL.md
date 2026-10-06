---
name: "markdown-lint"
description: "Lint and fix markdown files with markdownlint-cli2 by delegating to the markdown-linter subagent, which runs on opencode-go/deepseek-v4-flash. Use only when the user explicitly asks to lint markdown files; do not lint automatically."
version: 1
created: "2026-08-12"
updated: "2026-08-12"
---
## When to Use
Only when the user explicitly asks to lint markdown files. Do not lint automatically after writing or editing .md files.

## Procedure
1. Ensure the config file ~/.pi/agent/.markdownlint.json exists; create it if missing with MD013 line_length ~100 and code_blocks false (see pitfalls).
2. Delegate the lint to the markdown-linter subagent: subagent tool, mode=single, agent="markdown-linter", task="Lint and fix these markdown files: <file or glob>". The agent runs on opencode-go/deepseek-v4-flash by default.
3. The subagent runs npx -y markdownlint-cli2 "<file or glob>", fixes every reported issue, and re-runs until it reports 0 issues.
4. Report the result to the user, including which files were linted and any remaining issues.

## Pitfalls
- The MD013 default of 80 flags ordinary prose paragraphs and is too strict; set line_length to ~100 in .markdownlint.json.
- Long URLs inside code blocks cannot be wrapped, so set code_blocks false for MD013; otherwise a URL in a fenced block fails lint forever.
- Do not leave known violations: fix every reported issue, not just the first.
- Keep every list item on one short line (≤ ~100 chars); some renderers break lists when a long item wraps, so split long items into shorter ones or move the prose into paragraphs.
- Rules that catch the common failure modes: MD013 (long lines), MD030 (spaces after list markers), MD032 (blank lines around lists), MD004/MD005/MD006/MD007 (marker style and indentation), MD040 (fenced code blocks need a language tag), MD036 (emphasis used as a heading).
- The first npx run needs network to fetch markdownlint-cli2; give it a generous timeout.

## Verification
1. npx -y markdownlint-cli2 "<file or glob>" reports 0 issues.
2. The markdown-linter subagent confirms the final run passes cleanly and lists the files it fixed.