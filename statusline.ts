/**
 * Custom Statusline Extension
 *
 * Replaces the default footer with a clean, three-line statusline:
 *   Line 1: cwd (git branch) · ctx · cumulative token I/O · subagent time
 *   Line 2: provider/model think:level · cost · provider limits
 *   Line 3: extension statuses such as permissions, todo, and thinking-tail.
 *
 * Toggle with /statusline
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const INR_RATE_URL = "https://open.er-api.com/v6/latest/USD";
const INR_RATE_REFRESH_MS = 6 * 60 * 60 * 1_000;
// Last fetched from ExchangeRate-API on 2026-08-28. The live refresh below replaces it.
let inrPerUsd = 95.592676;
let inrRateUpdatedAt = 0;
let inrRateRequest: Promise<void> | undefined;

function refreshInrRate(onUpdated: () => void): void {
  if (
    inrRateRequest ||
    Date.now() - inrRateUpdatedAt < INR_RATE_REFRESH_MS
  ) {
    return;
  }
  inrRateUpdatedAt = Date.now();
  inrRateRequest = fetch(INR_RATE_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`exchange-rate request failed: ${response.status}`);
      const data = (await response.json()) as { rates?: { INR?: unknown } };
      const rate = data.rates?.INR;
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        inrPerUsd = rate;
      }
    })
    .catch(() => {
      // Retain the last known rate when offline; the footer remains usable.
    })
    .finally(() => {
      inrRateRequest = undefined;
      onUpdated();
    });
}

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

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes.toString().padStart(2, "0")}m${seconds.toString().padStart(2, "0")}s`;
}

function formatInr(value: number): string {
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Collapse whitespace / control chars for single-line display */
function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type TokenRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<TokenRates & { inputTokensAbove: number }>;
};

type MessageUsage = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cacheWrite1h?: unknown;
};

type PricingModel = {
  provider?: unknown;
  id?: unknown;
  cost?: unknown;
};

let storedPricingModels: PricingModel[] | undefined;
let storedPricingLoadedAt = 0;
const STORED_PRICING_REFRESH_MS = 5 * 60 * 1_000;

/** Read Pi's persisted catalog when a provider alias hides the priced runtime model. */
function loadStoredPricingModels(): PricingModel[] {
  if (
    storedPricingModels &&
    Date.now() - storedPricingLoadedAt < STORED_PRICING_REFRESH_MS
  ) {
    return storedPricingModels;
  }

  storedPricingLoadedAt = Date.now();
  try {
    const path = join(homedir(), ".pi", "agent", "models-store.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      [provider: string]: { models?: unknown };
    };
    storedPricingModels = Object.entries(parsed).flatMap(([provider, value]) =>
      Array.isArray(value?.models)
        ? value.models.map((model) => ({
            ...(model && typeof model === "object" ? model : {}),
            provider,
          }))
        : [],
    );
  } catch {
    storedPricingModels = [];
  }
  return storedPricingModels;
}

function storedModelCost(provider: string, modelId: string): unknown {
  return loadStoredPricingModels().find(
    (model) => model.provider === provider && model.id === modelId,
  )?.cost;
}

/** Codex aliases inherit their API-equivalent price from the base provider. */
function baseProviderForAccount(provider: string): string | undefined {
  if (/^openai-codex-\d+$/.test(provider)) return "openai-codex";
  const match = provider.match(/^(.*)-account-\d+$/);
  return match?.[1];
}

function tokenRates(value: unknown): TokenRates | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const rates = {
    input: finiteNumber(record.input),
    output: finiteNumber(record.output),
    cacheRead: finiteNumber(record.cacheRead),
    cacheWrite: finiteNumber(record.cacheWrite),
  };
  if (Object.values(rates).every((rate) => rate === 0)) return undefined;

  const tiers = Array.isArray(record.tiers)
    ? record.tiers
        .map((tier) => {
          if (!tier || typeof tier !== "object") return undefined;
          const tierRecord = tier as Record<string, unknown>;
          return {
            input: finiteNumber(tierRecord.input),
            output: finiteNumber(tierRecord.output),
            cacheRead: finiteNumber(tierRecord.cacheRead),
            cacheWrite: finiteNumber(tierRecord.cacheWrite),
            inputTokensAbove: finiteNumber(tierRecord.inputTokensAbove),
          };
        })
        .filter((tier): tier is TokenRates & { inputTokensAbove: number } =>
          tier !== undefined,
        )
    : undefined;
  return { ...rates, ...(tiers?.length ? { tiers } : {}) };
}

/**
 * Price Codex account aliases from the canonical base-provider model when
 * their runtime catalog does not include pricing metadata.
 */
