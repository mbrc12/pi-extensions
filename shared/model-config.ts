import * as fs from "node:fs";
import * as path from "node:path";
import type { Model as PiModel } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type Model = PiModel<any>;

export const MODEL_CONFIG_PURPOSES = [
  "recapGeneration",
  "toolSummaryGeneration",
  "subagentProgressSummary",
  "wiseCompacter",
  "webSummarization",
  "permissionClassification",
  "pythonWriteClassification",
] as const;
export type ModelConfigPurpose = typeof MODEL_CONFIG_PURPOSES[number];

export const SUBAGENT_CAPABILITIES = ["low", "medium", "high", "image"] as const;
export type SubagentCapability = typeof SUBAGENT_CAPABILITIES[number];
export type ModelRef = readonly [provider: string, id: string];
export interface ModelProfileConfig {
  allow: string[];
  defaultModel?: string;
}
export type ModelProfiles = Record<string, ModelProfileConfig>;

export const MODEL_PROFILE_ENV = "PI_MODEL_PROFILE";
export const DEFAULT_MODEL_PROFILE = "home";

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "model-config.json");
const DEFAULT_MODEL_PROFILES: ModelProfiles = {
  home: {
    allow: [".*"],
    defaultModel: "openai-codex/gpt-5.6-luna",
  },
  work: {
    allow: ["^openai-codex-2/.*$"],
    defaultModel: "openai-codex-2/gpt-5.6-sol",
  },
};
let activeModelProfile = process.env[MODEL_PROFILE_ENV] || DEFAULT_MODEL_PROFILE;
const SUBAGENT_CAPABILITY_FALLBACKS: Record<SubagentCapability, readonly SubagentCapability[]> = {
  low: ["low", "medium", "high"],
  medium: ["medium", "high", "low"],
  high: ["high", "low", "medium"],
  image: ["image"],
};

const DEFAULT_MODEL_CONFIG: Record<ModelConfigPurpose, string[]> = {
  recapGeneration: [
    // DeepSeek V4 Flash has the largest Go-plan allowance and is the lowest-cost
    // model listed by OpenCode for lightweight background requests.
    "opencode-go/deepseek-v4-flash",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.4-mini",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
    "opencode-go/deepseek-v4-pro",
    "openai-codex-2/gpt-5.6-luna",
  ],
  toolSummaryGeneration: [
    "opencode-go/deepseek-v4-flash",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.4-mini",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
    "opencode-go/deepseek-v4-pro",
    "openai-codex-2/gpt-5.6-luna",
  ],
  subagentProgressSummary: [
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.6-luna",
    "openai-codex-2/gpt-5.6-luna",
  ],
  wiseCompacter: [
    "opencode-go/deepseek-v4-flash",
    "opencode-go/mimo-v2.5",
    "openai-codex/gpt-5.6-luna",
    "openai-codex-2/gpt-5.6-luna",
  ],
  webSummarization: [
    "opencode-go/deepseek-v4-flash",
    "openai-codex/gpt-5.6-luna",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
    "openai-codex/gpt-5.4-mini",
    "openai-codex-2/gpt-5.6-luna",
  ],
  permissionClassification: [
    "opencode-go/deepseek-v4-flash",
    "openai-codex/gpt-5.6-luna",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
    "openai-codex/gpt-5.4-mini",
    "openai/gpt-4o-mini",
    "openai/gpt-4.1-mini",
    "anthropic/claude-haiku-3-5",
    "google/gemini-2.0-flash",
    "openai-codex-2/gpt-5.6-luna",
  ],
  pythonWriteClassification: [
    "opencode-go/deepseek-v4-flash",
    "openai-codex/gpt-5.6-luna",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
    "openai-codex/gpt-5.4-mini",
    "openai/gpt-4o-mini",
    "openai/gpt-4.1-mini",
    "anthropic/claude-haiku-3-5",
    "google/gemini-2.0-flash",
    "openai-codex-2/gpt-5.6-luna",
  ],
};

