/**
 * Banner layout and resource counting.
 *
 * This module deliberately imports no Pi packages: it is the part of the banner
 * worth testing, and keeping it dependency-free means tests need no module mocks.
 * `banner.ts` supplies the Pi-specific pieces: the version, the brand-coloured
 * icon, Pi's own truncation helper, and the loaded AGENTS-style files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

/** Two spaces between the icon column and the text column. */
export const GUTTER = "  ";
/**
 * The icon column is 5 cells: one leading space, then the 4-cell logo, matching
 * the indent Pi's own header uses. The wordmark fallback is padded to the same
 * width so both lines start their text at the same column.
 */
export const ICON_WIDTH = 5;

export type BannerCounts = {
  skills: number;
  extensions: number;
  prompts: number;
};

export type BannerData = {
  version: string;
  contextFiles: string[];
  counts: BannerCounts;
};

/** The parts of a theme the banner reads, narrowed so tests can fake it. */
export type BannerTheme = {
  fg(color: "accent" | "muted" | "dim", text: string): string;
  bold(text: string): string;
};

export type BannerRenderOptions = {
  /** Pre-painted icon lines, both exactly `ICON_WIDTH` cells wide. */
  iconTop: string;
  iconBottom: string;
  /** ANSI-aware truncation, normally Pi's `truncateToWidth`. */
  truncate: (text: string, width: number, ellipsis?: string) => string;
};

function countPart(theme: BannerTheme, count: number, noun: string): string {
  const label = count === 1 ? noun : `${noun}s`;
  return `${theme.fg("accent", String(count))} ${theme.fg("muted", label)}`;
}

function contextPart(theme: BannerTheme, files: string[]): string {
  if (files.length === 0) return theme.fg("dim", "no context files");
  const separator = theme.fg("dim", " · ");
  return [theme.fg("dim", "context"), files.map((file) => theme.fg("muted", file)).join(separator)].join(" ");
}

/** Render the banner. Every line is truncated to the available width. */
export function bannerLines(
  data: BannerData,
  theme: BannerTheme,
  width: number,
  options: BannerRenderOptions,
): string[] {
  const columns = Math.max(1, width);
  const separator = theme.fg("dim", " · ");
  const counts = [
    countPart(theme, data.counts.skills, "skill"),
    countPart(theme, data.counts.extensions, "extension"),
    countPart(theme, data.counts.prompts, "prompt"),
  ].join(separator);

  // The icon already says "pi", so the first line carries only the version.
  const first = `${options.iconTop}${GUTTER}${theme.fg("dim", `v${data.version}`)}${separator}${counts}`;
  const second = `${options.iconBottom}${GUTTER}${contextPart(theme, data.contextFiles)}`;
  return [first, second].map((line) => options.truncate(line, columns, "…"));
}

