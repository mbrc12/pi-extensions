/**
 * Permission policy shared by the permissions extension, py_explore, and the
 * sandbox launcher.
 *
 * Two layers, one policy:
 *
 *   kernel     - Seatbelt profile generated from the policy; enforces reads,
 *                writes and network for every child process (bash, python).
 *   middleware - resolveFs() is called in-process for read/write/edit/grep/
 *                find/ls, which touch the filesystem from Node and are
 *                invisible to any process sandbox.
 *
 * Files:
 *   policy   ~/.pi/agent/permissions.json        versioned rules, user-owned
 *   grants   ~/.pi/agent/permissions.local.json  per-folder grant state
 *   profile  ~/.pi/sandbox/workspaces/<hash>.sb  rendered per workspace
 *
 * Decision order for a path: policy.deny > folder.deny > policy.write >
 * folder.write > ask. Reads are a denylist; writes are an allowlist.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve as resolvePath, sep } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FsOp = "read" | "write";
export type Decision = "allow" | "ask" | "deny";

export interface Policy {
  /** Kill switch. False disables the gate and the sandbox entirely. */
  enabled: boolean;
  /** Paths no grant can open, for reads or writes. */
  deny: string[];
  /** Writable roots. `<workspace>` expands to the session workspace. */
  write: string[];
  /** Network for child processes. Seatbelt cannot filter by host. */
  network: "allow" | "deny";
  /** Command patterns that always prompt, even when the path is allowed. */
  commands: { prompt: string[] };
  /** Grants allowed per session before denials become final. */
  maxGrants: number;
  /** Where denials are appended as JSON lines. */
  log: string;
}

export interface FolderGrants {
  write?: string[];
  deny?: string[];
  network?: boolean;
  updated?: string;
}

export interface LocalGrants {
  version: number;
  folders: Record<string, FolderGrants>;
}

export interface FsDecision {
  decision: Decision;
  /** Resolved path the decision applies to. */
  path: string;
  reason: string;
}

export interface Denial {
  raw: string;
  /** Absolute path, or null when the message carried none. */
  path: string | null;
}

