/**
 * Custom Statusline Extension
 *
 * Replaces the default footer with a clean, single-line statusline showing:
 *   cwd (git branch) | ctx: percentage tokens/max | tok: up down | cost: $total
 *   | model think:level | other extension statuses
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
          let totalCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (
              entry.type === "message" &&
              entry.message.role === "assistant"
            ) {
              const m = entry.message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              totalCost += m.usage.cost.total;
            }
          }

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
          const dirDisplay = branch ? `${dir} (${branch})` : dir;

          // ----- model + thinking level -----
          const modelId = ctx.model?.id ?? "—";
          const reasoning = ctx.model?.reasoning;
          const thinkPart = reasoning
            ? currentThinkingLevel === "off"
              ? "think:off"
              : `think:${currentThinkingLevel}`
            : null;

          // ----- build segments -----
          const pipe = theme.fg("borderMuted", " │ ");
          const segments: string[] = [];

          // 1. Directory
          segments.push(theme.fg("dim", dirDisplay));

          // 2. Context window usage
          segments.push(theme.fg("dim", "ctx") + " " + ctxColored);

          // 3. Token I/O (and cache if present)
          if (totalInput > 0 || totalOutput > 0) {
            const io = `↑${fmt(totalInput)} ↓${fmt(totalOutput)}`;
            segments.push(
              theme.fg("dim", "tok") + " " + theme.fg("muted", io),
            );
          }

          // 4. Cost
          const sub =
            ctx.model &&
            ctx.modelRegistry?.isUsingOAuth?.(ctx.model)
              ? " (sub)"
              : "";
          segments.push(
            theme.fg("dim", "$") +
              " " +
              theme.fg("muted", totalCost.toFixed(3) + sub),
          );

          // 5. Model + thinking
          let modelSeg = theme.fg("accent", modelId);
          if (thinkPart) {
            modelSeg += " " + theme.fg("dim", thinkPart);
          }
          segments.push(modelSeg);

          // 6. Extension statuses (from ctx.ui.setStatus)
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const sorted = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b as string))
              .map(([, text]) => sanitize(text as string));
            segments.push(sorted.join("  "));
          }

          // ----- assemble & truncate -----
          const line = segments.join(pipe);
          return [truncateToWidth(line, width, theme.fg("dim", "…"))];
        },
      };
    });
  }
}
