import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

export interface FileFingerprint { path: string; mtimeMs: number; size: number }
export interface SessionMetadata extends FileFingerprint {
  id?: string;
  timestamp?: string;
  cwd?: string;
  name?: string;
  preview?: string;
  latestTimestamp?: string;
}
export interface DiscoveryResult { files: string[]; warnings: string[]; truncated: boolean }
export interface SearchMatch { metadata: SessionMetadata; excerpt: string; hits: number }

const FILE_LIMIT = 5_000;
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 64 * 1024;
const SEARCH_FILE_LIMIT = 300;
const SEARCH_BYTE_LIMIT = 256 * 1024 * 1024;
const SEARCH_DEADLINE_MS = 2_500;

export function canonicalPath(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

export function rootsFor(agentDir: string, sessionDir?: string): string[] {
  return [...new Set([
    path.join(agentDir, "sessions"),
    path.join(agentDir, "multiagent"),
    ...(sessionDir ? [sessionDir] : []),
  ].map((root) => path.resolve(root)))];
}

export async function discoverSessions(roots: string[], limit = FILE_LIMIT): Promise<DiscoveryResult> {
  const files: string[] = [];
  const warnings: string[] = [];
  let truncated = false;
  for (const root of roots) {
    const pending: string[] = [root];
    while (pending.length) {
      const dir = pending.pop()!;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (error) {
        if (dir === root) warnings.push(`Cannot scan ${root}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(full);
          if (files.length >= limit) { truncated = true; return { files, warnings, truncated }; }
        }
      }
    }
  }
  return { files, warnings, truncated };
}

function parseLine(line: string): any | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}
function textContent(message: any, includeToolCalls = false): string {
  const content = message?.content;
  if (typeof content === "string") return message.role === "user" || message.role === "assistant" ? content : "";
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (part?.type === "text") return part.text ?? "";
    if (includeToolCalls && part?.type === "toolCall") return `Tool call: ${part.name}(${JSON.stringify(part.arguments ?? {})})`;
    return "";
  }).filter(Boolean).join("\n");
}

export async function readMetadata(file: string): Promise<SessionMetadata | undefined> {
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(file); } catch { return undefined; }
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const headBuffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    await handle.read(headBuffer, 0, headBuffer.length, 0);
    const head = headBuffer.toString("utf8");
    const headLines = head.split(/\r?\n/);
    const header = parseLine(headLines[0] ?? "");
    let preview: string | undefined;
    let name: string | undefined;
    for (const line of headLines.slice(1)) {
      const entry = parseLine(line);
      if (!entry) continue;
      if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
      if (entry.type === "message" && entry.message?.role === "user") {
        preview ??= textContent(entry.message).replace(/\s+/g, " ").slice(0, 300);
      }
    }
    const tailLength = Math.min(TAIL_BYTES, stat.size);
    const tailBuffer = Buffer.alloc(tailLength);
    await handle.read(tailBuffer, 0, tailLength, Math.max(0, stat.size - tailLength));
    const tailLines = tailBuffer.toString("utf8").split(/\r?\n/).reverse();
    let latestTimestamp: string | undefined;
    for (const line of tailLines) {
      const entry = parseLine(line);
      if (!entry) continue;
      latestTimestamp ??= entry.timestamp;
      if (entry.type === "session_info" && typeof entry.name === "string") { name = entry.name; break; }
    }
    return {
      path: canonicalPath(file), mtimeMs: stat.mtimeMs, size: stat.size,
      ...(typeof header?.id === "string" ? { id: header.id } : {}),
      ...(typeof header?.timestamp === "string" ? { timestamp: header.timestamp } : {}),
      ...(typeof header?.cwd === "string" ? { cwd: header.cwd } : {}),
      ...(name ? { name } : {}), ...(preview ? { preview } : {}),
      ...(latestTimestamp ? { latestTimestamp } : {}),
    };
  } catch { return undefined; }
  finally { await handle?.close(); }
}

export async function* streamLines(file: string, maxBytes = Number.POSITIVE_INFINITY): AsyncGenerator<{ line: string; bytes: number }> {
  const stat = await fs.promises.stat(file);
  if (stat.size === 0 || maxBytes <= 0) return;
  const end = Math.min(stat.size - 1, Math.max(0, maxBytes - 1));
  const stream = fs.createReadStream(file, { encoding: "utf8", ...(Number.isFinite(maxBytes) ? { start: 0, end } : {}) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield { line, bytes: Buffer.byteLength(line, "utf8") + 1 };
  } finally { lines.close(); stream.destroy(); }
}

export async function* streamEntries(file: string, maxBytes = Number.POSITIVE_INFINITY): AsyncGenerator<any> {
  for await (const { line } of streamLines(file, maxBytes)) {
    const entry = parseLine(line);
    if (entry) yield entry;
  }
}

export function searchableText(entry: any, includeToolCalls: boolean): string {
  if (entry?.type !== "message") return "";
  const role = entry.message?.role;
  if (role !== "user" && role !== "assistant" && !(includeToolCalls && role === "toolResult")) return "";
  if (role === "toolResult") return textContent({ role: "user", content: entry.message.content });
  return textContent(entry.message, includeToolCalls);
}

/** Slice around a UTF-16 match offset without splitting a surrogate pair. */
export function excerptAround(text: string, position: number, length = 240): string {
  const chars = Array.from(text);
  const offset = Array.from(text.slice(0, Math.max(0, position))).length;
  const start = Math.max(0, offset - Math.floor(length / 3));
  const end = Math.min(chars.length, start + length);
  return `${start ? "…" : ""}${chars.slice(start, end).join("").replace(/\s+/g, " ").trim()}${end < chars.length ? "…" : ""}`;
}

/**
 * Scan candidate sessions for every term. The raw JSON line is filtered before
 * parsing, so a non-matching line costs a lowercase scan instead of JSON.parse.
 * Caps bound wall clock and I/O; `capped` reports that some candidates were skipped.
 */
export async function scanKeywords(
  candidates: SessionMetadata[], terms: string[], includeToolCalls = false,
  options: { fileLimit?: number; byteLimit?: number; deadlineMs?: number; now?: number | (() => number) } = {},
): Promise<{ matches: SearchMatch[]; scanned: number; total: number; capped: boolean; bytesRead: number }> {
  const fileLimit = options.fileLimit ?? SEARCH_FILE_LIMIT;
  const byteLimit = options.byteLimit ?? SEARCH_BYTE_LIMIT;
  const now = () => typeof options.now === "function" ? options.now() : options.now ?? Date.now();
  const deadline = now() + (options.deadlineMs ?? SEARCH_DEADLINE_MS);
  const ordered = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const needles = terms.map((term) => term.toLocaleLowerCase()).filter(Boolean);
  const matches: SearchMatch[] = [];
  let scanned = 0, bytesRead = 0, capped = false;
  for (const metadata of ordered) {
    if (scanned >= fileLimit || bytesRead >= byteLimit || now() >= deadline) { capped = true; break; }
    scanned++;
    let hitCount = 0;
    const foundTerms = new Set<string>();
    let first: { text: string; position: number } | undefined;
    try {
      for await (const { line, bytes } of streamLines(metadata.path, byteLimit - bytesRead)) {
        bytesRead += bytes;
        if (bytesRead >= byteLimit) capped = true;
        const raw = line.toLocaleLowerCase();
        const maybeMatch = needles.some((needle) => raw.includes(needle));
        const text = maybeMatch ? searchableText(parseLine(line), includeToolCalls) : "";
        if (text) {
          const lower = text.toLocaleLowerCase();
          for (const needle of needles) if (lower.includes(needle)) foundTerms.add(needle);
          if (needles.every((needle) => lower.includes(needle))) {
            hitCount = Math.min(20, hitCount + 1);
            first ??= { text, position: lower.indexOf(needles[0]) };
          } else if (!first) {
            const matched = needles.find((needle) => lower.includes(needle));
            if (matched) first = { text, position: lower.indexOf(matched) };
          }
        }
        if (capped) break;
        if (now() >= deadline) { capped = true; break; }
      }
    } catch { /* an unreadable candidate is skipped, not fatal */ }
    if (needles.every((needle) => foundTerms.has(needle)) && first) {
      matches.push({ metadata, excerpt: excerptAround(first.text, first.position), hits: Math.max(1, hitCount) });
    }
    if (capped) break;
  }
  return { matches, scanned, total: ordered.length, capped, bytesRead };
}

export const CONSULT_SCAN_LIMITS = { files: SEARCH_FILE_LIMIT, bytes: SEARCH_BYTE_LIMIT, deadlineMs: SEARCH_DEADLINE_MS };
