import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type Model } from "@earendil-works/pi-coding-agent";

export type ModelConfigPurpose =
  | "recapGeneration"
  | "webSummarization"
  | "permissionClassification"
  | "pythonWriteClassification";

export type ModelRef = readonly [provider: string, id: string];

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "model-config.json");

const DEFAULT_MODEL_CONFIG: Record<ModelConfigPurpose, string[]> = {
  recapGeneration: [
    "opencode-go/deepseek-v4-pro",
    "opencode-go/deepseek-v4-flash",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
  ],
  webSummarization: [
    "opencode-go/deepseek-v4-flash",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
  ],
  permissionClassification: [
    "opencode-go/deepseek-v4-flash",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
    "openai/gpt-4o-mini",
    "openai/gpt-4.1-mini",
    "anthropic/claude-haiku-3-5",
    "google/gemini-2.0-flash",
  ],
  pythonWriteClassification: [
    "opencode-go/deepseek-v4-flash",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.6",
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

export async function selectConfiguredModelWithAuth(
  ctx: { modelRegistry: any; model?: Model },
  purpose: ModelConfigPurpose,
  options: SelectConfiguredModelOptions = {},
): Promise<{ model: Model; auth: any } | undefined> {
  const available = typeof ctx.modelRegistry.getAvailable === "function"
    ? await ctx.modelRegistry.getAvailable()
    : [];

  for (const [provider, id] of getModelFallbacks(purpose)) {
    const model = (Array.isArray(available)
      ? available.find((item: any) => item.provider === provider && item.id === id)
      : undefined) ?? ctx.modelRegistry.find(provider, id);
    if (!model) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) return { model, auth };
  }

  if (options.fallbackToCurrent && ctx.model) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (auth.ok && auth.apiKey) return { model: ctx.model, auth };
  }

  if (options.fallbackToAnyAvailable && Array.isArray(available)) {
    for (const model of available) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok && auth.apiKey) return { model, auth };
    }
  }

  return undefined;
}
