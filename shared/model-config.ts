import * as fs from "node:fs";
import * as path from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type Model } from "@earendil-works/pi-coding-agent";

export type ModelConfigPurpose =
  | "recapGeneration"
  | "subagentProgressSummary"
  | "webSummarization"
  | "permissionClassification"
  | "pythonWriteClassification";

export type ModelRef = readonly [provider: string, id: string];

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "model-config.json");

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
  ],
  subagentProgressSummary: [
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.6-luna",
  ],
  webSummarization: [
    "opencode-go/deepseek-v4-flash",
    "openai-codex/gpt-5.6-luna",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
    "openai-codex/gpt-5.4-mini",
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

function loadRawConfig(): Partial<Record<ModelConfigPurpose, unknown[]>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getModelFallbacks(purpose: ModelConfigPurpose): ModelRef[] {
  const raw = loadRawConfig()[purpose];
  const configured = Array.isArray(raw)
    ? raw.map(parseModelRef).filter((item): item is ModelRef => Boolean(item))
    : [];
  const source = configured.length > 0 ? configured : DEFAULT_MODEL_CONFIG[purpose].map(parseModelRef);
  return source.filter((item): item is ModelRef => Boolean(item));
}

export interface SelectConfiguredModelOptions {
  fallbackToCurrent?: boolean;
  fallbackToAnyAvailable?: boolean;
}

export interface CompletionFallbackResult {
  response: any;
  model: Model;
  auth: any;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
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
  ctx: { modelRegistry: any; model?: Model },
  purpose: ModelConfigPurpose,
  options: SelectConfiguredModelOptions,
): Promise<Array<{ model: Model; auth: any }>> {
  const available = await getAvailableModels(ctx);
  const refs = [...getModelFallbacks(purpose)];
  const seen = new Set<string>();
  const candidates: Model[] = [];

  const add = (model: Model | undefined): void => {
    if (!model) return;
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
      if (auth.ok && auth.apiKey) usable.push({ model, auth });
    } catch {
      // An auth provider can fail independently of the model request. Try the next model.
    }
  }
  return usable;
}

export async function selectConfiguredModelWithAuth(
  ctx: { modelRegistry: any; model?: Model },
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
  ctx: { modelRegistry: any; model?: Model },
  purpose: ModelConfigPurpose,
  request: any,
  completionOptions: Record<string, any> = {},
  selectionOptions: SelectConfiguredModelOptions = {},
): Promise<CompletionFallbackResult> {
  const candidates = await getConfiguredModelsWithAuth(ctx, purpose, selectionOptions);
  let lastError: unknown;

  for (const { model, auth } of candidates) {
    if (completionOptions.signal?.aborted) {
      throw new Error("Model request was aborted");
    }
    try {
      const response = await complete(model, request, {
        ...completionOptions,
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
      });
      const failure = responseFailure(response);
      if (failure) throw failure;
      return { response, model, auth };
    } catch (error) {
      if (completionOptions.signal?.aborted) throw error;
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`No usable model available for ${purpose}`);
}
