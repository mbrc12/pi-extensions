/**
 * Permissions extension for pi.
 *
 * Three modes:
 *   allow    - bypass everything: no policy gate, no command patterns, no
 *              sandbox. The wrapper and py_explore find a `.off` marker for the
 *              workspace and skip sandbox-exec.
 *   sandbox  - the default. The kernel holds the line: writes outside the
 *              write list, reads of denied paths, and (if configured) network
 *              fail for bash and python. In-process file tools are checked
 *              against the same policy. Anything outside the list is prompted.
 *   ask      - prompt for every tool call. The sandbox stays on.
 *
 * Policy: ~/.pi/agent/permissions.json. Grants: ~/.pi/agent/permissions.local.json.
 * Commands: /permissions [allow|sandbox|ask|local|forget|policy], F8 cycles modes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptWait } from "../../session/notify-on-idle";
import type { PermissionMode } from "./types";
import { showAskDialog } from "./ask-dialog";
import { COMMAND_PREVIEW_LENGTH } from "./types";
import { existsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DEFAULT_POLICY,
  PROFILE_ENV,
  profileDirPath,
  clearFolderGrant,
  describePolicy,
  grantScopes,
  grantsFilePath,
  loadGrants,
  loadPolicy,
  logDenial,
  lookupFolderGrants,
  parseDenials,
  renderProfile,
  resolveFs,
  saveFolderGrant,
  toolPathArg,
  unique,
  withSessionGrants,
  sessionProfilePath,
  writeProfile,
  workspaceProfilePath,
  type LocalGrants,
  type Policy,
} from "../../shared/permissions-policy.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE_KEY = "permissions-mode";

interface PersistedPermissionState {
  mode: PermissionMode;
  activeTools?: string[];
}

let currentMode: PermissionMode = "sandbox"; // default
let modeGeneration = 0;

// Policy + sandbox state, refreshed at session start and on every grant.
let policy: Policy = DEFAULT_POLICY;
let grants: LocalGrants = { version: 1, folders: {} };
let sessionWrites: string[] = [];
let sessionReads: string[] = [];
let profileActive = false;
let grantCount = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "allow":
      return "🟢 allow (F8)";
    case "sandbox":
      return "📦 sandbox (F8)";
    case "ask":
      return "🔴 ask (F8)";
  }
}

/** Footer status shows the mode as one emoji; the label stays in notifications. */
function modeEmoji(mode: PermissionMode): string {
  switch (mode) {
    case "allow":
      return "🟢";
    case "sandbox":
      return "📦";
    case "ask":
      return "🔴";
  }
}

function modeColor(mode: PermissionMode): "success" | "accent" | "error" {
  switch (mode) {
    case "allow":
      return "success";
    case "sandbox":
      return "accent";
    case "ask":
      return "error";
  }
}

function summarizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { title: string; detail: string; isLarge: boolean; full: string } {
  switch (toolName) {
    case "bash": {
      const cmd = (input.command as string) ?? "";
      const why = typeof input.description === "string" ? input.description.trim() : "";
      const isLarge = cmd.length > COMMAND_PREVIEW_LENGTH;
      const detail = isLarge
        ? cmd.slice(0, COMMAND_PREVIEW_LENGTH) +
          `\n... [${cmd.length - COMMAND_PREVIEW_LENGTH} more chars truncated]`
        : cmd;
      // The description is the model's own statement of intent; it is the most
      // useful thing to show in an approval prompt.
      const title = why || (isLarge ? `Run bash command (${cmd.length} chars)` : "Run bash command");
      return { title, detail, isLarge, full: cmd };
    }
    case "write": {
      const p = (input.path as string) ?? "?";
      const content = (input.content as string) ?? "";
      const isLarge = content.length > COMMAND_PREVIEW_LENGTH;
      return {
        title: `Write file: ${p}${isLarge ? ` (${content.length} chars)` : ""}`,
        detail: isLarge
          ? content.slice(0, COMMAND_PREVIEW_LENGTH) + `... [truncated]`
          : content.slice(0, COMMAND_PREVIEW_LENGTH),
        isLarge,
        full: content,
      };
    }
    case "edit": {
      const p = (input.path as string) ?? "?";
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const count = edits.length || 1;
      const anyLarge = edits.some(
        (e: { oldText?: string; newText?: string }) =>
          (e.oldText ?? "").length > 60 || (e.newText ?? "").length > 60,
      );
      const isLarge = count > 3 || anyLarge;
      return {
        title: `Edit file: ${p} (${count} edit${count !== 1 ? "s" : ""})`,
        detail: edits
          .slice(0, 3)
          .map(
            (e: { oldText?: string; newText?: string }, i: number) =>
              `Edit ${i + 1}: "${(e.oldText ?? "").slice(0, 60)}${(e.oldText ?? "").length > 60 ? "..." : ""}" → "${(e.newText ?? "").slice(0, 60)}${(e.newText ?? "").length > 60 ? "..." : ""}"`,
          )
          .join("\n"),
        isLarge,
        full: edits
          .map(
            (e: { oldText?: string; newText?: string }, i: number) =>
              `Edit ${i + 1}: "${e.oldText ?? ""}" → "${e.newText ?? ""}"`,
          )
          .join("\n"),
      };
    }
    case "read": {
      const p = (input.path as string) ?? "?";
      return { title: `Read file: ${p}`, detail: p, isLarge: false, full: p };
    }
    case "grep":
    case "find":
    case "ls": {
      const p = (input.path as string) ?? "cwd";
      const extra =
        toolName === "grep"
          ? ` for "${input.pattern ?? ""}"`
          : toolName === "find"
            ? ` matching "${input.pattern ?? ""}"`
            : "";
      const detail = `${toolName}: ${p}${extra}`;
      return { title: detail, detail, isLarge: false, full: detail };
    }
    default: {
      const json = JSON.stringify(input);
      return {
        title: `${toolName}`,
        detail: json.slice(0, COMMAND_PREVIEW_LENGTH),
        isLarge: json.length > COMMAND_PREVIEW_LENGTH,
        full: json,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt for a tool call that policy cannot auto-approve
// ---------------------------------------------------------------------------

/**
 * One dialog for both the ask band and ask mode.
 *
 * `destructive` means the command matched a pattern from `commands.prompt`
 * (force push, curl pipe into a shell, package installs). The dialog warns,
 * but the decision is still the user's.
 */
async function promptForToolCall(
  pi: ExtensionAPI,
  event: { toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
  level: "destructive" | "outside" | "mode",
  matchedPattern?: string,
): Promise<{ block: true; reason: string } | undefined> {
  const destructive = level === "destructive";
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: destructive
        ? "Destructive command blocked (no UI to approve)"
        : "Needs approval and no UI is available",
    };
  }

  const summary = summarizeToolCall(event.toolName, event.input);
  const subtitleParts = [
    summary.title !== "Run bash command" ? summary.title : undefined,
    matchedPattern ? `matches: ${matchedPattern}` : undefined,
  ].filter(Boolean) as string[];
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(" · ") : undefined;
  const header =
    level === "destructive"
      ? "⛔ Matches a destructive pattern — check the command"
      : level === "outside"
        ? "⚠️ Outside the permission policy"
        : "🔴 Ask mode — approve this call";

  promptWait(pi, { title: "Pi", body: header });
  const allowed = await showAskDialog(ctx, {
    header,
    subtitle,
    preview: summary.detail,
    full: summary.full,
    truncated: summary.isLarge,
    allowLabel: destructive ? "Allow Anyway" : "Allow",
    denyLabel: "Deny",
    background: destructive ? "toolErrorBg" : "customMessageBg",
  });

  return allowed ? undefined : { block: true, reason: "Blocked by user" };
}

// ---------------------------------------------------------------------------
// Mode transitions and persistence
// ---------------------------------------------------------------------------

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "allow" || value === "sandbox" || value === "ask";
}

/** Sessions written before the rename stored "classify"; treat it as sandbox. */
function migrateMode(value: unknown): PermissionMode | undefined {
  if (value === "classify" || value === "auto") return "sandbox";
  return isPermissionMode(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry(STATE_KEY, {
    mode: currentMode,
    activeTools: pi.getActiveTools().filter(
      (name) => name !== "plan_exit" && name !== "notes",
    ),
  } satisfies PersistedPermissionState);
}

function reconstructState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  modeGeneration += 1;
  currentMode = "sandbox";

  let restored: PersistedPermissionState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_KEY) continue;
    const data = entry.data as Partial<PersistedPermissionState> | undefined;
    if (!data) continue;
    const stored = migrateMode(data.mode);
    if (!stored) continue;
    restored = {
      mode: stored,
      activeTools: stringArray(data.activeTools),
    };
  }

  if (restored) {
    currentMode = restored.mode;
    if (restored.activeTools) {
      pi.setActiveTools(
        restored.activeTools.filter(
          (name) => name !== "plan_exit" && name !== "notes",
        ),
      );
    }
  }
  updateStatus(ctx);
}