/** Shorten a path for display: home becomes `~`, project files become relative. */
export function displayPath(path: string, options: { cwd?: string } = {}): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}${sep}`)) return `~/${path.slice(home.length + 1)}`;
  if (options.cwd && path.startsWith(`${options.cwd}${sep}`)) return path.slice(options.cwd.length + 1);
  return path;
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/** Entry points of one extension directory: its `pi.extensions` list, or `index.ts`. */
function manifestEntries(dir: string): string[] | undefined {
  const packagePath = join(dir, "package.json");
  if (existsSync(packagePath)) {
    try {
      const manifest = JSON.parse(readFileSync(packagePath, "utf-8")) as { pi?: { extensions?: unknown } };
      const listed = manifest.pi?.extensions;
      if (Array.isArray(listed) && listed.length > 0) {
        return listed
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => join(dir, entry))
          .filter((entry) => existsSync(entry));
      }
    } catch {
      // A broken manifest makes this directory undiscoverable in Pi too.
    }
  }
  for (const name of ["index.ts", "index.js"]) {
    const entry = join(dir, name);
    if (existsSync(entry)) return [entry];
  }
  return undefined;
}

/** Mirror Pi's discovery: top-level scripts plus one level of extension directories. */
export function discoverExtensions(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && isExtensionFile(entry.name)) {
      found.push(path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const entriesForDir = manifestEntries(path);
    if (entriesForDir) found.push(...entriesForDir);
  }
  return found;
}

function escapes(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal glob support, matching Pi's patterns: `*`, `**`, and `?`. */
export function globMatches(path: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return path === pattern;
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]!;
    if (character === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapes(character);
    }
  }
  return new RegExp(`${source}$`).test(path);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Match one path against one pattern, as Pi does: relative, basename, or absolute. */
function matchesPath(path: string, pattern: string, baseDir: string): boolean {
  const normalized = pattern.startsWith("~") ? join(homedir(), pattern.slice(1)) : pattern;
  const target = toPosix(normalized);
  return [toPosix(relative(baseDir, path)), basename(path), toPosix(path)].some((candidate) =>
    globMatches(candidate, target),
  );
}

/** A configured path may be one script or a directory of extensions. */
function entriesForConfiguredPath(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    if (!statSync(path).isDirectory()) return [path];
  } catch {
    return [];
  }
  return manifestEntries(path) ?? discoverExtensions(path);
}

/**
 * Apply `settings.json` extension patterns to discovered paths, mirroring Pi:
 * plain entries add paths, `!` excludes, `+` force-includes, `-` force-excludes.
 */
export function applyExtensionPatterns(paths: string[], patterns: string[], baseDir: string): string[] {
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("+")) forceIncludes.push(pattern.slice(1));
    else if (pattern.startsWith("-")) forceExcludes.push(pattern.slice(1));
    else if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }

  const all = [...new Set(paths)];
  const added = includes
    .map((entry) => join(baseDir, entry))
    .flatMap((entry) => entriesForConfiguredPath(entry))
    .filter((path) => !all.includes(path));
  let result = [...all, ...added];

  if (excludes.length > 0) {
    result = result.filter((path) => !excludes.some((pattern) => matchesPath(path, pattern, baseDir)));
  }
  for (const entry of forceIncludes) {
    for (const path of [...all, ...added]) {
      if (!result.includes(path) && matchesPath(path, entry, baseDir)) result.push(path);
    }
  }
  if (forceExcludes.length > 0) {
    result = result.filter((path) => !forceExcludes.some((entry) => matchesPath(path, entry, baseDir)));
  }
  return result;
}

export type ExtensionCountOptions = {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  patterns: string[];
  /** The project config directory name, normally `.pi`. */
  configDirName: string;
};

/** Count the local extensions Pi would load for this session. */
export function countExtensions(options: ExtensionCountOptions): number {
  const discovered = discoverExtensions(join(options.agentDir, "extensions"));
  if (options.projectTrusted) {
    discovered.push(...discoverExtensions(join(options.cwd, options.configDirName, "extensions")));
  }
  return applyExtensionPatterns(discovered, options.patterns, options.agentDir).length;
}

/**
 * The files whose instructions Pi loads, mirroring its own `[Context]` section:
 * a system prompt, an append-system prompt, then the AGENTS-style files from the
 * agent directory and every project ancestor. Project files win when trusted.
 */
export function contextFilePaths(options: {
  agentDir: string;
  cwd: string;
  configDirName: string;
  projectTrusted: boolean;
  /** Result of Pi's `loadProjectContextFiles()` for this session. */
  agentsFiles: string[];
}): string[] {
  const paths: string[] = [];
  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    const projectPath = join(options.cwd, options.configDirName, name);
    const globalPath = join(options.agentDir, name);
    if (options.projectTrusted && existsSync(projectPath)) paths.push(projectPath);
    else if (existsSync(globalPath)) paths.push(globalPath);
  }
  return [...paths, ...options.agentsFiles];
}
