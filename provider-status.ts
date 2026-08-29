import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "provider-status";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_REFRESH_MS = 5 * 60 * 1_000;
const DISPLAY_REFRESH_MS = 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10 * 1_000;

export type ProviderUsageWindow = {
  usedPercent: number;
  resetAt: number;
  windowSeconds?: number;
};

export type ProviderUsageSnapshot = {
  provider: string;
  fetchedAt: number;
  plan?: string;
  primary?: ProviderUsageWindow;
  secondary?: ProviderUsageWindow;
};

type ProviderAdapter = {
  supports(provider: string): boolean;
  fetch(provider: string, ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderUsageSnapshot>;
};

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function epochMs(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) return undefined;
  return number < 10_000_000_000 ? number * 1_000 : number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function parseWindow(value: unknown, fetchedAt: number): ProviderUsageWindow | undefined {
  const source = record(value);
  const used = finiteNumber(source.used_percent ?? source.utilization);
  if (used === undefined) return undefined;

  const resetAt = epochMs(source.reset_at ?? source.resets_at)
    ?? (() => {
      const seconds = finiteNumber(source.reset_after_seconds);
      return seconds === undefined ? undefined : fetchedAt + seconds * 1_000;
    })();
  if (resetAt === undefined) return undefined;

  const windowSeconds = finiteNumber(source.limit_window_seconds);
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    resetAt,
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  };
}

