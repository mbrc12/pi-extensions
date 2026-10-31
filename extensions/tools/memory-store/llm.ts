/**
 * In-process LLM calls for the memory-store extension.
 *
 * All model calls go through pi's modelRegistry via completeSimple() — the
 * same mechanism pi-hermes-memory uses for its "direct" transport. There are
 * no subprocesses: nothing to strip auth adapters, nothing to fork-storm,
 * nothing to time out on child boot. Auth is resolved the same way pi
 * resolves it for the main session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, type Message } from "@earendil-works/pi-ai/compat";
import type { MemoryStoreConfig } from "./config.js";

// ─── Operation types ───

export type MemoryOperationAction = "add" | "remove" | "replace";

export interface MemoryOperation {
  action: MemoryOperationAction;
  content?: string;
  old_text?: string;
}

export interface OperationPlan {
  operations: MemoryOperation[];
}

export interface LlmResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  /** Model that produced a successful response, when available. */
  modelReference?: string;
  /** True when a configured fallback or the session model handled the call. */
  fallbackModelUsed?: boolean;
  /** Reason the call failed or produced nothing (for diagnostics/fallback). */
  fallbackReason?: "no_model" | "no_auth" | "aborted" | "parse_error" | "provider_error" | "empty";
}

// ─── Model + auth resolution ───