export interface GrantScopes {
  /** Parent directory of each denied path. */
  parents: string[];
  /** Nearest common ancestor of all denied paths. */
  common: string;
  /** Exactly the denied paths. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_POLICY: Policy = {
  enabled: true,
  deny: [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.netrc",
    "~/.git-credentials",
    "~/.kube",
    "~/.docker/config.json",
    "~/.pi/agent/auth.json",
    "~/.pi/agent/auth",
  ],
  write: [
    "<workspace>",
    "~/dev/tmp/random-tasks",
    "~/dev/micromamba/envs/env-1",
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    "~/.cache",
    "~/Library/Caches",
    "~/.npm",
    "~/.local/share",
    "~/.cargo/registry",
    "~/.rustup/toolchains",
    "~/.micromamba/pkgs",
  ],
  network: "allow",
  commands: {
    prompt: [
      "\\bsudo\\b",
      "\\bchmod\\s+777\\b",
      "\\bchown\\b",
      "\\bmkfs\\b",
      "\\bfdisk\\b",
      "\\bparted\\b",
      "\\bdd\\s+if=",
      "\\bmount\\b",
      "\\bumount\\b",
      "\\bgit\\s+push\\b.*(--force|--delete|\\s-f\\b)",
      "\\bgit\\s+reset\\b.*--hard",
      "\\bgit\\s+clean\\b.*-[a-z]*[fx]",
      "\\bnpm\\s+(publish|unpublish|deprecate)\\b",
      "\\bnpm\\s+install\\s+(-g\\b|--global\\b)",
      "\\bpip3?\\s+install\\b",
      "\\buv\\s+pip\\s+install\\b",
      "\\bcargo\\s+(install|publish|yank)\\b",
      "\\bgo\\s+install\\b",
      "\\bmake\\s+install\\b",
      "\\bcurl\\b[^|]*\\|\\s*(sudo\\s+)?(ba)?sh\\b",
      "\\bwget\\b[^|]*\\|\\s*(sudo\\s+)?(ba)?sh\\b",
      ":\\s*\\(\\s*\\)\\s*\\{",
      "\\brm\\s+-[a-z]*r[a-z]*\\s+/(\\s|$)",
    ],
  },
  maxGrants: 20,
  log: "~/.pi/sandbox/denials.jsonl",
};

/** Device files a child process needs to write; not user-configurable. */
const DEVICE_WRITE = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"];

/** Where the shell wrapper looks for this workspace's profile. */
export const SANDBOX_PROFILE_DIR = "~/.pi/sandbox/workspaces";

/**
 * Marker that tells the shell wrapper and py_explore to skip the sandbox for
 * this workspace. Written in `allow` mode, removed in the other modes.
 */
export function bypassMarkerPath(workspace: string): string {
  return join(profileDirPath(), `${workspaceHash(workspace)}.off`);
}

/** Tools whose path argument the middleware checks. */
export const PATH_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

// ---------------------------------------------------------------------------
// Paths and files
// ---------------------------------------------------------------------------

export function home(): string {
  return homedir();
}

/**
 * Directory holding policy and grants. Overridable so tests never touch the
 * real configuration.
 */
export function permissionsDir(): string {
  const override = process.env.PI_PERMISSIONS_DIR;
  return override && override.length > 0 ? normalize(override) : join(home(), ".pi", "agent");
}

export function policyFilePath(): string {
  return join(permissionsDir(), "permissions.json");
}

export function grantsFilePath(): string {
  return join(permissionsDir(), "permissions.local.json");
}

/**
 * Directory holding pi's own policy, grants and credentials. Always denied for
 * writes: the agent must not be able to grant itself permissions.
 */
export function selfDir(): string {
  return permissionsDir();
}

/** Expand `~` and `<workspace>`, normalize, drop a trailing separator. */
export function expandPath(value: string, workspace?: string): string {
  let out = value.trim();
  if (out === "~") out = home();
  else if (out.startsWith("~/")) out = join(home(), out.slice(2));
  else if (out === "<workspace>" && workspace) out = workspace;
  else if (out.startsWith("<workspace>/") && workspace) out = join(workspace, out.slice("<workspace>/".length));
  if (!isAbsolute(out)) out = resolvePath(workspace ?? process.cwd(), out);
  out = normalize(out);
  if (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return out;
}

/** realpath, walking up to the longest existing prefix. */
export function realpathLoose(value: string): string {
  let current = normalize(value);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return normalize(value);
      tail.push(current.slice(parent.length).replace(/^\//, ""));
      current = parent;
    }
  }
}

export function isUnder(child: string, root: string): boolean {
  if (root === "/") return true;
  return child === root || child.startsWith(root + sep);
}

function isHomeOrRoot(path: string): boolean {
  const real = realpathLoose(path);
  return real === "/" || real === realpathLoose(home());
}

/**
 * A workspace that is $HOME or / must not become writable: starting pi in the
 * home directory would otherwise allow writes to everything below it.
 */
export function workspaceWritable(workspace: string): boolean {
  return !isHomeOrRoot(workspace);
}

function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Policy load
// ---------------------------------------------------------------------------

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? ([...value] as string[])
    : undefined;
}

/** Merge user policy over defaults, section by section, ignoring bad values. */
export function loadPolicy(): Policy {
  const file = policyFilePath();
  const raw = readJsonFile<Record<string, unknown>>(file);
  if (!raw) {
    writeJsonAtomic(file, DEFAULT_POLICY);
    return { ...DEFAULT_POLICY };
  }
  return {
    enabled: raw.enabled === false ? false : true,
    deny: stringList(raw.deny) ?? DEFAULT_POLICY.deny,
    write: stringList(raw.write) ?? DEFAULT_POLICY.write,
    network: raw.network === "deny" ? "deny" : "allow",
    commands: {
      prompt:
        stringList((raw.commands as { prompt?: unknown } | undefined)?.prompt) ??
        DEFAULT_POLICY.commands.prompt,
    },
    maxGrants: typeof raw.maxGrants === "number" ? raw.maxGrants : DEFAULT_POLICY.maxGrants,
    log: typeof raw.log === "string" ? raw.log : DEFAULT_POLICY.log,
  };
}

// ---------------------------------------------------------------------------
// Grants load/save
// ---------------------------------------------------------------------------

export function loadGrants(): LocalGrants {
  const raw = readJsonFile<LocalGrants>(grantsFilePath());
  if (!raw || typeof raw.folders !== "object" || raw.folders === null) {
    return { version: 1, folders: {} };
  }
  return { version: 1, folders: raw.folders };
}

/**
 * Key used when storing a grant for `workspace`. Refuses $HOME and /, so a
 * session started in the home directory can never grant home-wide writes.
 */
export function folderKeyFor(workspace: string): string | undefined {
  const real = realpathLoose(workspace);
  return isHomeOrRoot(real) ? undefined : real;
}

export interface FolderLookup {
  key: string;
  grants: FolderGrants;
}

/** Exact folder first, then the nearest ancestor entry (the trust.json walk). */
export function lookupFolderGrants(grants: LocalGrants, workspace: string): FolderLookup | undefined {
  let current = realpathLoose(workspace);
  for (;;) {
    const entry = grants.folders[current];
    if (entry) return { key: current, grants: entry };
    const parent = dirname(current);
    if (parent === current || isHomeOrRoot(parent)) return undefined;
    current = parent;
  }
}

/**
 * Merge a grant into the folder entry. Read-modify-write with one retry, so
 * concurrent subagent sessions cannot drop each other's entries.
 */
export function saveFolderGrant(
  workspace: string,
  patch: FolderGrants,
): { ok: true; key: string } | { ok: false; reason: string } {
  const key = folderKeyFor(workspace);
  if (!key) return { ok: false, reason: "refusing to store a grant for $HOME or /" };
  const file = grantsFilePath();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = loadGrants();
    const entry = current.folders[key] ?? {};
    current.folders[key] = {
      ...entry,
      write: unique([...(entry.write ?? []), ...(patch.write ?? [])]),
      deny: unique([...(entry.deny ?? []), ...(patch.deny ?? [])]),
      network: patch.network ?? entry.network,
      updated: new Date().toISOString(),
    };
    try {
      writeJsonAtomic(file, current);
      return { ok: true, key };
    } catch {
      // Another process renamed over the file between read and write. Retry.
    }
  }
  return { ok: false, reason: `could not write ${file}` };
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function resolveFs(args: {
  policy: Policy;
  grants: LocalGrants;
  op: FsOp;
  path: string;
  workspace: string;
}): FsDecision {
  const { policy, grants, op, workspace } = args;
  const ws = realpathLoose(workspace);
  const target = realpathLoose(expandPath(args.path, ws));
  const folder = lookupFolderGrants(grants, ws);

  const policyDeny = policy.deny.map((p) => realpathLoose(expandPath(p, ws)));
  if (policyDeny.some((root) => isUnder(target, root))) {
    return { decision: "deny", path: target, reason: "in the policy deny list" };
  }

  if (op === "write" && isUnder(target, realpathLoose(selfDir()))) {
    return { decision: "deny", path: target, reason: "pi's own policy directory is never writable" };
  }

  const folderDeny = (folder?.grants.deny ?? []).map((p) => realpathLoose(expandPath(p, ws)));
  if (folderDeny.some((root) => isUnder(target, root))) {
    return { decision: "deny", path: target, reason: "in this folder's deny list" };
  }

  if (op === "read") {
    return { decision: "allow", path: target, reason: "reads are allowed except denied paths" };
  }

  // Only the workspace entry is dropped when the session starts in $HOME or /;
  // the rest of the list (temp, caches, project roots) still applies.
  const allowed = policy.write
    .map((p) => realpathLoose(expandPath(p, ws)))
    .filter((root) => root !== ws || workspaceWritable(ws));
  if (allowed.some((root) => isUnder(target, root))) {
    return { decision: "allow", path: target, reason: "inside the write allowlist" };
  }

  const folderWrite = (folder?.grants.write ?? []).map((p) => realpathLoose(expandPath(p, ws)));
  if (folderWrite.some((root) => isUnder(target, root))) {
    return { decision: "allow", path: target, reason: `granted for ${folder?.key ?? ws}` };
  }

  return { decision: "ask", path: target, reason: "outside the write allowlist" };
}

/** Path argument of a filesystem tool, when it has one. */
export function toolPathArg(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!(PATH_TOOLS as readonly string[]).includes(toolName)) return undefined;
  const raw = input.path;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw;
}

