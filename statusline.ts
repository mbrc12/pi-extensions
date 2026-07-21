/**
 * Custom Statusline Extension
 *
 * Replaces the default footer with a clean, two-line statusline:
 *   Line 1: cwd (git branch) | ctx: percentage tokens/max | tok: up down
 *   Line 2: model think:level | cost: $total | other extension statuses
 *
 * Toggle with /statusline
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Replace $HOME with ~ */
function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const isInside =
    rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
  return isInside ? (rel === "" ? "~" : `~${sep}${rel}`) : cwd;
}

/** Truncate from the start, keeping the rightmost part visible */
function truncateStartToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  const ellipsis = "…";
  if (maxWidth <= ellipsis.length) return ellipsis.slice(0, maxWidth);
  return ellipsis + text.slice(-(maxWidth - ellipsis.length));
}

/**
 * Fit a path into maxWidth by shortening leading directory names to initials
 * first, then left-truncating if it still does not fit.
 */
function compressPathToWidth(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (path.length <= maxWidth) return path;

  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(separator);
  if (parts.length <= 1) return truncateStartToWidth(path, maxWidth);

  const compressed = [...parts];
  const start = compressed[0] === "" || compressed[0] === "~" ? 1 : 0;

  for (let i = start; i < compressed.length - 1; i++) {
    const part = compressed[i];
    if (
      !part ||
      part === "." ||
      part === ".." ||
      part.startsWith(".")
    ) {
      continue;
    }

    compressed[i] = part[0];
    const candidate = compressed.join(separator);
    if (candidate.length <= maxWidth) return candidate;
  }

  return truncateStartToWidth(compressed.join(separator), maxWidth);
}

/** Fit cwd plus optional branch into a given width */
function fitDirDisplay(dir: string, branch: string | null, maxWidth: number): string {
  const suffix = branch ? ` (${branch})` : "";
  const display = dir + suffix;
  if (maxWidth <= 0) return "";
  if (display.length <= maxWidth) return display;

  const dirMax = maxWidth - suffix.length;
  if (dirMax <= 0) return truncateStartToWidth(display, maxWidth);
  return compressPathToWidth(dir, dirMax) + suffix;
}

/** Compact token/count formatting */
function fmt(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** Collapse whitespace / control chars for single-line display */
function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function subagentCostFromDetails(details: unknown): number {
  if (!details || typeof details !== "object") return 0;
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return 0;

  let cost = 0;
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const record = result as { exitCode?: unknown; usage?: { cost?: unknown } };
    // The subagent extension uses exitCode -1 for in-flight partial updates.
    // Stored tool-result entries should be final, but keep this guard so
    // transient/partial details never inflate session cost.
    if (record.exitCode === -1) continue;
    cost += finiteNumber(record.usage?.cost);
  }
  return cost;
}

