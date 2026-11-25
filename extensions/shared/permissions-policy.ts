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
 * Four path classes, strongest first. Everything else falls through the last
 * row, so `permissions.json` only lists what deviates from it:
 *
 *   deny       read deny   write deny    deny[]       no grant opens it
 *   askRead    read ask    write deny    askRead[]    read prompts, write refused
 *   (default)  read allow  write ask     —            reads free, writes prompt
 *   write      read allow  write allow   write[]      neither prompts
 *
 * Reads are a denylist plus the askRead list; writes are an allowlist. A read
 * grant reopens an askRead path for reads, and never for writes.
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
  /** Paths that prompt on read and stay unwritable even with a write grant. */
  askRead: string[];
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
  /** Read grants, which reopen askRead paths for reads only. */
  read?: string[];
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
    "~/.aws",
    "~/.gnupg",
    "~/.netrc",
    "~/.git-credentials",
    "~/.kube",
    "~/.docker/config.json",
    "~/.pi/agent/auth.json",
    "~/.pi/agent/auth",
  ],
  askRead: ["~/.ssh"],
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
 * Profile for one session in one workspace.
 *
 * Keyed by session as well as workspace: subagent and multiagent sessions share
 * a workspace with their parent, and a workspace-keyed file lets whichever
 * session starts last overwrite the others' grants and mode.
 */
export function sessionProfilePath(workspace: string, sessionId: string): string {
  return join(profileDirPath(), `${workspaceHash(workspace)}.${sessionId}.sb`);
}

/** Environment variable the shell wrapper and py_explore read the profile from. */
export const PROFILE_ENV = "PI_SANDBOX_PROFILE";

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
    askRead: stringList(raw.askRead) ?? DEFAULT_POLICY.askRead,
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