// ---------------------------------------------------------------------------
// Seatbelt profile
// ---------------------------------------------------------------------------

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function rule(op: string, roots: string[]): string {
  if (roots.length === 0) return "";
  return `(allow ${op}${roots.map((root) => ` (subpath ${sbplString(root)})`).join("")})\n`;
}

function denyRule(op: string, roots: string[]): string {
  if (roots.length === 0) return "";
  return `(deny ${op}${roots.map((root) => ` (subpath ${sbplString(root)})`).join("")})\n`;
}

/**
 * Render the Seatbelt profile for one workspace.
 *
 * Reads: allow everything, then deny the credential list. An explicit read
 * allowlist aborts children (dyld cannot map the shared cache), so the deny
 * list is the only workable shape.
 */
export function renderProfile(args: {
  policy: Policy;
  grants: LocalGrants;
  workspace: string;
}): string {
  const { policy, grants, workspace } = args;
  const ws = realpathLoose(workspace);
  const folder = lookupFolderGrants(grants, ws);

  const writeRoots = unique([
    ...(workspaceWritable(ws) ? [ws] : []),
    ...policy.write.map((p) => realpathLoose(expandPath(p, ws))),
    ...(folder?.grants.write ?? []).map((p) => realpathLoose(expandPath(p, ws))),
    ...DEVICE_WRITE.map((p) => expandPath(p, ws)),
  ]).filter((root) => root !== ws || workspaceWritable(ws));

  const readDeny = unique([
    ...policy.deny.map((p) => realpathLoose(expandPath(p, ws))),
    ...(folder?.grants.deny ?? []).map((p) => realpathLoose(expandPath(p, ws))),
  ]);

  // A folder deny must never be widened by a folder write grant.
  const writeDeny = unique([
    ...readDeny,
    realpathLoose(selfDir()),
  ]);
  const writeAllow = writeRoots.filter((root) => !writeDeny.some((deny) => isUnder(root, deny)));

  const networkAllowed = policy.network === "allow" || folder?.grants.network === true;

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    denyRule("file-read*", readDeny),
    rule("file-write*", writeAllow),
    denyRule("file-write*", writeDeny),
    networkAllowed ? "(allow network*)" : "(deny network*)",
    "",
  ].join("\n");
}

