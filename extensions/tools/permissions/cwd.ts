import * as path from "node:path";

export function getEffectiveCwdForCommand(command: string, cwd: string): string {
  // Common pi/bash pattern: `cd /some/project && command ...`.
  // Tell classifiers the cwd the shell command will actually run from.
  const cdMatch = command.match(/^\s*cd\s+((?:'[^']+'|"[^"]+"|[^\s;&|]+))\s*&&\s*/);
  if (!cdMatch?.[1]) return cwd;

  const raw = cdMatch[1].replace(/^(['"])(.*)\1$/, "$2");
  const expanded = raw.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  return path.resolve(cwd, expanded);
}
