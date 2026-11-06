import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { canonicalPath, CONSULT_SCAN_LIMITS, scanKeywords, streamEntries, type FileFingerprint, type SearchMatch, type SessionMetadata } from "./sessions.ts";

export type ConsultAction = "search" | "list" | "summary";
export interface ConsultParams {
  action: ConsultAction; sessionId?: string; path?: string; name?: string; query?: string;
  days?: number; from?: string; to?: string; cwd?: string; cwdPrefix?: boolean;
  status?: "active" | "idle" | "archived" | "any"; sort?: "relevance" | "recent" | "oldest";
  role?: string[]; userOnly?: boolean; includeToolCalls?: boolean; page?: number;
  pageChars?: number; last?: boolean; instruction?: string;
}
export interface ConsultError extends Error { code: string; candidates?: SessionMetadata[] }
export interface CacheValue { body: string; header: string; fingerprints: FileFingerprint[]; metadata?: unknown }

function error(code: string, message: string): ConsultError {
  return Object.assign(new Error(message), { code });
}
export function consultError(code: string, message: string): ConsultError { return error(code, message); }
export function mergeLastQuery(previous: Record<string, unknown> | undefined, supplied: Record<string, unknown>): ConsultParams {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw error("NO_LAST_QUERY", "Run a consult request first, then set last=true to reuse it.");
  const { last: _last, ...overrides } = supplied;
  try { return normalizeParams({ ...previous, ...overrides, last: false }); }
  catch (cause) {
    // A bad override is the caller's mistake; only a missing or corrupt store means NO_LAST_QUERY.
    if ((cause as { code?: string }).code) throw cause;
    throw error("NO_LAST_QUERY", "The saved consult query is invalid; run a new consult request first.");
  }
}
export function assertNotCurrent(item: SessionMetadata, current: { file?: string; id?: string }): void {
  if ((current.file && item.path === current.file) || (current.id && item.id === current.id)) throw error("CURRENT_SESSION", "This is the current session; use context_recall to search its active branch.");
}
export function resolveTarget(metadata: SessionMetadata[], target: { sessionId?: string; path?: string; name?: string }): SessionMetadata {
  const wantedPath = target.path ? canonicalPath(target.path) : undefined;
  const found = metadata.filter((item) => target.sessionId ? item.id === target.sessionId
    : wantedPath ? item.path === wantedPath
    : target.name ? item.name?.toLocaleLowerCase() === target.name.toLocaleLowerCase() : false);
  if (!found.length) throw error("NOT_FOUND", "No matching session was found. Search for it or check the session ID/path.");
  if (found.length > 1) throw Object.assign(error("AMBIGUOUS_NAME", `Name matches ${found.length} sessions. Retry with an exact sessionId or path.`), { candidates: found.slice(0, 8) });
  return found[0];
}