export function profileDirPath(): string {
  return expandPath(SANDBOX_PROFILE_DIR);
}

/**
 * Profile file for a workspace, named by a hash of its physical path.
 *
 * Keyed by workspace rather than session on purpose: pi does not export the
 * session id to child processes, so the shell wrapper cannot find a
 * session-named file. Grants are stored per folder anyway, and the profile is
 * re-rendered from the live policy at every session start.
 */
function workspaceHash(workspace: string): string {
  return createHash("sha1").update(realpathLoose(workspace)).digest("hex").slice(0, 16);
}

export function workspaceProfilePath(workspace: string): string {
  return join(profileDirPath(), `${workspaceHash(workspace)}.sb`);
}

/** Write the profile pi's child shells read through the wrapper script. */
export function writeWorkspaceProfile(workspace: string, profile: string): string {
  const file = workspaceProfilePath(workspace);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, profile, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// Denial parsing
// ---------------------------------------------------------------------------

const DENIAL = /(Operation not permitted|Permission denied|Read-only file system|Sandbox:.*deny)/i;
const ABS_PATH = /(?:~|\/)[^\s'"`;|&<>()]+/g;

/**
 * Parse sandbox denials out of a tool result.
 *
 * bash:   /bin/bash: /Users/x/y.txt: Operation not permitted
 * python: PermissionError: [Errno 1] Operation not permitted: '/Users/x/y'
 *
 * A single command reports every blocked path, because the shell does not
 * abort on EPERM, so one dialog can cover all of them.
 */
export function parseDenials(text: string): Denial[] {
  const out: Denial[] = [];
  for (const line of text.split("\n")) {
    if (!DENIAL.test(line)) continue;
    const before = line.slice(0, line.search(DENIAL));
    const after = line.slice(line.search(DENIAL));
    const candidates = [...before.matchAll(ABS_PATH)].map((m) => m[0].replace(/[:,]+$/, ""));
    const fallback = [...after.matchAll(ABS_PATH)].map((m) => m[0].replace(/[:,]+$/, ""));
    const raw = candidates.at(-1) ?? fallback[0] ?? null;
    out.push({ raw: line.trim(), path: raw ? realpathLoose(expandPath(raw)) : null });
  }
  return out;
}

/**
 * Directory scopes offered by the grant dialog.
 *
 * `$HOME` and `/` are never offered: granting either is a policy edit, not a
 * click on a denial. When every candidate is unusable the dialog falls back to
 * the exact files.
 */
export function grantScopes(paths: string[]): GrantScopes {
  const files = unique(paths.map((p) => realpathLoose(p)));
  const storable = (path: string): boolean => path !== "/" && !isHomeOrRoot(path);
  const parents = unique(files.map((p) => dirname(p))).filter(storable);

  let common = parents[0] ?? files[0] ?? "/";
  for (const parent of parents.slice(1)) {
    while (!isUnder(parent, common)) {
      const next = dirname(common);
      if (next === common) break;
      common = next;
    }
  }
  if (!storable(common)) common = parents[0] ?? files[0] ?? common;
  return { parents, common, files };
}

// ---------------------------------------------------------------------------
// Introspection (used by /permissions)
// ---------------------------------------------------------------------------

export function describePolicy(policy: Policy, workspace: string): string {
  const folder = lookupFolderGrants(loadGrants(), workspace);
  const grantLines = folder
    ? [`folder ${folder.key}: write=[${(folder.grants.write ?? []).join(", ")}] network=${folder.grants.network === true}`]
    : [`folder ${realpathLoose(workspace)}: no grants`];
  return [
    `enabled: ${policy.enabled}`,
    `network: ${policy.network}`,
    `deny: ${policy.deny.length} paths`,
    ...grantLines,
    existsSync(policyFilePath()) ? `policy: ${policyFilePath()}` : "policy: (defaults, not yet written)",
  ].join("\n");
}

/** Merge session-only grants into the workspace's folder entry. */
export function withSessionGrants(
  grants: LocalGrants,
  workspace: string,
  roots: string[],
): LocalGrants {
  if (roots.length === 0) return grants;
  const key = folderKeyFor(workspace);
  if (!key) return grants;
  const entry = grants.folders[key] ?? {};
  return {
    version: 1,
    folders: {
      ...grants.folders,
      [key]: { ...entry, write: unique([...(entry.write ?? []), ...roots]) },
    },
  };
}

/** Remove a folder's grants. Used by /permissions forget. */
export function clearFolderGrant(workspace: string): boolean {
  const key = folderKeyFor(workspace);
  if (!key) return false;
  const current = loadGrants();
  if (!(key in current.folders)) return false;
  delete current.folders[key];
  const file = grantsFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

/** Append a line to the denial log (shadow mode and post-hoc review). */
export function logDenial(entry: Record<string, unknown>, policy: Policy): void {
  try {
    const file = expandPath(policy.log);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { flag: "a" });
  } catch {
    // Logging must never break a tool call.
  }
}
