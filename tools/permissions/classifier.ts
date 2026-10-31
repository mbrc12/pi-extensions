/**
 * Rule-based (Stage 1) classifier.
 *
 * Fast, deterministic checks. Returns "allow" | "dangerous" | "defer".
 * "defer" means "I'm not sure, escalate to LLM."
 */

import * as path from "node:path";
import type { Classification, ClassificationResult } from "./types";
import {
  DANGEROUS_INDICATORS,
  DEFER_INDICATORS,
  FILE_REDIRECT,
  SAFE_BUILTINS,
  SAFE_COMMANDS,
  SHELL_KEYWORDS,
} from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a tool call using only deterministic rules.
 * Returns undefined when the classifier cannot decide (→ escalate).
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): ClassificationResult | undefined {
  switch (toolName) {
    case "read":
    case "grep":
    case "find":
    case "ls":
      return classifyRead(toolName, input, cwd);
    case "write":
    case "edit":
      return classifyWrite(toolName, input, cwd);
    case "bash":
      return classifyBash(input, cwd);
    default:
      // Custom tools → review (we don't know what they do)
      return {
        classification: "defer",
        reason: `Custom tool "${toolName}" requires review`,
      };
  }
}

// ---------------------------------------------------------------------------
// Read tools — always allow
// ---------------------------------------------------------------------------

function classifyRead(
  _toolName: string,
  _input: Record<string, unknown>,
  _cwd: string,
): ClassificationResult {
  return { classification: "allow", reason: "Read-only tool" };
}

// ---------------------------------------------------------------------------
// Write tools — allow inside cwd, dangerous outside
// ---------------------------------------------------------------------------

function classifyWrite(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): ClassificationResult | undefined {
  const rawPath = input.path as string | undefined;
  if (!rawPath) {
    return {
      classification: "defer",
      reason: `${toolName} tool called without a path`,
    };
  }

  const resolved = path.resolve(cwd, rawPath);

  // Inside cwd / subdirectories → allow
  if (isInsideDir(resolved, cwd)) {
    return {
      classification: "allow",
      reason: `Path "${rawPath}" is within working directory`,
    };
  }

  // Temp directories are OK but warrant review
  if (
    resolved.startsWith("/tmp/") ||
    resolved.startsWith("/var/tmp/") ||
    resolved.startsWith("/dev/null")
  ) {
    return {
      classification: "defer",
      reason: `Path "${rawPath}" is in a temp directory — review recommended`,
    };
  }

  return {
    classification: "dangerous",
    reason: `Path "${rawPath}" is outside working directory`,
  };
}

// ---------------------------------------------------------------------------
// Bash — multi-stage analysis
// ---------------------------------------------------------------------------