// ---------------------------------------------------------------------------
// Policy gate and sandbox profile
// ---------------------------------------------------------------------------

/** Reload policy and grants, then render this session's Seatbelt profile. */
function loadPolicyState(ctx: ExtensionContext): void {
  policy = loadPolicy();
  grants = loadGrants();
  sessionWrites = [];
  sessionReads = [];
  grantCount = 0;
  refreshProfile(ctx);
}

function mergedGrants(ctx: ExtensionContext): LocalGrants {
  return withSessionGrants(grants, ctx.cwd, { write: sessionWrites, read: sessionReads });
}

function refreshProfile(ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  const profileFile = sessionProfilePath(ctx.cwd, sessionId);
  const bypass = !policy.enabled || currentMode === "allow";

  try {
    writeProfile(
      profileFile,
      renderProfile({
        policy,
        grants: mergedGrants(ctx),
        workspace: ctx.cwd,
        bypass,
      }),
    );
    // The wrapper reads the profile from the environment rather than guessing a
    // name: subagent sessions share the workspace and must not share the file.
    process.env[PROFILE_ENV] = profileFile;
    profileActive = !bypass;
  } catch (error) {
    profileActive = false;
    ctx.ui.notify(`permissions: cannot write sandbox profile: ${String(error)}`, "error");
    return;
  }

  // Retire files from the workspace-keyed scheme.
  removeIfPresent(workspaceProfilePath(ctx.cwd));
  removeIfPresent(join(profileDirPath(), `${basename(profileFile, ".sb")}.off`));
}

function removeIfPresent(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Best effort: a stale file only affects the next session.
  }
}

function policyOperation(toolName: string): "read" | "write" | undefined {
  if (toolName === "write" || toolName === "edit") return "write";
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    return "read";
  }
  return undefined;
}

/**
 * The permissions system is off for this workspace.
 *
 * Allow mode is the switch, and the `.off` marker is what the shell wrapper and
 * py_explore actually obey. Consulting both means the gate and the kernel can
 * never disagree: if a marker was left behind, or a mode change has not been
 * re-rendered yet, both layers still answer the same way.
 */
function bypassed(): boolean {
  return !policy.enabled || currentMode === "allow";
}

/**
 * The first destructive pattern a bash command matches, if any.
 *
 * The pattern source is shown in the prompt: without it the user has to guess
 * whether the text will run or merely mentions something, which is exactly the
 * distinction a regex cannot make.
 */
function destructiveMatch(event: { toolName: string; input: Record<string, unknown> }): string | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = typeof event.input.command === "string" ? event.input.command : "";
  return promptPatterns(policy.commands.prompt).find((re) => re.test(command))?.source;
}

