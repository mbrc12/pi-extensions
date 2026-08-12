/**
 * memory-store — persistent memory for pi, one SQLite file.
 *
 * Replaces pi-hermes-memory's markdown-file + subprocess machinery with:
 * - one SQLite database (node:sqlite, WAL, busy_timeout)
 * - in-process LLM calls only (no child pi processes, no auth stripping)
 * - FTS5 keyword search + LLM rerank (ids-only output, minimal tokens)
 * - no system-prompt injection (AGENTS.md covers standing context)
 *
 * Events acted on:
 *   message_end (user)  — user-turn counting
 *   turn_end            — background review (turn/tool-call thresholds);
 *                         corrections are captured by the AI inside review
 *   session_before_compact — flush pending memories
 *   session_shutdown    — flush + DB close
 *
 * Tools:  memory_search, memory_add, memory_remove, memory_update
 * Commands: /memory-search, /memory-list, /memory-stats
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, type MemoryStoreConfig } from "./config.js";
import { MemoryDb, type MemoryBlurb } from "./db.js";
import { createLlm, type LlmOps, type MemoryOperation } from "./llm.js";
import { collectMessageParts, countToolCalls, formatParts, getMessageText } from "./detect.js";
import {
  FLUSH_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  FLUSH_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS,
} from "./constants.js";

// ─── Schema definitions ───

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query — natural language is fine; FTS5 matches keywords and an LLM reranks the candidates" }),
  limit: Type.Optional(Type.Integer({ description: "Max results (default 5)" })),
});

const AddParams = Type.Object({
  content: Type.String({ description: "The memory blurb to save (markdown text)" }),
  category: Type.Optional(Type.String({ description: "Optional category: memory | preference | convention | insight | tool-quirk | correction | failure" })),
});

const RemoveParams = Type.Object({
  old_text: Type.String({ description: "Substring of the blurb to remove" }),
});

const UpdateParams = Type.Object({
  old_text: Type.String({ description: "Substring of the blurb to replace" }),
  new_content: Type.String({ description: "New blurb text" }),
});

// ─── Extension entry ───

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const db = new MemoryDb(config);
  const llm: LlmOps = createLlm();

  // ─── Learning-loop counters ───

  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let userTurnCount = 0;
  let reviewInProgress = false;

  // ─── Apply an LLM operation plan to the store ───

  function applyPlan(plan: MemoryOperation[]): { applied: number; skipped: number; errors: string[] } {
    let applied = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const op of plan) {
      switch (op.action) {
        case "add": {
          if (!op.content?.trim()) {
            skipped++;
            continue;
          }
          const result = db.add(op.content, "memory", "review");
          if (result.duplicate) skipped++;
          else applied++;
          break;
        }
        case "remove": {
          if (!op.old_text?.trim()) {
            skipped++;
            continue;
          }
          const result = db.remove(op.old_text);
          if (result.removed > 0) applied++;
          else {
            skipped++;
            errors.push(`remove: no entry matched '${op.old_text.slice(0, 60)}'`);
          }
          break;
        }
        case "replace": {
          if (!op.old_text?.trim() || !op.content?.trim()) {
            skipped++;
            continue;
          }
          const result = db.replace(op.old_text, op.content);
          if (result.replaced > 0) applied++;
          else {
            skipped++;
            errors.push(`replace: no entry matched '${op.old_text.slice(0, 60)}'`);
          }
          break;
        }
      }
    }
    return { applied, skipped, errors };
  }

  // ─── Background review ───

  async function runReview(ctx: any): Promise<void> {
    if (!config.reviewEnabled || reviewInProgress) return;

    let entries: unknown[];
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return;
    }
    const parts = collectMessageParts(entries);
    if (parts.length < config.minParts) return;

    const promptInput = [
      "--- Current Memory (blurbs) ---",
      formatBlurbs(db.list()),
      "",
      "--- Conversation to Review ---",
      formatParts(parts),
    ].join("\n\n");

    reviewInProgress = true;
    try {
      const result = await llm.runOps(ctx, config, {
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        userPrompt: promptInput,
        timeoutMs: REVIEW_TIMEOUT_MS,
        signal: ctx.signal,
      });
      if (result.ok && result.value) {
        const { applied, errors } = applyPlan(result.value.operations);
        if (applied > 0) {
          ctx.ui.notify("💾 Memory auto-reviewed and updated", "info");
        }
        for (const error of errors.slice(0, 2)) {
          console.warn(`[memory-store] review: ${error}`);
        }
      } else if (result.fallbackReason === "provider_error") {
        console.warn(`[memory-store] review failed: ${result.error ?? "provider error"}`);
      }
    } catch (error) {
      console.warn(`[memory-store] review threw: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      reviewInProgress = false;
    }
  }

  // ─── Session flush ───

  async function flush(ctx: any, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    if (userTurnCount < config.flushMinTurns) return;

    let entries: unknown[];
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return;
    }
    const parts = collectMessageParts(entries);
    if (parts.length === 0) return;

    try {
      const result = await llm.runOps(ctx, config, {
        systemPrompt: FLUSH_SYSTEM_PROMPT,
        userPrompt: [
          "--- Conversation ---",
          formatParts(parts),
        ].join("\n\n"),
        timeoutMs,
        signal,
      });
      if (result.ok && result.value) {
        applyPlan(result.value.operations);
      }
    } catch {
      // Best-effort flush — never block shutdown.
    }
  }

  function formatBlurbs(blurbs: MemoryBlurb[]): string {
    if (blurbs.length === 0) return "(empty)";
    return blurbs.map((b) => `${b.id}: ${b.content}`).join("\n");
  }

  // ─── Events ───

  pi.on("message_end", async (event: any, _ctx: any) => {
    if (event.message?.role !== "user") return;
    userTurnCount++;
  });

  pi.on("turn_end", async (event: any, ctx: any) => {
    turnsSinceReview++;

    // Count tool calls in the assistant message.
    if (event.message?.role === "assistant") {
      toolCallsSinceReview += countToolCalls(event.message?.content);
    }

    // Background review (corrections are handled by the AI inside this same
    // review — the review prompt asks it to capture user corrections).
    const turnThresholdMet = turnsSinceReview >= config.nudgeInterval;
    const toolCallThresholdMet = toolCallsSinceReview >= config.nudgeToolCalls;
    if ((turnThresholdMet || toolCallThresholdMet) && userTurnCount >= config.minUserTurns && !reviewInProgress) {
      turnsSinceReview = 0;
      toolCallsSinceReview = 0;
      // Fire-and-forget so the turn boundary is never blocked.
      runReview(ctx).catch(() => {});
    }
  });

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!config.flushOnCompact) return;
    await flush(ctx, event.signal, FLUSH_TIMEOUT_MS);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    if (config.flushOnShutdown) {
      // Await the bounded flush before closing the DB, so pending writes
      // land. Worst case this adds up to 10s to shutdown, matching the
      // compaction flush's cost — and the flush only runs when the session
      // had at least flushMinTurns user turns.
      try {
        await flush(ctx, undefined, 10_000);
      } catch {
        // Never block shutdown.
      }
    }
    db.close();
  });

  // ─── Tools ───

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search persistent memory (markdown blurbs stored in a global SQLite store). FTS5 keyword matching finds candidates, then an LLM reranks them for relevance. Returns matching blurbs with ids. Use this when you need durable facts about the user, their environment, preferences, or past lessons — instead of relying on system-prompt memory.",
    parameters: SearchParams,
    renderCall(args, theme, _context) {
      const query = (args?.query ?? "").trim();
      return new Text(
        theme.fg("toolTitle", theme.bold("memory_search ")) + theme.fg("muted", `"${query}"`),
        0,
        0,
      );
    },
    renderResult(result, options, theme, _context) {
      const expanded = options?.expanded ?? false;
      const details = result?.details as
        | { query?: string; count?: number; results?: { id: number; content: string; category: string }[] }
        | undefined;

      if (!details || !Array.isArray(details.results)) {
        const text = result?.content?.[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      const count = details.count ?? details.results.length;
      if (count === 0) {
        return new Text(theme.fg("muted", "No memories found"), 0, 0);
      }

      if (!expanded) {
        const hint = keyHint("app.tools.expand", "to expand");
        return new Text(
          theme.fg("success", `✓ ${count} ${count === 1 ? "memory" : "memories"}`) + theme.fg("dim", ` (${hint})`),
          0,
          0,
        );
      }

      const lines = details.results.map((r) => {
        const head = theme.fg("accent", `[${r.id}]`) + theme.fg("dim", ` ${r.category} `);
        return head + theme.fg("text", r.content);
      });
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const query = (params.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "Error: query cannot be empty." }], details: {} };
      }
      const limit = Math.min(Math.max(params.limit ?? config.searchLimit, 1), 20);

      const candidates = db.searchCandidates(query, config.rerankCandidates);
      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: "No memories found." }],
          details: { query, results: [], count: 0 },
        };
      }

      // LLM rerank: ids only (minimal output tokens). On any failure, fall
      // back to the FTS5 order — search must never break because of the model.
      let rankedIds: number[] | null = null;
      try {
        const rerank = await llm.rerank(
          ctx,
          config,
          query,
          candidates.map((c) => ({ id: c.id, content: c.content })),
          limit,
          ctx.signal,
        );
        if (rerank.ok && rerank.value) rankedIds = rerank.value;
      } catch {
        // fall back to FTS5 order
      }

      const byId = new Map(candidates.map((c) => [c.id, c]));
      const ordered = rankedIds
        ? rankedIds.map((id) => byId.get(id)).filter((c): c is MemoryBlurb => !!c)
        : candidates.slice(0, limit);

      // Keep only ranked ones that were actually in the candidate pool.
      const results = ordered.slice(0, limit);
      db.touch(results.map((r) => r.id));

      const text = results.length === 0
        ? "No memories found."
        : results.map((r) => `[${r.id}] ${r.content}`).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: {
          query,
          count: results.length,
          results: results.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            created_at: r.created_at,
            last_used_at: r.last_used_at,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description:
      "Save a durable fact to persistent memory as a markdown blurb. Use for user preferences, environment facts, conventions, lessons, and tool quirks. Duplicates (exact same text) are skipped automatically.",
    parameters: AddParams,
    renderCall(args, theme, _context) {
      const content = (args?.content ?? "").trim();
      const snippet = content.length > 60 ? content.slice(0, 60) + "…" : content;
      return new Text(
        theme.fg("toolTitle", theme.bold("memory_add ")) + theme.fg("muted", `"${snippet}"`),
        0,
        0,
      );
    },
    renderResult(result, options, theme, _context) {
      const expanded = options?.expanded ?? false;
      const details = result?.details as { ok?: boolean; duplicate?: boolean; id?: number } | undefined;
      if (!details) {
        const text = result?.content?.[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (!details.ok) {
        return new Text(theme.fg("error", "Error: content cannot be empty"), 0, 0);
      }
      if (details.duplicate) {
        return new Text(theme.fg("muted", "Already in memory (no duplicate)"), 0, 0);
      }
      const text = theme.fg("success", `✓ Saved [${details.id}]`);
      if (expanded) {
        return new Text(text + theme.fg("dim", " — press the tool's blurb above to see it in memory"), 0, 0);
      }
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, _ctx: any) {
      const result = db.add(params.content ?? "", params.category ?? "memory", "tool");
      const text = result.duplicate
        ? "Already in memory (no duplicate added)."
        : result.ok
          ? `Saved (id ${result.id}).`
          : "Error: content cannot be empty.";
      return {
        content: [{ type: "text", text }],
        details: { ok: result.ok, duplicate: result.duplicate, id: result.id },
      };
    },
  });

  pi.registerTool({
    name: "memory_remove",
    label: "Memory Remove",
    description: "Remove memory blurbs whose content contains the given text (case-insensitive substring match).",
    parameters: RemoveParams,
    renderCall(args, theme, _context) {
      return new Text(
        theme.fg("toolTitle", theme.bold("memory_remove ")) + theme.fg("muted", `"${(args?.old_text ?? "").trim()}"`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, _context) {
      const details = result?.details as { removed?: number } | undefined;
      if (!details || typeof details.removed !== "number") {
        const text = result?.content?.[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      return new Text(
        details.removed > 0
          ? theme.fg("success", `✓ Removed ${details.removed} ${details.removed === 1 ? "blurb" : "blurbs"}`)
          : theme.fg("muted", "No blurb matched"),
        0,
        0,
      );
    },
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, _ctx: any) {
      const result = db.remove(params.old_text ?? "");
      const text = result.removed > 0
        ? `Removed ${result.removed} ${result.removed === 1 ? "blurb" : "blurbs"}.`
        : "No blurb matched that text.";
      return {
        content: [{ type: "text", text }],
        details: { removed: result.removed },
      };
    },
  });

  pi.registerTool({
    name: "memory_update",
    label: "Memory Update",
    description:
      "Replace memory blurbs whose content contains old_text with new_content (case-insensitive substring match). Use when a stored fact is now wrong or superseded.",
    parameters: UpdateParams,
    renderCall(args, theme, _context) {
      return new Text(
        theme.fg("toolTitle", theme.bold("memory_update "))
          + theme.fg("muted", `"${(args?.old_text ?? "").trim()}" → "${(args?.new_content ?? "").trim().slice(0, 60)}"`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, _context) {
      const details = result?.details as { replaced?: number } | undefined;
      if (!details || typeof details.replaced !== "number") {
        const text = result?.content?.[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      return new Text(
        details.replaced > 0
          ? theme.fg("success", `✓ Replaced ${details.replaced} ${details.replaced === 1 ? "blurb" : "blurbs"}`)
          : theme.fg("muted", "No blurb matched"),
        0,
        0,
      );
    },
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, _ctx: any) {
      const result = db.replace(params.old_text ?? "", params.new_content ?? "");
      const text = result.replaced > 0
        ? `Replaced ${result.replaced} ${result.replaced === 1 ? "blurb" : "blurbs"}.`
        : "No blurb matched that text.";
      return {
        content: [{ type: "text", text }],
        details: { replaced: result.replaced },
      };
    },
  });

  // ─── Commands ───

  pi.registerCommand("memory-search", {
    description: "Search persistent memory blurbs",
    handler: async (args: string | undefined, ctx: any) => {
      const query = (args ?? "").trim();
      if (!query) {
        if (ctx.ui?.notify) ctx.ui.notify("Usage: /memory-search <query>", "warning");
        return;
      }
      const candidates = db.searchCandidates(query, config.rerankCandidates);
      let results = candidates;
      if (candidates.length > 0) {
        try {
          const rerank = await llm.rerank(
            ctx,
            config,
            query,
            candidates.map((c) => ({ id: c.id, content: c.content })),
            config.searchLimit,
          );
          if (rerank.ok && rerank.value) {
            const byId = new Map(candidates.map((c) => [c.id, c]));
            results = rerank.value.map((id) => byId.get(id)).filter((c): c is MemoryBlurb => !!c);
          }
        } catch {
          // fall back to FTS5 order
        }
      }
      db.touch(results.slice(0, config.searchLimit).map((r) => r.id));
      const body = results.length === 0
        ? "No memories found."
        : results.slice(0, config.searchLimit).map((r) => `[${r.id}] ${r.content}`).join("\n\n");
      if (ctx.ui?.notify) ctx.ui.notify(body, "info");
      else console.log(body);
    },
  });

  pi.registerCommand("memory-list", {
    description: "List memory blurbs (optionally filtered by category)",
    handler: async (args: string | undefined, ctx: any) => {
      const category = (args ?? "").trim() || undefined;
      const blurbs = db.list(category);
      const body = blurbs.length === 0
        ? "No memories stored."
        : blurbs.map((b) => `[${b.id}] (${b.category}) ${b.content} — created ${b.created_at}, last used ${b.last_used_at}`).join("\n");
      if (ctx.ui?.notify) ctx.ui.notify(body, "info");
      else console.log(body);
    },
  });

  pi.registerCommand("memory-stats", {
    description: "Show memory store statistics",
    handler: async (_args: string | undefined, ctx: any) => {
      const stats = db.stats();
      const body = [
        `Total blurbs: ${stats.total}`,
        ...Object.entries(stats.by_category).map(([cat, count]) => `  ${cat}: ${count}`),
      ].join("\n");
      if (ctx.ui?.notify) ctx.ui.notify(body, "info");
      else console.log(body);
    },
  });
}