function classifyBash(
  input: Record<string, unknown>,
  _cwd: string,
): ClassificationResult | undefined {
  const command = (input.command as string ?? "").trim();
  if (!command) {
    return { classification: "allow", reason: "Empty command" };
  }

  // 1. Check for dangerous indicators (always block)
  const dangerousResult = checkDangerousIndicators(command);
  if (dangerousResult) return dangerousResult;

  // 2. Check for defer indicators (need context → escalate to LLM)
  const deferResult = checkDeferIndicators(command);
  if (deferResult) return deferResult;

  // 3. Check file redirects
  const redirectResult = checkFileRedirects(command);
  if (redirectResult) return redirectResult;

  // 4. Check for python heredocs
  const pythonResult = checkPythonHeredoc(command);
  if (pythonResult) return pythonResult;

  // 5. Compound shell syntax is easy to misclassify with regex. Let the LLM
  // inspect it unless an earlier rule already caught it as dangerous/defer.
  const complexityResult = checkShellComplexity(command);
  if (complexityResult) return complexityResult;

  // 6. Quick heuristic: if the command looks like a simple safe command, allow
  const safeResult = checkSafeCommand(command);
  if (safeResult) return safeResult;

  // 6. Ambiguous → escalate
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInsideDir(target: string, dir: string): boolean {
  const normalizedTarget = path.normalize(target);
  const normalizedDir = path.normalize(dir);
  if (normalizedTarget === normalizedDir) return true;
  // Must be a sub-path: starts with dir + separator
  return (
    normalizedTarget.startsWith(normalizedDir + path.sep) ||
    normalizedTarget.startsWith(normalizedDir + "/") // handles both styles
  );
}

// ---------------------------------------------------------------------------
// Bash sub-checks
// ---------------------------------------------------------------------------

function checkDangerousIndicators(command: string): ClassificationResult | undefined {
  for (const pattern of DANGEROUS_INDICATORS) {
    if (pattern.test(command)) {
      return {
        classification: "dangerous",
        reason: `Command matches destructive pattern: ${String(pattern)}`,
      };
    }
  }
  return undefined;
}

function checkDeferIndicators(command: string): ClassificationResult | undefined {
  for (const pattern of DEFER_INDICATORS) {
    if (pattern.test(command)) {
      return {
        classification: "defer",
        reason: `Command needs LLM review: ${String(pattern)}`,
      };
    }
  }
  return undefined;
}

function checkFileRedirects(
  command: string,
): ClassificationResult | undefined {
  if (FILE_REDIRECT.test(command)) {
    // Check if redirect target is inside cwd
    // For now, redirects are always escalated — determining the target is complex
    return {
      classification: "defer",
      reason: "Command uses file redirection",
    };
  }
  return undefined;
}

function checkPythonHeredoc(command: string): ClassificationResult | undefined {
  // Detect python heredoc or -c invocation
  const isPython =
    /\bpython3?\b/.test(command) &&
    (command.includes("<<") || command.includes(" -c "));

  if (!isPython) return undefined;

  // Never pattern-match python — always escalate to LLM classifier
  return {
    classification: "defer",
    reason: "Python code — escalate to LLM for safety check",
  };
}

function checkShellComplexity(command: string): ClassificationResult | undefined {
  if (/(?:&&|\|\||;|`|\$\(|\|)/.test(command)) {
    return {
      classification: "defer",
      reason: "Compound shell command requires LLM review",
    };
  }
  return undefined;
}

function checkSafeCommand(command: string): ClassificationResult | undefined {
  // Strip leading environment var assignments and redirections for the check
  const cleanCommand = command
    .replace(/^(\s*\w+=\S+\s+)+/, "")
    .replace(/\s*[12]?>&?\s*\/dev\/null\b/g, "")
    .replace(/\s*\|\s*$/, "")
    .trim();

  // Extract the first "word" (command name)
  const firstWord = cleanCommand.split(/\s+/)[0] ?? "";

  // Shell keywords → allow (they don't do I/O, the commands inside them do)
  const keywordSet = new Set<string>(SHELL_KEYWORDS);
  if (firstWord && keywordSet.has(firstWord)) {
    return {
      classification: "allow",
      reason: `Shell keyword: ${firstWord}`,
    };
  }

  // Shell builtins → allow (cd, export, source, etc.)
  const builtinSet = new Set<string>(SAFE_BUILTINS);
  if (firstWord && builtinSet.has(firstWord)) {
    return {
      classification: "allow",
      reason: `Shell builtin: ${firstWord}`,
    };
  }

  // Check against safe commands
  const safeSet = new Set<string>(SAFE_COMMANDS);
  if (firstWord && safeSet.has(firstWord)) {
    // Additional checks for borderline safe commands
    if (firstWord === "git") {
      return checkGitCommand(cleanCommand);
    }
    if (firstWord === "npm" || firstWord === "npx" || firstWord === "pnpm" || firstWord === "yarn") {
      return { classification: "defer", reason: "Package manager command requires LLM review" };
    }
    if (firstWord === "cargo") {
      return { classification: "defer", reason: "Cargo command requires LLM review" };
    }
    if (firstWord === "go") {
      return { classification: "defer", reason: "Go command requires LLM review" };
    }
    if (firstWord === "sed" || firstWord === "awk" || firstWord === "xargs" || firstWord === "tee") {
      return { classification: "defer", reason: `${firstWord} command requires LLM review` };
    }
    if (firstWord === "kill" || firstWord === "killall") {
      return {
        classification: "defer",
        reason: "Signal command may affect running processes",
      };
    }

    return {
      classification: "allow",
      reason: `Safe command: ${firstWord}`,
    };
  }

  // Not in safe list → ambiguous
  return undefined;
}

function checkTeeCommand(command: string): ClassificationResult | undefined {
  // tee with a file argument → review
  // tee /dev/null, tee >(cmd) → safe
  const args = command.split(/\s+/).slice(1);
  const hasFileArg = args.some(
    (arg) =>
      arg.length > 0 &&
      !arg.startsWith("-") &&
      !arg.startsWith(">") &&
      !arg.startsWith("/dev/") &&
      !arg.startsWith("${") &&
      arg !== "|",
  );

  if (hasFileArg) {
    return {
      classification: "defer",
      reason: "tee writing to file",
    };
  }

  return {
    classification: "allow",
    reason: "tee to stdout/dev only",
  };
}

function checkGitCommand(command: string): ClassificationResult | undefined {
  const tokens = tokenizeShellWords(command);
  const subcommandInfo = getGitSubcommand(tokens);
  const subcommand = subcommandInfo?.subcommand;
  const args = subcommandInfo?.args ?? [];

  if (!subcommand) {
    return { classification: "defer", reason: "Unable to identify git subcommand" };
  }

  // Handle dangerous forms even when git has global options, e.g.
  // `git -C repo push --force` or `git -c x=y reset --hard`.
  if (subcommand === "push" && args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-") || a === "--delete")) {
    return { classification: "dangerous", reason: "Destructive git push" };
  }
  if (subcommand === "reset" && args.includes("--hard")) {
    return { classification: "dangerous", reason: "git reset --hard" };
  }

  // Be conservative: only explicitly read-only git subcommands are auto-allowed.
  // Everything that may mutate refs, the index, the working tree, history, or a
  // remote should go to the LLM/user instead of being regex-guessed as safe.
  const readOnly = new Set([
    "status", "log", "diff", "show", "grep", "ls-files", "rev-parse",
    "remote", "config", "describe", "blame", "shortlog", "reflog",
  ]);

  if (readOnly.has(subcommand)) {
    return {
      classification: "allow",
      reason: `Read-only git subcommand: ${subcommand}`,
    };
  }

  if (subcommand === "branch" || subcommand === "tag") {
    // `git branch` / `git tag` list; arguments may create/delete/modify refs.
    const nonFlagArgs = args.filter((a) => !a.startsWith("-"));
    if (nonFlagArgs.length === 0) {
      return { classification: "allow", reason: `Read-only git ${subcommand}` };
    }
  }

  return {
    classification: "defer",
    reason: `Git subcommand requires review: ${subcommand}`,
  };
}

function tokenizeShellWords(command: string): string[] {
  // Lightweight tokenizer for classifier heuristics. This is intentionally not
  // a shell parser; when it cannot understand something, callers should defer.
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) =>
    token.replace(/^(['"])(.*)\1$/, "$2"),
  ) ?? [];
}

function getGitSubcommand(
  tokens: string[],
): { subcommand: string; args: string[] } | undefined {
  if (tokens[0] !== "git") return undefined;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    // Common git global options that consume the next token.
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(token)) {
      i++;
      continue;
    }

    // Common git global flags / inline options.
    if (
      token === "--no-pager" ||
      token === "--bare" ||
      token === "--version" ||
      token === "--help" ||
      token.startsWith("-c") ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=") ||
      token.startsWith("--namespace=") ||
      token.startsWith("--exec-path=")
    ) {
      continue;
    }

    return { subcommand: token, args: tokens.slice(i + 1) };
  }

  return undefined;
}

function checkGoCommand(command: string): ClassificationResult | undefined {
  if (/\bgo\s+install\b/.test(command)) {
    return { classification: "dangerous", reason: "go install" };
  }
  // go build, go test, go vet, go fmt, go run (within cwd)
  return {
    classification: "allow",
    reason: "Safe go command",
  };
}

function checkNodePackageCommand(command: string): ClassificationResult | undefined {
  if (/\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish|deprecate)\b/.test(command)) {
    return { classification: "dangerous", reason: "Package publish/deprecate" };
  }
  if (/\bnpm\s+install\s+-g\b/.test(command)) {
    return { classification: "dangerous", reason: "Global npm install" };
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:install|add|update|upgrade|remove|uninstall)\b/.test(command)) {
    return { classification: "defer", reason: "Package manager modifying dependencies" };
  }
  // npm test, npm run, npx, etc.
  return {
    classification: "allow",
    reason: "Safe package manager command",
  };
}

function checkCargoCommand(command: string): ClassificationResult | undefined {
  if (/\bcargo\s+install\b/.test(command)) {
    return { classification: "dangerous", reason: "cargo install" };
  }
  if (/\bcargo\s+publish\b/.test(command)) {
    return { classification: "dangerous", reason: "cargo publish" };
  }
  if (/\bcargo\s+update\b/.test(command)) {
    return { classification: "defer", reason: "cargo update modifies lockfile" };
  }
  // cargo build, cargo check, cargo test, cargo fmt, cargo clippy
  return {
    classification: "allow",
    reason: "Safe cargo command",
  };
}
