import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertNotCurrent, cacheKey, mergeLastQuery, normalizeParams, paginate, renderListBody, resolveTarget, ResultCache, searchSessions } from "../tools/consult/query.ts";
import { scanKeywords, type SessionMetadata } from "../tools/consult/sessions.ts";

const tempFiles: string[] = [];
afterEach(async () => { await Promise.all(tempFiles.splice(0).map((file) => fs.rm(file, { force: true }))); });
async function fixture(contents: unknown[]): Promise<string> {
  const file = path.join(os.tmpdir(), `consult-${crypto.randomUUID()}.jsonl`);
  await fs.writeFile(file, contents.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  tempFiles.push(file);
  return file;
}
function metadata(file: string, id: string, mtimeMs = Date.now()): SessionMetadata {
  return { path: file, id, mtimeMs, size: 1, timestamp: new Date(mtimeMs).toISOString(), cwd: "/project", name: "shared name" };
}

describe("consult paging and cache", () => {
  test("paginate preserves code points and reports bounds", () => {
    const body = "a😀bc";
    expect(paginate(body, 2, 1)).toEqual({ text: "a😀", page: 1, pages: 2 });
    expect(paginate(body, 2, 2).text).toBe("bc");
    expect(() => paginate(body, 2, 3)).toThrow(/out of range/);
  });
  test("cache key ignores page and a changed page reuses the cached body", () => {
    const one = normalizeParams({ action: "search", query: "cache", page: 1 });
    const two = { ...one, page: 2 };
    expect(cacheKey(one)).toBe(cacheKey(two));
    const cache = new ResultCache();
    const key = cacheKey(one);
    cache.set(key, { header: "header", body: "body", fingerprints: [] });
    expect(cache.get(cacheKey(two))?.body).toBe("body");
  });
});

describe("consult session query", () => {
  test("tool calls and results are excluded by default and included on opt-in", async () => {
    const file = await fixture([
      { type: "session", id: "abc", timestamp: new Date().toISOString(), cwd: "/project" },
      { type: "message", id: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: "do work" } },
      { type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Starting." }, { type: "toolCall", name: "bash", arguments: { command: "secret-tool-call" } }] } },
      { type: "message", id: "t1", timestamp: new Date().toISOString(), message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "secret-tool-result" }] } },
    ]);
    const basic = await renderListBody(file, normalizeParams({ action: "list", path: file }));
    expect(basic.body).not.toContain("secret-tool-call");
    expect(basic.body).not.toContain("secret-tool-result");
    const opted = await renderListBody(file, normalizeParams({ action: "list", path: file, includeToolCalls: true }));
    expect(opted.body).toContain("secret-tool-call");
    expect(opted.body).toContain("secret-tool-result");
  });
  test("ambiguous names error and current session is refused", () => {
    const candidates = [metadata("/a", "one"), metadata("/b", "two")];
    expect(() => resolveTarget(candidates, { name: "shared name" })).toThrow(/matches 2/);
    expect(() => assertNotCurrent(candidates[0], { id: "one" })).toThrow(/context_recall/);
  });
  test("last merges supplied parameters and revalidates", () => {
    const prior = normalizeParams({ action: "search", query: "cache", days: 60, page: 1 });
    const merged = mergeLastQuery(prior as any, { last: true, page: 3 });
    expect(merged.action).toBe("search");
    expect(merged.query).toBe("cache");
    expect(merged.days).toBe(60);
    expect(merged.page).toBe(3);
    expect(() => mergeLastQuery(undefined, { last: true })).toThrow(/consult request first/);
  });
  test("keyword scan enforces candidate-file cap and matches searchable text", async () => {
    const files: string[] = [];
    const candidates: SessionMetadata[] = [];
    for (let i = 0; i < 3; i++) {
      const file = await fixture([
        { type: "session", id: `id-${i}`, timestamp: new Date().toISOString(), cwd: "/project" },
        { type: "message", id: `m-${i}`, timestamp: new Date().toISOString(), message: { role: "user", content: i === 0 ? "polars query" : "other" } },
      ]);
      files.push(file); candidates.push(metadata(file, `id-${i}`, Date.now() - i));
    }
    const result = await scanKeywords(candidates, ["polars"], false, { fileLimit: 1, now: () => 0, deadlineMs: 10_000 });
    expect(result.scanned).toBe(1);
    expect(result.total).toBe(3);
    expect(result.capped).toBe(true);
  });
  test("search requires every query term in matching session text", async () => {
    const file = await fixture([
      { type: "session", id: "x", timestamp: new Date().toISOString(), cwd: "/project" },
      { type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: "polars dataframe" } },
    ]);
    const found = await searchSessions([metadata(file, "x")], normalizeParams({ action: "search", query: "polars dataframe" }));
    expect(found.body).toContain("polars");
  });
  test("search fingerprints only the matched sessions so unrelated churn cannot invalidate it", async () => {
    const hit = await fixture([
      { type: "session", id: "hit", timestamp: new Date().toISOString(), cwd: "/project" },
      { type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: "polars dataframe" } },
    ]);
    const miss = await fixture([
      { type: "session", id: "miss", timestamp: new Date().toISOString(), cwd: "/project" },
      { type: "message", id: "m2", timestamp: new Date().toISOString(), message: { role: "user", content: "unrelated work" } },
    ]);
    const found = await searchSessions([metadata(hit, "hit"), metadata(miss, "miss")], normalizeParams({ action: "search", query: "polars", days: 3650 }));
    expect(found.sessions.map((item) => item.id)).toEqual(["hit"]);
    expect(found.fingerprints.map((item) => item.path)).toEqual([hit]);
  });
  test("a list can show compaction summaries and defaults follow includeToolCalls", async () => {
    const file = await fixture([
      { type: "session", id: "s", timestamp: new Date().toISOString(), cwd: "/project" },
      { type: "compaction", id: "c1", timestamp: new Date().toISOString(), summary: "condensed history", firstKeptEntryId: "m1", tokensBefore: 10 },
      { type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: "after compaction" } },
    ]);
    const summaries = await renderListBody(file, normalizeParams({ action: "list", path: file, role: ["compactionSummary"] }));
    expect(summaries.body).toContain("condensed history");
    expect(summaries.body).not.toContain("after compaction");
    expect(normalizeParams({ action: "list", path: file }).role).toEqual(["user", "assistant"]);
    expect(normalizeParams({ action: "list", path: file, includeToolCalls: true }).role).toEqual(["user", "assistant", "toolResult"]);
    expect(normalizeParams({ action: "list", path: file, includeToolCalls: true, role: ["user"] }).role).toEqual(["user"]);
  });
  test("a bad override reports its own error instead of blaming the stored query", () => {
    const prior = normalizeParams({ action: "search", query: "cache" });
    expect(() => mergeLastQuery(prior as any, { last: true, page: 0 })).toThrow(/positive integer/);
  });
});