function baseModelApiPriceEstimate(message: AssistantMessage): number {
  const messageProvider = (message as any).provider;
  const modelId = (message as any).model;
  if (typeof messageProvider !== "string" || typeof modelId !== "string") return 0;

  const baseProvider = baseProviderForAccount(messageProvider) ?? messageProvider;
  const baseRates = tokenRates(storedModelCost(baseProvider, modelId));
  if (!baseRates) return 0;

  const usage = (message as any).usage as MessageUsage | undefined;
  if (!usage) return 0;
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  const cacheWrite1h = Math.min(finiteNumber(usage.cacheWrite1h), cacheWrite);
  const pricedInput = input + cacheRead + cacheWrite;

  let rates = baseRates;
  let threshold = -1;
  for (const tier of baseRates.tiers ?? []) {
    if (pricedInput > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rates = tier;
      threshold = tier.inputTokensAbove;
    }
  }

  return (
    (rates.input * input +
      rates.output * output +
      rates.cacheRead * cacheRead +
      rates.cacheWrite * (cacheWrite - cacheWrite1h) +
      rates.input * 2 * cacheWrite1h) /
    1_000_000
  );
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
  const record = message as {
    role?: string;
    toolName?: string;
    details?: unknown;
    usage?: { cost?: { total?: unknown } };
  };
  if (record.role !== "toolResult" || record.toolName !== "subagent") return 0;
  const reportedToolCost = finiteNumber(record.usage?.cost?.total);
  return reportedToolCost > 0 ? reportedToolCost : subagentCostFromDetails(record.details);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentThinkingLevel = "off";
  let enabled = true;
  let rupeesEnabled = false;
  const activeSubagents = new Map<string, number>();
  let subagentStartedAt: number | undefined;
  let lastSubagentDurationMs: number | undefined;
  let subagentTicker: ReturnType<typeof setInterval> | undefined;
  let requestFooterRender: (() => void) | undefined;

  function stopSubagentTicker(): void {
    if (subagentTicker) clearInterval(subagentTicker);
    subagentTicker = undefined;
  }

  function ensureSubagentTicker(): void {
    if (!enabled || !requestFooterRender || subagentStartedAt === undefined || subagentTicker) return;
    subagentTicker = setInterval(() => requestFooterRender?.(), 1_000);
  }

  function selectLatestRunningSubagent(): void {
    subagentStartedAt = [...activeSubagents.values()].at(-1);
  }

  function resetSubagentTime(): void {
    activeSubagents.clear();
    subagentStartedAt = undefined;
    lastSubagentDurationMs = undefined;
    stopSubagentTicker();
  }

  // Restart the displayed timer whenever a new subagent tool starts. When
  // calls overlap, display the most recently started call that is still active.
  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "subagent") return;
    const startedAt = Date.now();
    activeSubagents.delete(event.toolCallId);
    activeSubagents.set(event.toolCallId, startedAt);
    subagentStartedAt = startedAt;
    lastSubagentDurationMs = 0;
    stopSubagentTicker();
    ensureSubagentTicker();
    requestFooterRender?.();
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "subagent") return;
    const startedAt = activeSubagents.get(event.toolCallId);
    if (startedAt === undefined) return;
    lastSubagentDurationMs = Math.max(0, Date.now() - startedAt);
    activeSubagents.delete(event.toolCallId);
    selectLatestRunningSubagent();
    if (activeSubagents.size === 0) stopSubagentTicker();
    requestFooterRender?.();
  });

  // ---- track thinking level changes ----
  pi.on("thinking_level_select", (event) => {
    currentThinkingLevel = event.level;
  });

  // ---- enable custom footer on every session start ----
  pi.on("session_start", (_event, ctx) => {
    currentThinkingLevel = pi.getThinkingLevel();
    resetSubagentTime();
    if (enabled) installFooter(ctx);
  });

  pi.on("session_shutdown", () => {
    resetSubagentTime();
    requestFooterRender = undefined;
  });

  pi.registerCommand("rupees", {
    description: "Use INR or USD for costs with /rupees on|off",
    getArgumentCompletions: (prefix) => {
      const options = [
        { value: "on", label: "on", description: "Show costs in INR" },
        { value: "off", label: "off", description: "Show costs in USD" },
      ];
      const normalized = prefix.trim().toLowerCase();
      return options.filter((option) => option.value.startsWith(normalized));
    },
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice !== "on" && choice !== "off") {
        ctx.ui.notify("Usage: /rupees on|off", "warning");
        return;
      }
      rupeesEnabled = choice === "on";
      if (rupeesEnabled) refreshInrRate(() => requestFooterRender?.());
      requestFooterRender?.();
      ctx.ui.notify(`Cost currency set to ${rupeesEnabled ? "INR" : "USD"}`, "info");
    },
  });

  // ---- toggle command ----
  pi.registerCommand("statusline", {
    description: "Toggle custom statusline",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        installFooter(ctx);
        ensureSubagentTicker();
        ctx.ui.notify("Custom statusline enabled", "info");
      } else {
        stopSubagentTicker();
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });

  // ---- install the custom footer component ----
  function installFooter(ctx: any) {
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      // Re-render on git branch changes and once per second while a subagent runs.
      const renderFooter = () => tui.requestRender();
      requestFooterRender = renderFooter;
      ensureSubagentTicker();
      const unsub = footerData.onBranchChange(renderFooter);

      return {
        dispose() {
          unsub();
          stopSubagentTicker();
          if (requestFooterRender === renderFooter) requestFooterRender = undefined;
        },
        invalidate() {},

        render(width: number): string[] {
          if (rupeesEnabled) refreshInrRate(() => tui.requestRender());

          // ----- cumulative token and cost stats -----
          let totalInput = 0;
          let totalOutput = 0;
          let baseCost = 0;
          let estimatedModelCost = 0;
          let subagentCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "message") continue;
            if (entry.message.role === "assistant") {
              const m = entry.message as AssistantMessage;
              totalInput += finiteNumber(m.usage.input);
              totalOutput += finiteNumber(m.usage.output);
              const recordedCost = finiteNumber(m.usage.cost?.total);
              baseCost += recordedCost;
              // Only estimate a price when the response did not record one;
              // a real response cost remains authoritative.
              if (recordedCost === 0) {
                estimatedModelCost += baseModelApiPriceEstimate(m);
              }
            } else {
              subagentCost += subagentCostFromToolResult(entry.message);
            }
          }
          const totalCost = baseCost + estimatedModelCost + subagentCost;

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
          const modelSource = ctx.model?.provider;
          const modelDisplay = modelSource ? `${modelSource}/${modelId}` : modelId;
          const reasoning = ctx.model?.reasoning;
          const thinkPart = reasoning
            ? currentThinkingLevel === "off"
              ? "think:off"
              : `think:${currentThinkingLevel}`
            : null;

          // ----- build free-flowing segments (no column alignment) -----
          const sep = theme.fg("borderMuted", " \u00b7 ");

          const dirSeg = theme.fg("dim", dirDisplay);

          let modelSeg = theme.fg("success", modelDisplay);
          if (thinkPart) {
            modelSeg += " " + theme.fg("dim", thinkPart);
          }

          const ctxSeg = theme.fg("dim", "ctx") + " " + ctxColored;

          let tokSeg = "";
          if (totalInput > 0 || totalOutput > 0) {
            const io = `↑${fmt(totalInput)} ↓${fmt(totalOutput)}`;
            tokSeg = theme.fg("dim", "tok") + " " + theme.fg("muted", io);
          }

          let subagentTimeSeg = "";
          const subagentDuration = subagentStartedAt !== undefined
            ? Date.now() - subagentStartedAt
            : lastSubagentDurationMs;
          if (subagentDuration !== undefined) {
            const value = formatDuration(subagentDuration);
            subagentTimeSeg = theme.fg("dim", "sub") + " " + theme.fg(
              subagentStartedAt !== undefined ? "accent" : "muted",
              value,
            );
          }

          const sub =
            ctx.model &&
            ctx.modelRegistry?.isUsingOAuth?.(ctx.model)
              ? " (sub)"
              : "";
          const costSymbol = rupeesEnabled ? "₹" : "$";
          const costValue = rupeesEnabled
            ? formatInr(totalCost * inrPerUsd)
            : totalCost.toFixed(3);
          const costSeg =
            theme.fg("dim", costSymbol) +
            " " +
            theme.fg("muted", costValue + sub);

          const statuses: ReadonlyMap<string, string> =
            footerData.getExtensionStatuses();
          const providerStatusText = statuses.get("provider-status");
          const limitsSeg = providerStatusText ? sanitize(providerStatusText) : "";

          const sortedStatuses = Array.from(statuses.entries())
            .filter(([key]) => key !== "provider-status")
            .sort(([a], [b]) => {
              if (a === "permissions") return -1;
              if (b === "permissions") return 1;
              return a.localeCompare(b);
            })
            .map(([, text]) => sanitize(text))
            .filter(Boolean);

          // Line 1: cwd · ctx · cumulative token I/O · current/last subagent time
          const line1 = [dirSeg, ctxSeg, tokSeg, subagentTimeSeg]
            .filter(Boolean)
            .join(sep);

          // Line 2: provider/model spec · cost · provider limits
          const line2 = [modelSeg, costSeg, limitsSeg]
            .filter(Boolean)
            .join(sep);

          // Line 3 is reserved for statuses supplied by other extensions.
          const externalStatusPrefix = theme.fg("dim", "🧩:");
          const line3 = sortedStatuses.length > 0
            ? externalStatusPrefix + " " + sortedStatuses.join(sep)
            : externalStatusPrefix;

          return [
            truncateToWidth(line1, width, theme.fg("dim", "…")),
            truncateToWidth(line2, width, theme.fg("dim", "…")),
            truncateToWidth(line3, width, theme.fg("dim", "…")),
          ];
        },
      };
    });
  }
}