type ModelRegistry = ExtensionContext["modelRegistry"];

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmed = modelReference.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();

  const canonical = availableModels.filter(
    (m) => `${m.provider}/${m.id}`.toLowerCase() === normalized,
  );
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmed.slice(0, slashIndex).trim();
    const modelId = trimmed.slice(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (m) => m.provider.toLowerCase() === provider.toLowerCase()
          && m.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
    }
  }

  const idMatches = availableModels.filter((m) => m.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

interface ResolvedModel {
  model: Model<Api>;
  isFallback: boolean;
}

/** Resolve the primary, configured fallback, and session models in priority order. */
function resolveModels(
  ctxModel: Model<Api> | undefined,
  modelRegistry: ModelRegistry,
  config: MemoryStoreConfig,
): ResolvedModel[] {
  const available = modelRegistry.getAll();
  const references = [config.model, ...config.fallbackModels];
  const resolved: ResolvedModel[] = [];
  const seen = new Set<string>();

  for (const [referenceIndex, reference] of references.entries()) {
    const model = findExactModelReferenceMatch(reference, available);
    if (!model) continue;
    const key = `${model.provider}/${model.id}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({ model, isFallback: referenceIndex > 0 });
    }
  }

  if (ctxModel) {
    const key = `${ctxModel.provider}/${ctxModel.id}`.toLowerCase();
    if (!seen.has(key)) resolved.push({ model: ctxModel, isFallback: true });
  }
  return resolved;
}

async function resolveAuth(modelRegistry: ModelRegistry, model: Model<Api>): Promise<
  { ok: true; apiKey: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string }
> {
  try {
    modelRegistry.authStorage?.reload();
  } catch {
    // A malformed auth.json must not take the memory path down.
  }
  const auth = modelRegistry.getApiKeyAndHeaders(model);
  if (!auth) return { ok: false, error: `No auth resolved for ${model.provider}/${model.id}` };
  return { ok: true, apiKey: auth.apiKey ?? "", headers: auth.headers, env: auth.env };
}

// ─── Core call ───

interface CompleteOptions {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxTokens?: number;
}

async function completeOnce(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: MemoryStoreConfig,
  options: CompleteOptions,
): Promise<LlmResult<string>> {
  const models = resolveModels(ctx.model, ctx.modelRegistry, config);
  if (models.length === 0) return { ok: false, fallbackReason: "no_model", error: "No model available for memory calls" };

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: options.userPrompt }],
    timestamp: Date.now(),
  };

  try {
    let lastFailure: LlmResult<string> | undefined;
    for (const { model, isFallback } of models) {
      const auth = await resolveAuth(ctx.modelRegistry, model);
      if (!auth.ok) {
        lastFailure = { ok: false, fallbackReason: "no_auth", error: auth.error };
        continue;
      }

      try {
        const response = await completeSimple(
          model,
          { systemPrompt: options.systemPrompt, messages: [userMessage] },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            signal: controller.signal,
            // Rerank/review prompts need structured text, not model reasoning.
            reasoning: "off",
            ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
          },
        );

        if (response.stopReason === "aborted") {
          return { ok: false, fallbackReason: "aborted", error: "Model call aborted" };
        }

        const text = extractText(response.content);
        if (!text?.trim()) {
          lastFailure = {
            ok: false,
            fallbackReason: "empty",
            error: `Empty model response from ${model.provider}/${model.id} (stop reason: ${response.stopReason})`,
          };
          continue;
        }
        return {
          ok: true,
          value: text,
          modelReference: `${model.provider}/${model.id}`,
          fallbackModelUsed: isFallback,
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, fallbackReason: "aborted", error: "Model call aborted" };
        }
        lastFailure = {
          ok: false,
          fallbackReason: "provider_error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return lastFailure ?? { ok: false, fallbackReason: "no_model", error: "No usable model available for memory calls" };
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "text"
    ))
    .map((block) => block.text)
    .join("\n");
}

// ─── JSON parsing ───

/** Extract a JSON object from model output, tolerating fences and prose. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function parseOperationPlan(text: string): OperationPlan | null {
  if (/nothing to save/i.test(text) && !text.includes("{")) {
    return { operations: [] };
  }
  const payload = extractJsonObject(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const ops = (payload as { operations?: unknown }).operations;
  if (!Array.isArray(ops)) return null;

  const operations: MemoryOperation[] = [];
  for (const item of ops) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    if (op.action !== "add" && op.action !== "remove" && op.action !== "replace") continue;
    const operation: MemoryOperation = { action: op.action };
    if (typeof op.content === "string") operation.content = op.content;
    if (typeof op.old_text === "string") operation.old_text = op.old_text;
    operations.push(operation);
  }
  return { operations };
}

/** Extract a JSON array (e.g. rerank ids) from model output. */
function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // continue
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

// ─── Public API ───

export interface LlmOps {
  /** Ask the model for memory operations (review/correction/flush). */
  runOps(
    ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
    config: MemoryStoreConfig,
    options: CompleteOptions,
  ): Promise<LlmResult<OperationPlan>>;
  /** Rerank candidate ids: minimal output — a JSON array of numbers. */
  rerank(
    ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
    config: MemoryStoreConfig,
    query: string,
    candidates: { id: number; content: string }[],
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<LlmResult<number[]>>;
}

export function createLlm(): LlmOps {
  return {
    async runOps(ctx, config, options) {
      const result = await completeOnce(ctx, config, options);
      if (!result.ok || result.value === undefined) return result as LlmResult<OperationPlan>;

      const plan = parseOperationPlan(result.value);
      if (plan === null) {
        return { ok: false, fallbackReason: "parse_error", error: "Model response was not a valid operations plan" };
      }
      return {
        ok: true,
        value: plan,
        modelReference: result.modelReference,
        fallbackModelUsed: result.fallbackModelUsed,
      };
    },

    async rerank(ctx, config, query, candidates, maxResults, signal) {
      const systemPrompt = `You select memory blurbs that directly help answer a search query.

Be strict: keyword overlap alone is not enough. A blurb is relevant only when it
contains a durable fact, preference, convention, or environment detail that the
agent could use to answer or act on this query. Do not return entries merely
because they share a generic word, a year, a model name, or a project-adjacent
term. If the store has no direct answer, return an empty array.

Return a JSON array of the ids most relevant to the query, ranked best first.
Rules:
- Return at most ${maxResults} ids.
- Only include blurbs genuinely relevant to the query.
- Output ONLY a JSON array of numbers, e.g. [7, 3, 12]. No other text, no explanations.
- If none are relevant, return [].`;

      const userPrompt = [
        `Query: ${query}`,
        "",
        "Candidates:",
        JSON.stringify(candidates.map((c) => ({ id: c.id, content: c.content }))),
      ].join("\n");

      const result = await completeOnce(ctx, config, {
        systemPrompt,
        userPrompt,
        timeoutMs: 30_000,
        signal,
        // Reasoning models may use the first tokens before emitting the tiny
        // JSON array. Leave enough room for both reasoning and the result.
        maxTokens: 512,
      });
      if (!result.ok || result.value === undefined) return result as LlmResult<number[]>;

      const array = extractJsonArray(result.value);
      if (!Array.isArray(array)) {
        return { ok: false, fallbackReason: "parse_error", error: "Rerank response was not a JSON array" };
      }

      const ids = array
        .filter((v): v is number => typeof v === "number" && Number.isInteger(v))
        .slice(0, maxResults);
      return {
        ok: true,
        value: ids,
        modelReference: result.modelReference,
        fallbackModelUsed: result.fallbackModelUsed,
      };
    },
  };
}
