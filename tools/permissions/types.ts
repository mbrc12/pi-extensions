/**
 * Permissions extension - shared types.
 *
 * Three modes:
 *  - allow   : everything passes through
 *  - classify: rule-based + optional LLM classifier auto-approves/blocks/asks
 *  - ask     : every tool call is presented to the user for confirmation
 *
 * Pipeline (classify mode):
 *   Rule classifier → allow | dangerous | defer (→ LLM)
 *   LLM classifier  → allow | dangerous | escalate (→ user)
 *   User prompt: dangerous → ⛔ DANGER marker, escalate → ⚠️ normal
 */

export type PermissionMode = "allow" | "classify" | "ask";

/** Rule classifier output. "defer" = "I can't decide, ask the LLM". */
export type RuleClass = "allow" | "dangerous" | "defer";

/** LLM classifier output. "escalate" = "I can't decide, ask the user". */
export type LlmClass = "allow" | "dangerous" | "escalate";

/** Any stage's classification. */
export type Classification = RuleClass | LlmClass;

export interface ClassificationResult {
  classification: Classification;
  reason: string;
}

/** Shell builtins / keywords that don't do I/O on their own. */
export const SHELL_KEYWORDS = [
  "if", "then", "else", "elif", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "in",
  "time", "exec", "builtin",
] as const;

/** Shell builtins that don't modify files. */
export const SAFE_BUILTINS = [
  "cd", "export", "unset", "alias", "unalias",
  "declare", "typeset", "local", "readonly",
  "set", "shift", "getopts",
  "source", ".",
  "exit", "return", "break", "continue",
  "trap", "ulimit", "umask",
  "help", "hash",
] as const;

/** Safe commands: read-only, no side effects outside cwd. */
export const SAFE_COMMANDS = [
  "ls", "pwd", "echo", "cat", "head", "tail", "wc",
  "grep", "find", "locate", "which", "type", "command",
  "env", "printenv", "whoami", "date", "uname", "hostname", "id",
  "sort", "uniq", "tr", "cut", "du", "df",
  "pgrep", "ps", "top", "htop",
  "file", "stat", "readlink", "realpath",
  "xargs",
  "awk", "sed", // only safe when not using -i
  "expr", "bc", "true", "false",
  "basename", "dirname", "printf",
  "tee", // handled specially: safe for stdout, review with file arg
  "kill", "killall", // signal commands — could be destructive but usually safe in dev
  // Commands with subcommand-specific checks (see classifier.ts)
  "git",
  "npm", "npx", "pnpm", "yarn",
  "cargo", "go",
] as const;

/** Write indicators: always dangerous / out-of-scope. These don't depend on cwd. */
export const DANGEROUS_INDICATORS = [
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bchown\b/,
  /\bdd\b/,
  /\bmount\b/, /\bumount\b/,
  /\bmkfs\b/, /\bfdisk\b/, /\bparted\b/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+push\s+.*--delete/,
  /\bgit\s+reset\b.*--hard/,
  /\bnpm\s+(publish|unpublish|deprecate)\b/,
  /\bnpm\s+install\s+-g\b/,
  /\bpip\s+install\b/, /\bpip3\s+install\b/,
  /\bmake\s+install\b/,
  /\bcargo\s+install\b/,
  /\bgo\s+install\b/,
  /\bcurl\b.*\|.*\b(?:sh|bash|python)/,
  /\bwget\b.*-O\s*[^-\s]/,  // wget writing to file path
] as const;

/** Defer indicators: need path/cwd context. Escalate to LLM. */
export const DEFER_INDICATORS = [
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bchmod\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bnpm\s+(install|add|update|remove|uninstall)\b/,
  /\bpnpm\s+(install|add|update|remove|uninstall)\b/,
  /\byarn\s+(install|add|update|remove|uninstall)\b/,
  /\bcargo\s+update\b/,
  // tee writing to a real file (not /dev/null, not a pipe/process sub)
  /\btee\s+(?!(?:-|\/dev\/|>\())[^\s|;&]+/,
] as const;

/** Inline redirect that writes to a file (not stderr / stdout only). */
export const FILE_REDIRECT = />[>]?\s*(?!\/dev\/null\b|&[12]|\/dev\/stderr\b|\/dev\/stdout\b)\S/;

/** How many characters of a command to show in prompts. */
export const COMMAND_PREVIEW_LENGTH = 200;