export function normalizeParams(input: Record<string, unknown>): ConsultParams {
  const p = { ...input } as any;
  const allowed = new Set(["action", "sessionId", "path", "name", "query", "days", "from", "to", "cwd", "cwdPrefix", "status", "sort", "role", "userOnly", "includeToolCalls", "page", "pageChars", "last", "instruction"]);
  for (const key of Object.keys(p)) if (!allowed.has(key)) throw error("INVALID_ARGUMENT", `Unknown parameter ${key}. Remove it and retry.`);
  if (!["search", "list", "summary"].includes(p.action)) throw error("INVALID_ARGUMENT", "Choose search, list, or summary as action.");
  if (p.query !== undefined && (typeof p.query !== "string" || p.query.length > 200)) throw error("INVALID_ARGUMENT", "Use a search query of at most 200 characters.");
  if (p.instruction !== undefined && (typeof p.instruction !== "string" || p.instruction.length > 500)) throw error("INVALID_ARGUMENT", "Keep the summary instruction within 500 characters.");
  if (p.page !== undefined && (!Number.isSafeInteger(p.page) || p.page < 1)) throw error("INVALID_PAGE", "Use a positive integer page number.");
  if (p.pageChars !== undefined && (!Number.isSafeInteger(p.pageChars) || p.pageChars < 2000 || p.pageChars > 12000)) throw error("INVALID_ARGUMENT", "Set pageChars between 2,000 and 12,000.");
  if (p.days !== undefined && (!Number.isSafeInteger(p.days) || p.days < 1 || p.days > 3650)) throw error("INVALID_ARGUMENT", "Set days between 1 and 3,650.");
  if (p.from !== undefined && !Number.isFinite(Date.parse(p.from))) throw error("INVALID_ARGUMENT", "Use an ISO date for from.");
  if (p.to !== undefined && !Number.isFinite(Date.parse(p.to))) throw error("INVALID_ARGUMENT", "Use an ISO date for to.");
  if (p.role !== undefined && (!Array.isArray(p.role) || p.role.some((r: unknown) => !["user", "assistant", "compactionSummary", "bashExecution", "toolResult"].includes(r as string)))) throw error("INVALID_ARGUMENT", "Choose supported roles for role.");
  if (p.userOnly === true && p.role !== undefined && !(p.role.length === 1 && p.role[0] === "user")) throw error("INVALID_ARGUMENT", "Use userOnly or a role filter, not conflicting values.");
  const roleSupplied = p.role !== undefined;
  p.page ??= 1; p.pageChars ??= 8000; p.days ??= 30; p.status ??= "any"; p.sort ??= "relevance";
  p.cwdPrefix ??= false; p.userOnly ??= false; p.includeToolCalls ??= false;
  if (p.userOnly) p.role = ["user"];
  else if (!roleSupplied) p.role = p.includeToolCalls ? ["user", "assistant", "toolResult"] : ["user", "assistant"];
  if (p.role.length === 0) throw error("INVALID_ARGUMENT", "Include at least one role.");
  if (p.action === "search" && !p.query?.trim() && !p.name && !p.cwd && !p.from && !p.to) throw error("INVALID_ARGUMENT", "Add a query or at least one search filter.");
  if ((p.action === "list" || p.action === "summary") && !p.sessionId && !p.path && !p.name) throw error("MISSING_TARGET", "Provide sessionId, path, or a unique name.");
  return p as ConsultParams;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function cacheKey(params: ConsultParams): string {
  const { page: _page, last: _last, ...rest } = params;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

export function paginate(body: string, pageChars: number, page: number): { text: string; page: number; pages: number } {
  if (!Number.isSafeInteger(page) || page < 1) throw error("INVALID_PAGE", "Use a positive integer page number.");
  const chars = Array.from(body);
  const pages = Math.max(1, Math.ceil(chars.length / pageChars));
  if (page > pages) throw error("PAGE_OUT_OF_RANGE", `Page ${page} is out of range; choose a page from 1 to ${pages}.`);
  return { text: chars.slice((page - 1) * pageChars, page * pageChars).join(""), page, pages };
}

export class ResultCache {
  private readonly entries = new Map<string, { value: CacheValue; at: number; weight: number }>();
  constructor(private readonly maxEntries = 32, private readonly maxBytes = 32 * 1024 * 1024, private readonly ttlMs = 10 * 60_000) {}
  get(key: string, now = Date.now()): CacheValue | undefined {
    const item = this.entries.get(key);
    if (!item) return undefined;
    if (now - item.at >= this.ttlMs || !fingerprintsValid(item.value.fingerprints)) { this.entries.delete(key); return undefined; }
    this.entries.delete(key); item.at = now; this.entries.set(key, item);
    return item.value;
  }
  set(key: string, value: CacheValue, now = Date.now()): void {
    const weight = Buffer.byteLength(value.body + value.header, "utf8") + Buffer.byteLength(JSON.stringify(value.fingerprints), "utf8");
    if (weight > this.maxBytes) return;
    this.entries.delete(key); this.entries.set(key, { value, at: now, weight });
    let bytes = [...this.entries.values()].reduce((n, item) => n + item.weight, 0);
    while (this.entries.size > this.maxEntries || bytes > this.maxBytes) {
      const first = this.entries.keys().next().value as string | undefined;
      if (!first) break;
      bytes -= this.entries.get(first)?.weight ?? 0; this.entries.delete(first);
    }
  }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
function fingerprintsValid(items: FileFingerprint[]): boolean {
  return items.every((item) => {
    try { const stat = fs.statSync(item.path); return stat.mtimeMs === item.mtimeMs && stat.size === item.size; }
    catch { return false; }
  });
}

function fileFingerprint(metadata: SessionMetadata): FileFingerprint {
  return { path: metadata.path, mtimeMs: metadata.mtimeMs, size: metadata.size };
}
function statusMatches(meta: SessionMetadata, status: ConsultParams["status"], now: number): boolean {
  if (!status || status === "any") return true;
  const age = now - meta.mtimeMs;
  if (status === "active") return age <= 15 * 60_000;
  if (status === "archived") return age > 30 * 24 * 60 * 60_000;
  return age > 15 * 60_000 && age <= 30 * 24 * 60 * 60_000;
}
function metadataMatches(meta: SessionMetadata, params: ConsultParams, now: number): boolean {
  const created = meta.timestamp ? Date.parse(meta.timestamp) : NaN;
  const hasExplicitRange = Boolean(params.from || params.to);
  const low = params.from ? Date.parse(params.from) : hasExplicitRange ? -Infinity : now - (params.days ?? 30) * 86_400_000;
  const high = params.to ? Date.parse(params.to) : now;
  if (Number.isFinite(created) && (created < low || created > high)) return false;
  if (params.cwd && (params.cwdPrefix ? !(meta.cwd === params.cwd || meta.cwd?.startsWith(params.cwd + "/")) : meta.cwd !== params.cwd)) return false;
  if (params.name && !meta.name?.toLocaleLowerCase().includes(params.name.toLocaleLowerCase())) return false;
  if (!statusMatches(meta, params.status, now)) return false;
  return true;
}

export async function searchSessions(
  metadata: SessionMetadata[], params: ConsultParams,
  options: { now?: number; fileLimit?: number; byteLimit?: number; deadlineMs?: number } = {},
): Promise<{ body: string; header: string; sessions: SessionMetadata[]; fingerprints: FileFingerprint[] }> {
  const now = options.now ?? Date.now();
  const candidates = metadata.filter((item) => metadataMatches(item, params, now));
  let matches: SearchMatch[];
  let scanned = 0, total = candidates.length, capped = false;
  const terms = (params.query ?? "").trim().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const result = await scanKeywords(candidates, terms, params.includeToolCalls, options);
    matches = result.matches; scanned = result.scanned; total = result.total; capped = result.capped;
  } else {
    matches = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).map((item) => ({ metadata: item, excerpt: item.preview ?? "", hits: 0 }));
  }
  const compare = (a: SearchMatch, b: SearchMatch): number => {
    if (params.sort === "oldest") return (Date.parse(a.metadata.timestamp ?? "") || 0) - (Date.parse(b.metadata.timestamp ?? "") || 0);
    if (params.sort === "recent") return b.metadata.mtimeMs - a.metadata.mtimeMs;
    return b.hits - a.hits || b.metadata.mtimeMs - a.metadata.mtimeMs || a.metadata.path.localeCompare(b.metadata.path);
  };
  matches.sort(compare);
  const body = matches.map((match, index) => {
    const m = match.metadata;
    const label = clipText(m.name ?? m.preview ?? "(unnamed)", 80);
    const hits = match.hits > 1 ? ` | ${match.hits} hits` : "";
    return `${index + 1}. ${m.id ?? "?"} | ${JSON.stringify(label)} | ${m.cwd ?? "?"} | modified ${formatStamp(m.mtimeMs)} | ${statusLabel(m, now)}${hits}\n   Match: ${JSON.stringify(match.excerpt)}`;
  }).join("\n");
  const header = `CONSULT SEARCH | ${matches.length} matches | sort=${params.sort}${terms.length ? ` | scanned ${scanned} of ${total} candidates${capped ? " (scan cap reached)" : ""}` : ""}`;
  // Fingerprint only the sessions the body was rendered from. Fingerprinting every
  // candidate would let unrelated churn, including this session's own appends,
  // invalidate the cache on every page turn.
  const fingerprints = matches.map((match) => fileFingerprint(match.metadata));
  return { body, header, sessions: matches.map((m) => m.metadata), fingerprints };
}
function clipText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
function formatStamp(value: number | string | undefined): string {
  if (value === undefined) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
function statusLabel(meta: SessionMetadata, now: number): string {
  if (statusMatches(meta, "active", now)) return "active";
  return statusMatches(meta, "archived", now) ? "archived" : "idle";
}

function contentText(message: any, includeToolCalls: boolean): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => part?.type === "text" ? part.text ?? ""
    : part?.type === "image" ? "[image omitted]"
    : includeToolCalls && part?.type === "toolCall" ? `Tool call: ${part.name}(${JSON.stringify(part.arguments ?? {})})` : "").filter(Boolean).join("\n");
}
function clipEntry(value: string, max = 2000): string { return Array.from(value).slice(0, max).join("") + (Array.from(value).length > max ? "…" : ""); }
const LIST_BODY_LIMIT = 120_000;
export async function renderListBody(file: string, params: ConsultParams): Promise<{ body: string; header: string; fingerprint?: FileFingerprint }> {
  const records: string[] = [];
  const roles = new Set(params.role ?? ["user", "assistant"]);
  let chars = 0, stoppedAt: string | undefined;
  for await (const entry of streamEntries(file)) {
    const role = entry.type === "compaction" ? "compactionSummary"
      : entry.type === "message" ? entry.message?.role
      : undefined;
    if (!role || role === "system" || role === "custom") continue;
    if (!roles.has(role)) continue;
    const message = entry.type === "message" ? entry.message : undefined;
    const raw = entry.type === "compaction"
      ? (entry.summary ?? "")
      : contentText(message, params.includeToolCalls);
    if (!raw.trim()) continue;
    const label = role === "toolResult" ? `toolResult:${message?.toolName ?? "tool"}` : String(role);
    const record = `[${entry.id ?? "?"}] ${formatStamp(entry.timestamp)} ${label}: ${clipEntry(raw)}`;
    if (chars + record.length + (records.length ? 1 : 0) > LIST_BODY_LIMIT) { stoppedAt = entry.id ?? "?"; break; }
    records.push(record);
    chars += record.length + (records.length > 1 ? 1 : 0);
  }
  if (stoppedAt) records.push(`[TRUNCATED at entry ${stoppedAt}; narrow the request or inspect another portion]`);
  let fingerprint: FileFingerprint | undefined;
  try { const stat = await fs.promises.stat(file); fingerprint = { path: file, size: stat.size, mtimeMs: stat.mtimeMs }; } catch { /* surfaced by the caller */ }
  return { body: records.join("\n"), header: `CONSULT LIST | ${file} | roles=${[...roles].join(",")} | tools=${params.includeToolCalls ? "included" : "excluded"}`, fingerprint };
}

export function isFingerprintValid(fingerprints: FileFingerprint[]): boolean { return fingerprintsValid(fingerprints); }
export { CONSULT_SCAN_LIMITS };