export function parseCodexUsageBody(
  provider: string,
  body: unknown,
  fetchedAt = Date.now(),
): ProviderUsageSnapshot {
  const source = record(body);
  const rateLimit = record(source.rate_limit);
  const primary = parseWindow(rateLimit.primary_window, fetchedAt);
  const secondary = parseWindow(rateLimit.secondary_window, fetchedAt);
  if (!primary && !secondary) {
    throw new Error("Codex usage response contains no limit windows");
  }

  return {
    provider,
    fetchedAt,
    plan: typeof source.plan_type === "string" ? source.plan_type : undefined,
    primary,
    secondary,
  };
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = record(payload["https://api.openai.com/auth"]);
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function isCodexProvider(provider: string): boolean {
  return provider === "openai-codex" || /^openai-codex-\d+$/.test(provider);
}

async function fetchCodexUsage(
  provider: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<ProviderUsageSnapshot> {
  const resolved = await ctx.modelRegistry.getProviderAuth(provider);
  const token = resolved?.auth.apiKey;
  if (!token) throw new Error(`${provider} has no resolved OAuth token`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const accountId = accountIdFromToken(token);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const response = await fetch(CODEX_USAGE_URL, { method: "GET", headers, signal });
  if (!response.ok) {
    throw new Error(`Codex usage endpoint returned HTTP ${response.status}`);
  }
  return parseCodexUsageBody(provider, await response.json());
}

const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  { supports: isCodexProvider, fetch: fetchCodexUsage },
];

function adapterFor(provider: string): ProviderAdapter | undefined {
  return PROVIDER_ADAPTERS.find((adapter) => adapter.supports(provider));
}

function formatDuration(resetAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

function windowLabel(
  window: ProviderUsageWindow,
  position: "primary" | "secondary",
): string {
  const seconds = window.windowSeconds;
  if (seconds === undefined) return position === "primary" ? "5h" : "7d";
  if (seconds >= 6 * 86_400) return "7d";
  if (seconds >= 20 * 3_600) return "24h";
  return `${Math.max(1, Math.round(seconds / 3_600))}h`;
}

function formatWindow(
  window: ProviderUsageWindow,
  position: "primary" | "secondary",
  now = Date.now(),
): string {
  const used = Math.round(window.usedPercent);
  const remaining = Math.max(0, 100 - used);
  return `${windowLabel(window, position)} ${used}% used/${remaining}%/${formatDuration(window.resetAt, now)}`;
}

export function formatProviderUsage(snapshot: ProviderUsageSnapshot, now = Date.now()): string {
  const windows = [
    snapshot.primary ? formatWindow(snapshot.primary, "primary", now) : undefined,
    snapshot.secondary ? formatWindow(snapshot.secondary, "secondary", now) : undefined,
  ].filter((value): value is string => Boolean(value));
  return [snapshot.plan, ...windows].filter(Boolean).join(" · ");
}

function formatCompactUsage(snapshot: ProviderUsageSnapshot, now = Date.now()): string {
  return [
    snapshot.primary
      ? `${windowLabel(snapshot.primary, "primary")} ${Math.max(0, Math.round(100 - snapshot.primary.usedPercent))}%/${formatDuration(snapshot.primary.resetAt, now)}`
      : undefined,
    snapshot.secondary
      ? `${windowLabel(snapshot.secondary, "secondary")} ${Math.max(0, Math.round(100 - snapshot.secondary.usedPercent))}%/${formatDuration(snapshot.secondary.resetAt, now)}`
      : undefined,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

function usageColor(snapshot: ProviderUsageSnapshot): "success" | "warning" | "error" {
  const remaining = [snapshot.primary, snapshot.secondary]
    .filter((window): window is ProviderUsageWindow => Boolean(window))
    .map((window) => 100 - window.usedPercent);
  const lowest = remaining.length ? Math.min(...remaining) : 100;
  if (lowest <= 10) return "error";
  if (lowest <= 30) return "warning";
  return "success";
}

export default function (pi: ExtensionAPI) {
  const snapshots = new Map<string, ProviderUsageSnapshot>();
  const failures = new Map<string, string>();
  let currentCtx: ExtensionContext | undefined;
  let currentProvider: string | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let displayTimer: ReturnType<typeof setInterval> | undefined;
  let requestController: AbortController | undefined;
  let refreshSequence = 0;

  function clearTimers(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    if (displayTimer) clearInterval(displayTimer);
    refreshTimer = undefined;
    displayTimer = undefined;
  }

  function renderStatus(ctx: ExtensionContext): void {
    if (!currentProvider || !adapterFor(currentProvider)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const failure = failures.get(currentProvider);
    if (failure) {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "lim unavailable"));
      return;
    }
    const snapshot = snapshots.get(currentProvider);
    if (!snapshot) return;

    const prefix = ctx.ui.theme.fg("dim", "lim");
    const details = ctx.ui.theme.fg(usageColor(snapshot), formatCompactUsage(snapshot));
    ctx.ui.setStatus(STATUS_KEY, `${prefix} ${details}`);
  }

  async function refresh(ctx: ExtensionContext, force = false): Promise<boolean> {
    const provider = ctx.model?.provider;
    currentCtx = ctx;
    currentProvider = provider;
    if (!provider) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return false;
    }

    const adapter = adapterFor(provider);
    if (!adapter) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return false;
    }

    const cached = snapshots.get(provider);
    if (!force && cached && Date.now() - cached.fetchedAt < USAGE_REFRESH_MS) {
      renderStatus(ctx);
      return !failures.has(provider);
    }

    const sequence = ++refreshSequence;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, timeoutController.signal]);

    if (!cached) {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "lim loading…"));
    }

    try {
      const snapshot = await adapter.fetch(provider, ctx, signal);
      if (sequence !== refreshSequence || currentProvider !== provider) return false;
      snapshots.set(provider, snapshot);
      failures.delete(provider);
      renderStatus(ctx);
      return true;
    } catch (error) {
      if (controller.signal.aborted || sequence !== refreshSequence || currentProvider !== provider) return false;
      const message = timeoutController.signal.aborted
        ? "usage request timed out"
        : error instanceof Error ? error.message : String(error);
      failures.set(provider, message);
      renderStatus(ctx);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  function startSession(ctx: ExtensionContext): void {
    clearTimers();
    requestController?.abort();
    if (!ctx.hasUI) {
      currentCtx = undefined;
      currentProvider = undefined;
      return;
    }
    currentCtx = ctx;
    currentProvider = ctx.model?.provider;
    void refresh(ctx, false);
    refreshTimer = setInterval(() => {
      if (currentCtx) void refresh(currentCtx, true);
    }, USAGE_REFRESH_MS);
    displayTimer = setInterval(() => {
      if (currentCtx) renderStatus(currentCtx);
    }, DISPLAY_REFRESH_MS);
  }

  pi.on("session_start", (_event, ctx) => startSession(ctx));

  pi.on("model_select", (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentProvider = ctx.model?.provider;
    void refresh(ctx, false);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearTimers();
    requestController?.abort();
    requestController = undefined;
    currentCtx = undefined;
    currentProvider = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("provider-status", {
    description: "Refresh provider-specific usage limits",
    handler: async (_args, ctx) => {
      const refreshed = await refresh(ctx, true);
      const provider = ctx.model?.provider;
      const snapshot = provider ? snapshots.get(provider) : undefined;
      if (refreshed && snapshot) {
        ctx.ui.notify(`${provider}: ${formatProviderUsage(snapshot)}`, "info");
      } else if (!provider || !adapterFor(provider)) {
        ctx.ui.notify(`No limits adapter is available for ${provider ?? "the current provider"}`, "info");
      } else {
        ctx.ui.notify(`${provider}: ${failures.get(provider) ?? "lim unavailable"}`, "warning");
      }
    },
  });
}