function subagentCostFromToolResult(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const record = message as { role?: string; toolName?: string; details?: unknown };
  if (record.role !== "toolResult" || record.toolName !== "subagent") return 0;
  return subagentCostFromDetails(record.details);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentThinkingLevel = "off";
  let enabled = true;

  // ---- track thinking level changes ----
  pi.on("thinking_level_select", (event) => {
    currentThinkingLevel = event.level;
  });

  // ---- enable custom footer on every session start ----
  pi.on("session_start", (_event, ctx) => {
    currentThinkingLevel = pi.getThinkingLevel();
    if (enabled) installFooter(ctx);
  });

  // ---- toggle command ----
  pi.registerCommand("statusline", {
    description: "Toggle custom statusline",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        installFooter(ctx);
        ctx.ui.notify("Custom statusline enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });

  // ---- install the custom footer component ----
  function installFooter(ctx: any) {
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      // Re-render on git branch changes
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},

        render(width: number): string[] {
          // ----- cumulative token / cost stats -----
          let totalInput = 0;
          let totalOutput = 0;
          let baseCost = 0;
          let subagentCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "message") continue;
            if (entry.message.role === "assistant") {
              const m = entry.message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              baseCost += m.usage.cost.total;
            } else {
              subagentCost += subagentCostFromToolResult(entry.message);
            }
          }
          const totalCost = baseCost + subagentCost;

          // ----- current context usage -----
          const ctxUsage = ctx.getContextUsage();
          const ctxPct =
            ctxUsage?.percent !== null && ctxUsage?.percent !== undefined
              ? `${ctxUsage.percent.toFixed(0)}%`
              : "?%";
          const ctxTok =
            ctxUsage?.tokens !== null && ctxUsage?.tokens !== undefined
              ? fmt(ctxUsage.tokens)
              : "?";
          const ctxWin = fmt(ctxUsage?.contextWindow ?? 0);

          // Colour the context segment by usage level
          let ctxColored: string;
          if ((ctxUsage?.percent ?? 0) > 90) {
            ctxColored = theme.fg("error", `${ctxPct} ${ctxTok}/${ctxWin}`);
          } else if ((ctxUsage?.percent ?? 0) > 70) {
            ctxColored = theme.fg(
              "warning",
              `${ctxPct} ${ctxTok}/${ctxWin}`,
            );
          } else {
            ctxColored = `${ctxPct} ${ctxTok}/${ctxWin}`;
          }

          // ----- directory + git branch -----
          const dir = formatCwd(ctx.cwd);
          const branch = footerData.getGitBranch();
          const dirDisplay = fitDirDisplay(dir, branch, 20);

          // ----- model + thinking level -----
          const modelId = ctx.model?.id ?? "—";
          const reasoning = ctx.model?.reasoning;
          const thinkPart = reasoning
            ? currentThinkingLevel === "off"
              ? "think:off"
              : `think:${currentThinkingLevel}`
            : null;

          // ----- build column-aligned segments -----

          // Col 1: directory & model
          const col1_l1 = theme.fg("dim", dirDisplay);
          let modelSeg = theme.fg("success", modelId);
          if (thinkPart) {
            modelSeg += " " + theme.fg("dim", thinkPart);
          }
          const col1_l2 = modelSeg;

          // Col 2: context & cost
          const ctxSeg = theme.fg("dim", "ctx") + " " + ctxColored;
          const sub =
            ctx.model &&
            ctx.modelRegistry?.isUsingOAuth?.(ctx.model)
              ? " (sub)"
              : "";
          const costText = subagentCost > 0
            ? `${baseCost.toFixed(3)} + ${subagentCost.toFixed(3)} = ${totalCost.toFixed(3)}`
            : totalCost.toFixed(3);
          const costSeg =
            theme.fg("dim", "$") +
            " " +
            theme.fg("muted", costText + sub);

          // Col 3: token I/O & extension statuses
          let tokSeg = "";
          if (totalInput > 0 || totalOutput > 0) {
            const io = `↑${fmt(totalInput)} ↓${fmt(totalOutput)}`;
            tokSeg =
              theme.fg("dim", "tok") + " " + theme.fg("muted", io);
          }
          let statusSeg = "";
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const sorted = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b as string))
              .map(([, text]) => sanitize(text as string));
            // Separate extension status segments with a themed bar so they
            // don't run together on line 2.
            const statusPipe = theme.fg("borderMuted", " │ ");
            statusSeg = sorted.join(statusPipe);
          }

          // Visible-width helpers (strip ANSI escapes)
          const visLen = (s: string): number =>
            s.replace(/\x1b\[[0-9;]*m/g, "").length;
          const padVis = (s: string, w: number): string => {
            const vl = visLen(s);
            if (vl > w) return truncateToWidth(s, w, theme.fg("dim", "…"));
            return s + " ".repeat(w - vl);
          };

          // Columns as [line1, line2] pairs; drop empty columns
          const cols: [string, string][] = [
            [col1_l1, col1_l2],
            [ctxSeg, costSeg],
            [tokSeg, statusSeg],
          ].filter(([a, b]) => a || b);

          // Max visible width per column
          const maxW = cols.map(([a, b]) =>
            Math.max(visLen(a), visLen(b)),
          );

          // Use natural column widths, shrinking from the right only if needed.
          const pipeVis = 3; // visible width of " │ "
          const totalPipe = (cols.length - 1) * pipeVis;
          const colW = [...maxW];
          let overflow =
            colW.reduce((sum, w) => sum + w, 0) + totalPipe - width;
          for (let i = colW.length - 1; i >= 0 && overflow > 0; i--) {
            const shrink = Math.min(colW[i], overflow);
            colW[i] -= shrink;
            overflow -= shrink;
          }

          // Assemble lines with aligned pipes
          const pipe = theme.fg("borderMuted", " │ ");
          const line1 = cols.map(([a], i) => padVis(a, colW[i])).join(pipe);
          const line2 = cols.map(([, b], i) => padVis(b, colW[i])).join(pipe);

          return [
            truncateToWidth(line1, width, theme.fg("dim", "…")),
            truncateToWidth(line2, width, theme.fg("dim", "…")),
          ];
        },
      };
    });
  }
}