const DEFAULT_SUBAGENT_MODELS: Record<SubagentCapability, string[]> = {
  low: [
    "opencode-go/deepseek-v4-flash",
    "openai-codex/gpt-5.4-mini",
    "openai-codex-2/gpt-5.4-mini",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
  ],
  medium: [
    "openai-codex/gpt-5.6-luna",
    "openai-codex-2/gpt-5.6-luna",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/kimi-k2.6",
  ],
  high: [
    "openai-codex/gpt-5.6-sol",
    "openai-codex-2/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
    "openai-codex-2/gpt-5.6-terra",
  ],
  image: [
    "openai-codex-2/gpt-5.6-luna",
    "openai-codex/gpt-5.6-luna",
  ],
};

function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash > 0 && slash < value.length - 1) {
      return [value.slice(0, slash), value.slice(slash + 1)];
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as { provider?: unknown; id?: unknown };
    if (typeof record.provider === "string" && typeof record.id === "string") {
      return [record.provider, record.id];
    }
  }
  return undefined;
}

function loadRawConfig(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseModelRefs(raw: unknown, defaults: readonly string[]): ModelRef[] {
  const configured = Array.isArray(raw)
    ? raw.map(parseModelRef).filter((item): item is ModelRef => Boolean(item))
    : [];
  const source = configured.length > 0 ? configured : defaults.map(parseModelRef);
  return source.filter((item): item is ModelRef => Boolean(item));
}

export function getModelProfiles(): ModelProfiles {
  const raw = loadRawConfig().profiles;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_MODEL_PROFILES };
  }

  const profiles: ModelProfiles = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // Keep the original array form compatible with older configurations.
    const record = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    const rawAllow = Array.isArray(value) ? value : record?.allow;
    if (!Array.isArray(rawAllow)) continue;
    const allow = rawAllow.filter((pattern): pattern is string => typeof pattern === "string");
    if (allow.length === 0) continue;
    profiles[name] = {
      allow,
      ...(typeof record?.defaultModel === "string" ? { defaultModel: record.defaultModel } : {}),
    };
  }
  return Object.keys(profiles).length > 0 ? profiles : { ...DEFAULT_MODEL_PROFILES };
}

export function getProfileDefaultModel(name: string): ModelRef | undefined {
  return parseModelRef(getModelProfiles()[name]?.defaultModel);
}

export function getActiveModelProfile(): string {
  return process.env[MODEL_PROFILE_ENV] || activeModelProfile;
}

export function setActiveModelProfile(name: string): void {
  const profile = getModelProfiles()[name];
  if (!profile) throw new Error(`Unknown model profile: ${name}`);
  for (const pattern of profile.allow) new RegExp(pattern);

  activeModelProfile = name;
  process.env[MODEL_PROFILE_ENV] = name;
}

export function resetActiveModelProfile(): void {
  activeModelProfile = DEFAULT_MODEL_PROFILE;
  delete process.env[MODEL_PROFILE_ENV];
}

export function modelMatchesProfile(
  model: { provider: string; id: string },
  profile?: string,
): boolean {
  const config = getModelProfiles()[profile ?? getActiveModelProfile()];
  if (!config) return false;
  const key = `${model.provider}/${model.id}`;
  return config.allow.some((pattern) => {
    try {
      return new RegExp(pattern).test(key);
    } catch {
      return false;
    }
  });
}

export function getModelFallbacksForProfile(
  purpose: ModelConfigPurpose,
  profile: string,
): ModelRef[] {
  const raw = loadRawConfig()[purpose];
  return parseModelRefs(raw, DEFAULT_MODEL_CONFIG[purpose])
    .filter(([provider, id]) => modelMatchesProfile({ provider, id }, profile));
}

export function getModelFallbacks(purpose: ModelConfigPurpose): ModelRef[] {
  return getModelFallbacksForProfile(purpose, getActiveModelProfile());
}

