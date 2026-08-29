/**
 * Custom Statusline Extension
 *
 * Replaces the default footer with a clean, two-line statusline:
 *   Line 1: cwd (git branch) · ctx · tok · think:emoji
 *   Line 2: provider/model think:level · cost · extension statuses
 *
 * The thinking-tail extension pushes a think:
 *   🤐 collapsed, 😮 expanded. It is surfaced on row 1 here.
 *
 * Toggle with /statusline
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

// Status key shared with the thinking-tail extension. Its value is rendered
// on row 1 of this statusline (excluded from the row-2 status block).
const THINK_STATUS_KEY = "thinking";

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
          refreshInrRate(() => tui.requestRender());

          // ----- cumulative token / cost stats -----
          let totalInput = 0;
          let totalOutput = 0;
          let baseCost = 0;
          let estimatedModelCost = 0;
          let subagentCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "message") continue;
            if (entry.message.role === "assistant") {
              const m = entry.message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
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

          const sub =
            ctx.model &&
            ctx.modelRegistry?.isUsingOAuth?.(ctx.model)
              ? " (sub)"
              : "";
          const costSeg =
            theme.fg("dim", "$") +
            " " +
            theme.fg("muted", totalCost.toFixed(3) + sub) +
            theme.fg("borderMuted", " · ") +
            theme.fg("dim", "₹") +
            " " +
            theme.fg("muted", formatInr(totalCost * inrPerUsd));

          let tokSeg = "";
          if (totalInput > 0 || totalOutput > 0) {
            const io = `↑${fmt(totalInput)} ↓${fmt(totalOutput)}`;
            tokSeg =
              theme.fg("dim", "tok") + " " + theme.fg("muted", io);
          }

          // Extension statuses on line 2 after core items.
          // Keep provider limits visible before other status items.
          const statuses: ReadonlyMap<string, string> =
            footerData.getExtensionStatuses();

          // The thinking-tail "think: <emoji>" status goes on row 1, so pull
          // it out and exclude it from the row-2 status block.
          const thinkStatusText = statuses.get(THINK_STATUS_KEY);
          let thinkSeg = "";
          if (thinkStatusText) {
            const clean = sanitize(thinkStatusText);
            const m = clean.match(/^(think:)\s+(.+)$/);
            if (m) {
              thinkSeg =
                theme.fg("dim", m[1]!) + " " + theme.fg("accent", m[2]!);
            } else {
              thinkSeg = theme.fg("accent", clean);
            }
          }

          const sortedStatuses = Array.from(statuses.entries())
            .filter(([key]) => key !== THINK_STATUS_KEY)
            .sort(([a], [b]) => {
              if (a === "provider-status") return -1;
              if (b === "provider-status") return 1;
              if (a === "permissions") return -1;
              if (b === "permissions") return 1;
              return a.localeCompare(b);
            })
            .map(([, text]) => sanitize(text))
            .filter(Boolean);

          // Line 1: dir · ctx · cost · tok · think
          const line1 = [dirSeg, ctxSeg, costSeg, tokSeg, thinkSeg]
            .filter(Boolean)
            .join(sep);

          // Line 2: provider/model · permissions · extra1 · extra2
          const line2Core = [modelSeg].filter(Boolean);
          let line2 = line2Core.join(sep);
          if (sortedStatuses.length > 0) {
            const statusBlock = sortedStatuses.join(sep);
            line2 = line2
              ? line2 + sep + statusBlock
              : statusBlock;
          }

          return [
            truncateToWidth(line1, width, theme.fg("dim", "…")),
            truncateToWidth(line2, width, theme.fg("dim", "…")),
          ];
        },
      };
    });
  }
}