/** Key used when storing a grant: the workspace's physical path. */
export function folderKeyFor(workspace: string): string {
  return realpathLoose(workspace);
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
    if (parent === current) return undefined;
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
      read: unique([...(entry.read ?? []), ...(patch.read ?? [])]),
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
  const roots = (values: string[] | undefined): string[] =>
    (values ?? []).map((p) => realpathLoose(expandPath(p, ws)));

  if (roots(policy.deny).some((root) => isUnder(target, root))) {
    return { decision: "deny", path: target, reason: "in the policy deny list" };
  }

  if (op === "write" && isUnder(target, realpathLoose(selfDir()))) {
    return { decision: "deny", path: target, reason: "pi's own policy directory is never writable" };
  }

  if (roots(folder?.grants.deny).some((root) => isUnder(target, root))) {
    return { decision: "deny", path: target, reason: "in this folder's deny list" };
  }

  // The askRead class: readable only after an explicit grant, never writable.
  const asksRead = roots(policy.askRead).some((root) => isUnder(target, root));
  const readGranted = roots(folder?.grants.read).some((root) => isUnder(target, root));

  if (op === "read") {
    if (asksRead && !readGranted) {
      return { decision: "ask", path: target, reason: "in the askRead list (reads prompt)" };
    }
    return { decision: "allow", path: target, reason: "reads are allowed except denied paths" };
  }

  if (asksRead) {
    return { decision: "deny", path: target, reason: "in the askRead list (never writable)" };
  }

  if (roots(policy.write).some((root) => isUnder(target, root))) {
    return { decision: "allow", path: target, reason: "inside the write allowlist" };
  }

  if (roots(folder?.grants.write).some((root) => isUnder(target, root))) {
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
 * Reads: allow everything, then deny the deny list and the askRead list. An
 * explicit read allowlist aborts children (dyld cannot map the shared cache),
 * so a denylist is the only workable shape. Read grants are emitted after the
 * denies they reopen, because the last matching rule decides.
 *
 * Writes: an allowlist, then a final deny covering everything reads refuse, so
 * an askRead path is never writable whatever the write grants say.
 */
/** Profile that permits everything: used by `allow` mode and `enabled: false`. */
export const BYPASS_PROFILE = "(version 1)\n(allow default)\n";

export function renderProfile(args: {
  policy: Policy;
  grants: LocalGrants;
  workspace: string;
  bypass?: boolean;
}): string {
  if (args.bypass) return BYPASS_PROFILE;
  const { policy, grants, workspace } = args;
  const ws = realpathLoose(workspace);
  const folder = lookupFolderGrants(grants, ws);

  const writeRoots = unique([
    ...policy.write.map((p) => realpathLoose(expandPath(p, ws))),
    ...(folder?.grants.write ?? []).map((p) => realpathLoose(expandPath(p, ws))),
    ...DEVICE_WRITE.map((p) => expandPath(p, ws)),
  ]);

  const readDeny = unique([
    ...policy.deny.map((p) => realpathLoose(expandPath(p, ws))),
    ...(folder?.grants.deny ?? []).map((p) => realpathLoose(expandPath(p, ws))),
  ]);

  // Reads that prompt rather than fail outright. The kernel cannot ask, so it
  // refuses them and the extension offers a grant from the denial.
  const asksRead = unique(policy.askRead.map((p) => realpathLoose(expandPath(p, ws))));

  // A read grant reopens an askRead path and never a deny, so it is filtered
  // against the deny roots before being emitted after them.
  const readGrant = unique(
    (folder?.grants.read ?? []).map((p) => realpathLoose(expandPath(p, ws))),
  ).filter((root) => !readDeny.some((deny) => isUnder(root, deny)));

  // A folder deny must never be widened by a folder write grant, and an
  // askRead path is read-only at best.
  const writeDeny = unique([
    ...readDeny,
    ...asksRead,
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
    denyRule("file-read*", asksRead),
    rule("file-read*", readGrant),
    rule("file-write*", writeAllow),
    denyRule("file-write*", writeDeny),
    networkAllowed ? "(allow network*)" : "(deny network*)",
    "",
  ].join("\n");
}

/** Profile directory: the constant, unless a session overrides it (tests). */
export function profileDirPath(): string {
  return expandPath(process.env.PI_SANDBOX_DIR ?? SANDBOX_PROFILE_DIR);
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
export function writeProfile(file: string, profile: string): string {
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

/**
 * A line counts only when it starts like a program reporting the failure. The
 * same sentence appears verbatim in tests, docs and log files, and a command
 * that merely prints one must not open a grant dialog.
 *
 *   /bin/bash: /Users/x/y: Operation not permitted
 *   cat: /Users/x/y: Operation not permitted
 *   zsh:1: operation not permitted: /Users/x/y
 *   PermissionError: [Errno 1] Operation not permitted: '/Users/x/y'
 */
const DENIAL_LINE = /^(?:[A-Za-z_][\w.+-]*|(?:\/[\w.+-]+)+)(?::\d+)*:/;
const DENIAL_BARE = /^(?:Operation not permitted|Permission denied|Read-only file system)\b/i;
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
const COMMAND_TOOLS = /^(bash|py_explore|task_start|task_status|task_stop|subagent|multiagent)$/;

/**
 * A path is only believable if it looks like one: absolute, at least two
 * segments, no shell glue. Without this, prose such as "Operation not permitted"
 * inside a log line yields "/i", and a grant dialog offers "/" because that is
 * the parent of "/i".
 */
function plausiblePath(candidate: string): boolean {
  if (!/^\/(?:[^/\s'"]+\/)+[^/\s'"]*$/.test(candidate)) return false;
  return candidate.split("/").filter(Boolean).length >= 2;
}

export function parseDenials(text: string, toolName?: string): Denial[] {
  if (toolName && !COMMAND_TOOLS.test(toolName)) return [];
  const out: Denial[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!DENIAL.test(line)) continue;
    if (!DENIAL_LINE.test(line) && !DENIAL_BARE.test(line)) continue;
    const before = line.slice(0, line.search(DENIAL));
    const after = line.slice(line.search(DENIAL));
    const candidates = [...before.matchAll(ABS_PATH)].map((m) => m[0].replace(/[:,]+$/, ""));
    const fallback = [...after.matchAll(ABS_PATH)].map((m) => m[0].replace(/[:,]+$/, ""));
    const picked = [candidates.at(-1), fallback[0]].find((value) => value && plausiblePath(value));
    out.push({ raw: line.trim(), path: picked ? realpathLoose(expandPath(picked)) : null });
  }
  return out;
}

/** Directory scopes offered by the grant dialog: parents, common ancestor, files. */
export function grantScopes(paths: string[]): GrantScopes {
  const files = unique(paths.map((p) => realpathLoose(p)));
  const parents = unique(files.map((p) => dirname(p)));

  let common = parents[0] ?? files[0] ?? "/";
  for (const parent of parents.slice(1)) {
    while (!isUnder(parent, common)) {
      const next = dirname(common);
      if (next === common) break;
      common = next;
    }
  }
  return { parents, common, files };
}

// ---------------------------------------------------------------------------
// Introspection (used by /permissions)
// ---------------------------------------------------------------------------

export function describePolicy(policy: Policy, workspace: string): string {
  const folder = lookupFolderGrants(loadGrants(), workspace);
  const grantLines = folder
    ? [
        `folder ${folder.key}: read=[${(folder.grants.read ?? []).join(", ")}] ` +
          `write=[${(folder.grants.write ?? []).join(", ")}] network=${folder.grants.network === true}`,
      ]
    : [`folder ${realpathLoose(workspace)}: no grants`];
  return [
    `enabled: ${policy.enabled}`,
    `network: ${policy.network}`,
    `deny: ${policy.deny.length} paths (read denied, write denied)`,
    `askRead: ${policy.askRead.length} paths (read prompts, write denied)`,
    `write: ${policy.write.length} paths (read and write allowed)`,
    ...grantLines,
    existsSync(policyFilePath()) ? `policy: ${policyFilePath()}` : "policy: (defaults, not yet written)",
  ].join("\n");
}

/** Merge session-only grants into the workspace's folder entry. */
export function withSessionGrants(
  grants: LocalGrants,
  workspace: string,
  patch: { write?: string[]; read?: string[] },
): LocalGrants {
  const write = patch.write ?? [];
  const read = patch.read ?? [];
  if (write.length === 0 && read.length === 0) return grants;
  const key = folderKeyFor(workspace);
  if (!key) return grants;
  const entry = grants.folders[key] ?? {};
  return {
    version: 1,
    folders: {
      ...grants.folders,
      [key]: {
        ...entry,
        read: unique([...(entry.read ?? []), ...read]),
        write: unique([...(entry.write ?? []), ...write]),
      },
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