/** Compiled `commands.prompt` patterns, cached by source. */
const patternCache = new Map<string, RegExp>();

function promptPatterns(sources: string[]): RegExp[] {
  return sources.map((source) => {
    const cached = patternCache.get(source);
    if (cached) return cached;
    const compiled = new RegExp(source, "i");
    patternCache.set(source, compiled);
    return compiled;
  });
}

/**
 * Check the in-process file tools against the policy before the classifier
 * runs. The kernel already covers bash and python, so this only handles Node
 * filesystem calls, which no process sandbox can see.
 */
/**
 * Decide a tool call from policy alone.
 *
 *   { block }  policy deny, or a command pattern that must not run unattended
 *   "allow"    policy allows it; skip the prompt entirely
 *   "ask"      outside the allowlist, or a destructive command pattern
 *   undefined  policy has no opinion (bash without a matching pattern, tools
 *              with no path argument)
 *
 * In-process file tools are checked here because the kernel cannot see Node fs
 * calls. bash is enforced by the kernel, so only its command patterns are
 * inspected, and only to decide whether to prompt.
 */
function policyGate(
  event: { toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
): { block: true; reason: string } | "allow" | "ask" | undefined {
  if (bypassed()) return undefined;

  if (event.toolName === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (!command) return undefined;
    return promptPatterns(policy.commands.prompt).some((re) => re.test(command))
      ? "ask"
      : undefined;
  }

  const declared = policyOperation(event.toolName);
  const rawPath = event.input.path;
  const op = declared ?? (typeof rawPath === "string" ? "write" : undefined);
  const path = toolPathArg(event.toolName, event.input) ?? (typeof rawPath === "string" ? rawPath : undefined);
  if (!op || !path) return undefined;

  const verdict = resolveFs({
    policy,
    grants: mergedGrants(ctx),
    op,
    path,
    workspace: ctx.cwd,
  });

  if (verdict.decision === "deny") {
    return { block: true, reason: `${verdict.path}: ${verdict.reason}` };
  }
  if (verdict.decision === "allow") return "allow";
  return "ask";
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === "object" && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * One dialog for one operation class.
 *
 * Read and write grants are separate lists, so approving reads never widens
 * writes. The title names the operation because the denial message does not:
 * "2 reads" and "2 writes" are different questions with different answers.
 */
async function offerGrant(
  ctx: ExtensionContext,
  op: "read" | "write",
  paths: string[],
  notes: string[],
): Promise<void> {
  const workspace = ctx.cwd;
  const scopes = grantScopes(paths);
  const noun = op === "write" ? "writes" : "reads";

  const items: Array<{
    key: "parents" | "common" | "files" | "session" | "no";
    label: string;
  }> = [{ key: "parents", label: `📁 Allow ${noun} in ${scopes.parents.join(", ")} for this folder` }];
  if (scopes.common !== scopes.parents[0] && !scopes.parents.includes(scopes.common)) {
    items.push({ key: "common", label: `🌳 Allow ${noun} in ${scopes.common} (wider)` });
  }
  items.push({
    key: "files",
    label:
      scopes.files.length === 1
        ? `📄 Allow ${noun} only in ${scopes.files[0]}`
        : `📄 Allow ${noun} only in these ${scopes.files.length} files`,
  });
  items.push({
    key: "session",
    label: `⏳ Allow ${noun} in ${scopes.parents.join(", ")} for this session only`,
  });
  items.push({ key: "no", label: "🚫 No, leave it denied" });

  const choice = await ctx.ui.select(
    `📦 Sandbox denied ${paths.length} ${noun}`,
    items.map((item) => item.label),
  );
  const picked = items.find((item) => item.label === choice)?.key ?? "no";

  const persist = (roots: string[]): void => {
    const saved = saveFolderGrant(workspace, op === "read" ? { read: roots } : { write: roots });
    grants = loadGrants();
    grantCount += 1;
    refreshProfile(ctx);
    notes.push(
      saved.ok
        ? `✅ granted ${op} access to ${roots.join(", ")} for ${saved.key}; re-run the command`
        : `🚫 could not store grant: ${saved.reason}`,
    );
  };

  if (picked === "parents") {
    persist(scopes.parents);
  } else if (picked === "common") {
    persist([scopes.common]);
  } else if (picked === "files") {
    persist(scopes.files);
  } else if (picked === "session") {
    const roots = scopes.parents;
    if (op === "read") sessionReads.push(...roots);
    else sessionWrites.push(...roots);
    grantCount += 1;
    refreshProfile(ctx);
    notes.push(`⏳ granted ${op} access to ${roots.join(", ")} for this session only; re-run the command`);
  }
}

/**
 * Turn sandbox denials into a grant dialog.
 *
 * bash does not abort on EPERM, so one command reports every blocked path in
 * a single result. Grants are directory roots stored per folder, so the next
 * command touching a different file in the same directory needs no prompt.
 *
 * The message does not say which operation was refused, so each path is asked
 * both ways. The classes settle it: a path that asks for reads denies writes,
 * so a denial there can only be a read.
 */
async function handleSandboxDenials(
  event: {
    toolName: string;
    content: unknown;
  },
  ctx: ExtensionContext,
): Promise<{ content: unknown[] } | undefined> {
  if (bypassed()) return undefined;
  const denials = parseDenials(resultText(event.content), event.toolName).filter((item) => item.path);
  if (denials.length === 0) return undefined;

  const workspace = ctx.cwd;
  const active = mergedGrants(ctx);
  const reads: string[] = [];
  const writes: string[] = [];
  const blocked: string[] = [];

  for (const denial of denials) {
    const path = denial.path as string;
    const asRead = resolveFs({ policy, grants: active, op: "read", path, workspace });
    const asWrite = resolveFs({ policy, grants: active, op: "write", path, workspace });
    if (asRead.decision === "ask") reads.push(asRead.path);
    else if (asWrite.decision === "ask") writes.push(asWrite.path);
    else if (asRead.decision === "deny" || asWrite.decision === "deny") blocked.push(asRead.path);
  }

  logDenial(
    {
      tool: event.toolName,
      workspace,
      reads: unique(reads),
      writes: unique(writes),
      blocked: unique(blocked),
    },
    policy,
  );

  const notes: string[] = [];
  const blockedUnique = unique(blocked);
  if (blockedUnique.length > 0) {
    notes.push(`🚫 denied by policy, not grantable: ${blockedUnique.join(", ")}`);
  }

  for (const grant of [
    { op: "read" as const, paths: unique(reads) },
    { op: "write" as const, paths: unique(writes) },
  ]) {
    if (grant.paths.length === 0 || !ctx.hasUI) continue;
    if (grantCount >= policy.maxGrants) {
      notes.push(`🚫 grant limit reached (${policy.maxGrants} per session); ${grant.op} denial is final`);
      continue;
    }
    await offerGrant(ctx, grant.op, grant.paths, notes);
  }

  if (notes.length === 0) return undefined;
  return {
    content: [
      ...(Array.isArray(event.content) ? event.content : []),
      {
        type: "text",
        text: `\n\n[permissions] ${denials.length} sandbox denial${denials.length === 1 ? "" : "s"}; output may be incomplete\n${notes.map((note) => `- ${note}`).join("\n")}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---------- Intercept tool calls ----------
  pi.on("tool_call", async (event, ctx) => {
    const callGeneration = modeGeneration;
    const verdict = policyGate(event, ctx);

    if (verdict === "allow") return undefined;
    if (verdict && verdict !== "ask") return verdict;

    // Ask mode prompts for everything; sandbox mode only for the ask band.
    if (verdict === "ask" || currentMode === "ask") {
      const matched = verdict === "ask" ? destructiveMatch(event) : undefined;
      const level = verdict === "ask" ? (matched ? "destructive" : "outside") : "mode";
      const result = await promptForToolCall(pi, event, ctx, level, matched);
      if (modeGeneration !== callGeneration) {
        return {
          block: true,
          reason:
            "Permission mode changed while this tool call was being reviewed. Retry the call under the current mode.",
        };
      }
      return result;
    }

    return undefined;
  });

  // ---------- Sandbox denials → grant dialog ----------
  pi.on("tool_result", async (event, ctx) => handleSandboxDenials(event, ctx));

  // ---------- /permissions command ----------
  pi.registerCommand("permissions", {
    description: "Set permission mode: allow, sandbox, or ask (also: local, forget, policy)",
    getArgumentCompletions: (prefix: string) => {
      const modes = ["allow", "sandbox", "ask", "local", "forget", "policy"];
      const filtered = modes.filter((m) => m.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((m) => ({ value: m, label: m }))
        : null;
    },
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      const requested = migrateMode(arg);
      if (requested) {
        currentMode = requested;
        modeGeneration += 1;
        persistState(pi);
        updateStatus(ctx);
        refreshProfile(ctx);
        ctx.ui.notify(`Permission mode: ${modeLabel(currentMode)}`, "info");
      } else if (arg === "local") {
        // Resolve like the enforcement path does: exact folder, then ancestors,
        // with session-only grants merged in so this shows what is in force.
        const found = lookupFolderGrants(
          withSessionGrants(grants, ctx.cwd, { write: sessionWrites, read: sessionReads }),
          ctx.cwd,
        );
        ctx.ui.notify(
          found
            ? `${found.key}: ${JSON.stringify(found.grants)}`
            : `No local grants for ${ctx.cwd}`,
          "info",
        );
      } else if (arg === "forget") {
        const inherited = lookupFolderGrants(grants, ctx.cwd);
        const cleared = inherited ? clearFolderGrant(inherited.key) : false;
        grants = loadGrants();
        sessionWrites = [];
        sessionReads = [];
        refreshProfile(ctx);
        ctx.ui.notify(
          cleared
            ? `Cleared local grants for ${inherited?.key ?? ctx.cwd}`
            : `Nothing stored for ${ctx.cwd}`,
          "info",
        );
      } else if (arg === "policy") {
        ctx.ui.notify(`${describePolicy(policy, ctx.cwd)}\ngrants file: ${grantsFilePath()}`, "info");
      } else if (!arg) {
        ctx.ui.notify(
          `${modeLabel(currentMode)} · sandbox ${profileActive ? "on" : "off"} · grants ${grantCount}/${policy.maxGrants}\nUse /permissions allow|sandbox|ask|local|forget|policy`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Unknown argument "${arg}". Use: allow, sandbox, ask, local, forget, policy`,
          "error",
        );
      }
    },
  });

  // ---------- Restore branch-local state ----------
  pi.on("session_start", (_event, ctx) => {
    reconstructState(pi, ctx);
    loadPolicyState(ctx);
  });
  pi.on("session_tree", (_event, ctx) => reconstructState(pi, ctx));

  // ---------- F8 toggles permission modes ----------
  const modes: PermissionMode[] = ["ask", "sandbox", "allow"];
  pi.registerShortcut("f8", {
    description: "Cycle permission mode",
    handler: async (ctx) => {
      const idx = modes.indexOf(currentMode);
      currentMode = modes[(idx + 1) % modes.length];
      modeGeneration += 1;
      persistState(pi);
      updateStatus(ctx);
      refreshProfile(ctx);
      ctx.ui.notify(`Permissions: ${modeLabel(currentMode)}`, "info");
    },
  });
}

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

function updateStatus(ctx: ExtensionContext) {
  if (ctx.hasUI) {
    const label = modeEmoji(currentMode);
    ctx.ui.setStatus(
      "permissions",
      ctx.ui.theme?.fg
        ? ctx.ui.theme.fg(modeColor(currentMode), label)
        : label,
    );
  }
}