export function getSubagentTierModels(
  capability: SubagentCapability,
  profile: string,
): ModelRef[] {
  const rawConfig = loadRawConfig();
  return parseModelRefs(
    (rawConfig.subagentModels as Record<string, unknown> | undefined)?.[capability],
    DEFAULT_SUBAGENT_MODELS[capability],
  ).filter(([provider, id]) => modelMatchesProfile({ provider, id }, profile));
}

/**
 * Return subagent model candidates in configured fallback order.
 * The image tier uses only its image-capable models. Duplicate models are skipped.
 */
export function getSubagentModelFallbacks(capability: SubagentCapability): ModelRef[] {
  const candidates: ModelRef[] = [];
  const seen = new Set<string>();

  for (const tier of SUBAGENT_CAPABILITY_FALLBACKS[capability]) {
    for (const model of getSubagentTierModels(tier, getActiveModelProfile())) {
      const key = `${model[0]}/${model[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(model);
    }
  }

  return candidates;
}

export interface SelectConfiguredModelOptions {
  fallbackToCurrent?: boolean;
  fallbackToAnyAvailable?: boolean;
  /**
   * Report a candidate that could not be used: no usable auth, a rejected request,
   * or a response that carried an error or no text. Diagnostics only.
   */
  onCandidateFailure?: (modelKey: string, error: Error) => void;
  /**
   * Ask OpenCode-hosted models to answer without reasoning. Pi's OpenAI-style branch
   * sends `thinkingLevelMap[effort] ?? effort`, so "none" reaches the gateway, which
   * accepts it for mimo and deepseek and returns no reasoning at all.
   *
   * Keep this scoped to OpenCode hosts. Other providers reject the value, and
   * OpenCode's own minimax-m2.7 and glm-5.3 answer 500 and 400 for it, so do not
   * enable this for a purpose list that contains them.
   */
  disableReasoning?: boolean;
}

export interface CompletionFallbackResult {
  response: any;
  model: Model;
  auth: any;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Extension-facing model access. `sessionManager` is optional for legacy callers. */
export interface ModelCompletionContext {
  modelRegistry: any;
  model?: Model;
  sessionManager?: { getSessionId?: () => string };
}

const OPENCODE_SESSION_HOST = "opencode.ai";

function isOpencodeHosted(model: { provider?: unknown; baseUrl?: unknown }): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") return true;
  if (typeof model.baseUrl !== "string") return false;
  try {
    return new URL(model.baseUrl).hostname === OPENCODE_SESSION_HOST;
  } catch {
    return false;
  }
}

/**
 * Pi adds these headers for OpenCode-hosted models inside its own stream wrapper,
 * but extensions call the model registry directly and bypass that wrapper. Without
 * them the OpenCode gateway rejects the request with "MissingSessionID". Mirror
 * pi's rule: the opencode/opencode-go providers, or an opencode.ai base URL.
 */
function opencodeSessionHeaders(
  model: { provider?: unknown; baseUrl?: unknown },
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (!sessionId || !isOpencodeHosted(model)) return undefined;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

function completionSessionId(ctx: ModelCompletionContext): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Add the session headers on top of any header transform the caller already uses. */
function withSessionHeaders(
  completionOptions: Record<string, any>,
  sessionHeaders: Record<string, string> | undefined,
): Record<string, any> {
  if (!sessionHeaders) return completionOptions;
  const existing = completionOptions.transformHeaders;
  return {
    ...completionOptions,
    transformHeaders: async (headers: Record<string, string> | undefined) => {
      const base = typeof existing === "function" ? await existing(headers) : headers;
      return { ...(base ?? {}), ...sessionHeaders };
    },
  };
}

async function getAvailableModels(ctx: { modelRegistry: any }): Promise<any[]> {
  try {
    const available = typeof ctx.modelRegistry.getAvailable === "function"
      ? await ctx.modelRegistry.getAvailable()
      : [];
    return Array.isArray(available) ? available : [];
  } catch {
    return [];
  }
}

async function getConfiguredModelsWithAuth(
  ctx: ModelCompletionContext,
  purpose: ModelConfigPurpose,
  options: SelectConfiguredModelOptions,
): Promise<Array<{ model: Model; auth: any }>> {
  const available = await getAvailableModels(ctx);
  const refs = [...getModelFallbacks(purpose)];
  const seen = new Set<string>();
  const candidates: Model[] = [];

  const add = (model: Model | undefined): void => {
    if (!model || !modelMatchesProfile(model)) return;
    const key = modelKey(model);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  for (const [provider, id] of refs) {
    try {
      const model = available.find((item: any) => item.provider === provider && item.id === id)
        ?? ctx.modelRegistry.find(provider, id);
      add(model);
    } catch {
      // A stale provider/model registry entry should not prevent later fallbacks.
    }
  }
  if (options.fallbackToCurrent) add(ctx.model);
  if (options.fallbackToAnyAvailable) {
    for (const model of available) add(model);
  }

  const usable: Array<{ model: Model; auth: any }> = [];
  for (const model of candidates) {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok) {
        usable.push({ model, auth });
      } else {
        options.onCandidateFailure?.(
          modelKey(model),
          new Error(
            typeof auth.error === "string" && auth.error
              ? `no usable auth: ${auth.error}`
              : "no usable auth",
          ),
        );
      }
    } catch (error) {
      // An auth provider can fail independently of the model request. Try the next model.
      options.onCandidateFailure?.(modelKey(model), toError(error));
    }
  }
  return usable;
}

export async function selectConfiguredModelWithAuth(
  ctx: ModelCompletionContext,
  purpose: ModelConfigPurpose,
  options: SelectConfiguredModelOptions = {},
): Promise<{ model: Model; auth: any } | undefined> {
  return (await getConfiguredModelsWithAuth(ctx, purpose, options))[0];
}

function responseHasText(response: any): boolean {
  return Array.isArray(response?.content)
    && response.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
}

function responseFailure(response: any): Error | undefined {
  if (response?.stopReason === "error") {
    return new Error(response.errorMessage || "Model returned an error");
  }
  if (response?.stopReason === "aborted") {
    return new Error(response.errorMessage || "Model request was aborted");
  }
  if (!responseHasText(response)) return new Error("Model returned no text");
  return undefined;
}

/**
 * Complete a text request against the configured models in order.
 * A provider capacity/error response is represented by pi-ai as either a thrown
 * error or an assistant response with stopReason="error"; both advance to the
 * next model. A caller abort is never retried.
 */
export async function completeWithModelFallback(
  ctx: ModelCompletionContext,
  purpose: ModelConfigPurpose,
  request: any,
  completionOptions: Record<string, any> = {},
  selectionOptions: SelectConfiguredModelOptions = {},
): Promise<CompletionFallbackResult> {
  const candidates = await getConfiguredModelsWithAuth(ctx, purpose, selectionOptions);
  const sessionId = completionSessionId(ctx);
  let lastError: unknown;

  for (const { model, auth } of candidates) {
    if (completionOptions.signal?.aborted) {
      throw new Error("Model request was aborted");
    }
    try {
      const requestOptions = {
        ...withSessionHeaders(completionOptions, opencodeSessionHeaders(model, sessionId)),
      };
      if (selectionOptions.disableReasoning && isOpencodeHosted(model)) {
        requestOptions.reasoningEffort = "none";
      }
      const response = await ctx.modelRegistry.complete(model, request, requestOptions);
      const failure = responseFailure(response);
      if (failure) throw failure;
      return { response, model, auth };
    } catch (error) {
      if (completionOptions.signal?.aborted) throw error;
      lastError = error;
      selectionOptions.onCandidateFailure?.(modelKey(model), toError(error));
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`No usable model available for ${purpose}`);
}
