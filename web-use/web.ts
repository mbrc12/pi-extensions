/**
 * Web search and page fetch for the `web_use` tool.
 *
 * Backend order is set by SEARCH_BACKENDS and FETCH_BACKENDS below. Each backend:
 *   - "exa"  keyless Exa MCP (https://mcp.exa.ai/mcp)
 *   - "ddg"  DuckDuckGo no-JS HTML search
 *   - "curl" raw page fetch, text extracted by the parser in this file
 *
 * Optional env vars:
 *   EXA_MCP_URL   override the Exa MCP endpoint (default https://mcp.exa.ai/mcp)
 *   EXA_API_KEY   send as x-api-key to lift Exa's free-plan rate limits
 */

import { execFile } from "node:child_process";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
/** The no-JS search endpoint. The JS payload at `links.duckduckgo.com/d.js` is
 *  behind an anti-bot challenge (HTTP 202 with an anomaly page), so it is unusable. */
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** DuckDuckGo serves the challenge page unless the request looks like a browser. */
const DDG_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};
const CURL_TIMEOUT_MS = 20_000;
const DDG_TIMEOUT_MS = 20_000;
const MCP_TIMEOUT_MS = 30_000;

/**
 * Backend order for `mode=search`, tried left to right until one returns results.
 * Swap the two entries to prefer DuckDuckGo, or drop one to disable it.
 */
const SEARCH_BACKENDS: readonly WebBackend[] = ["ddg", "exa"];

/**
 * Backend order for `mode=fetch`, tried left to right until one returns a page.
 * curl comes first because it reads the live page and keeps the URL local; Exa is
 * the fallback for pages that block curl or render only client-side.
 */
const FETCH_BACKENDS: readonly WebBackend[] = ["curl", "exa"];
const MAX_FETCH_TEXT = 20_000;
const MAX_EXA_FETCH_CHARS = 20_000;
/** Generous because `mode=full` returns whole pages uncut, as the Python helper did. */
const MAX_CURL_OUTPUT = 64 * 1024 * 1024;

export class WebUseError extends Error {}

export type WebBackend = "auto" | "exa" | "ddg" | "curl";

export type SearchResult = {
  title: string;
  url: string;
  description: string;
  site?: string;
};

export type SearchPayload = {
  mode: "search";
  engine: "exa" | "duckduckgo";
  query: string;
  results: SearchResult[];
};

export type FetchPayload = {
  mode: "fetch";
  engine: "exa" | "curl";
  url: string;
  page_title: string;
  page_text: string;
  text_length: number;
  truncated: boolean;
};

export type FullPayload = {
  mode: "full";
  engine: "curl";
  url: string;
  html: string;
  html_length: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// curl helper
// ---------------------------------------------------------------------------

type CurlOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

function runCurl(args: string[], options: CurlOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CURL_TIMEOUT_MS;
  const command = [
    "-L",
    "--compressed",
    "--silent",
    "--show-error",
    "-A",
    BROWSER_UA,
    "--max-time",
    String(Math.max(1, Math.round(timeoutMs / 1_000))),
  ];
  command.push(...args);

  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      command,
      { encoding: "utf8", maxBuffer: MAX_CURL_OUTPUT, signal: options.signal },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") {
          reject(new WebUseError("web_use aborted"));
          return;
        }
        const detail = String(stderr).trim();
        const code = typeof error.code === "number" ? error.code : undefined;
        reject(new WebUseError(
          detail || (code === undefined ? error.message : `curl failed with exit code ${code}`),
        ));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// HTML text extraction
// ---------------------------------------------------------------------------

/**
 * Named character references worth decoding. Python's `html.unescape` covers the
 * full HTML5 table; this covers the entities that show up in real pages. Numeric
 * references are always decoded.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  middot: "\u00b7",
  deg: "\u00b0",
  plusmn: "\u00b1",
  times: "\u00d7",
  laquo: "\u00ab",
  raquo: "\u00bb",
  sect: "\u00a7",
  para: "\u00b6",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  frac12: "\u00bd",
  eacute: "\u00e9",
  egrave: "\u00e8",
  agrave: "\u00e0",
  ccedil: "\u00e7",
  uuml: "\u00fc",
  ouml: "\u00f6",
  auml: "\u00e4",
  szlig: "\u00df",
  ntilde: "\u00f1",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (!body.startsWith("#")) {
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    }
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}

/** Collapse every whitespace run, matching Python's `\s+` (which also covers U+00A0). */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Strip tags from an HTML fragment and flatten it, as the DuckDuckGo payload needs. */
export function stripHtmlFragment(value: string): string {
  if (!value) return "";
  return collapseWhitespace(decodeEntities(value.replace(/<[^>]+>/g, " ")));
}

/** Elements whose text is dropped, and the two whose contents are raw text. */
const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript", "svg"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
/** Elements that separate text, so adjacent words do not run together. */
const BLOCK_ELEMENTS = new Set([
  "p", "div", "section", "article", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
]);

type TagToken = { name: string; closing: boolean; end: number };

/** Read the tag starting at `start`, which must point at "<". */
function readTag(html: string, start: number): TagToken | undefined {
  let index = start + 1;
  const closing = html[index] === "/";
  if (closing) index += 1;

  const nameStart = index;
  while (index < html.length && /[a-zA-Z0-9:-]/.test(html[index])) index += 1;
  if (index === nameStart) return undefined;
  const name = html.slice(nameStart, index).toLowerCase();

  // Attribute values can contain ">", so skip over quoted spans.
  let quote = "";
  while (index < html.length) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return { name, closing, end: index + 1 };
    }
    index += 1;
  }
  // Unterminated tag: treat the rest of the document as its body.
  return { name, closing, end: html.length };
}

const CLOSE_TAG_PATTERNS = new Map<string, RegExp>();

function findCloseTag(html: string, name: string, from: number): number {
  let pattern = CLOSE_TAG_PATTERNS.get(name);
  if (!pattern) {
    pattern = new RegExp(`</${name}\\s*>`, "gi");
    CLOSE_TAG_PATTERNS.set(name, pattern);
  }
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  return match ? match.index : -1;
}

/**
 * Extract the title and visible text from an HTML document.
 *
 * This mirrors the Python `HTMLParser` subclass the helper used: script, style,
 * noscript, and svg content is dropped, block elements separate words, and the
 * result has every whitespace run collapsed to a single space.
 */
export function extractVisibleText(html: string): { title: string; text: string } {
  const skipStack: string[] = [];
  const titleParts: string[] = [];
  const textParts: string[] = [];
  let insideTitle = false;

  const pushData = (chunk: string): void => {
    if (!chunk || skipStack.length > 0) return;
    if (insideTitle) {
      titleParts.push(chunk);
      return;
    }
    textParts.push(chunk);
  };

  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) {
      pushData(html.slice(index));
      break;
    }
    pushData(html.slice(index, tagStart));

    if (html.startsWith("<!--", tagStart)) {
      const end = html.indexOf("-->", tagStart + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", tagStart) || html.startsWith("<?", tagStart)) {
      const end = html.indexOf(">", tagStart);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = readTag(html, tagStart);
    if (!tag) {
      // A bare "<" that does not open a tag, so it is text.
      pushData("<");
      index = tagStart + 1;
      continue;
    }

    if (tag.closing) {
      if (skipStack.length > 0 && skipStack[skipStack.length - 1] === tag.name) skipStack.pop();
      if (tag.name === "title") insideTitle = false;
      if (BLOCK_ELEMENTS.has(tag.name)) textParts.push("\n");
    } else if (SKIPPED_ELEMENTS.has(tag.name)) {
      skipStack.push(tag.name);
      if (RAW_TEXT_ELEMENTS.has(tag.name)) {
        // Script and style bodies are raw text: consume through the close tag.
        const closeStart = findCloseTag(html, tag.name, tag.end);
        if (closeStart === -1) {
          index = html.length;
          skipStack.pop();
          continue;
        }
        const closeTag = readTag(html, closeStart);
        index = closeTag ? closeTag.end : html.length;
        skipStack.pop();
        continue;
      }
    } else if (BLOCK_ELEMENTS.has(tag.name)) {
      textParts.push("\n");
    } else if (tag.name === "title") {
      insideTitle = true;
    }

    index = tag.end;
  }

  return {
    title: collapseWhitespace(decodeEntities(titleParts.join(""))),
    text: collapseWhitespace(decodeEntities(textParts.join(""))),
  };
}

// ---------------------------------------------------------------------------
// Exa MCP client (streamable HTTP, keyless)
// ---------------------------------------------------------------------------

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export function parseMcpSse(payload: string): Record<string, unknown> {
  const tryJson = (text: string): Record<string, unknown> | undefined => {
    try {
      const message = JSON.parse(text) as Record<string, unknown>;
      return message && ("result" in message || "error" in message) ? message : undefined;
    } catch {
      return undefined;
    }
  };

  let dataLines: string[] = [];
  for (const rawLine of payload.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s+/, ""));
      continue;
    }
    if (!line && dataLines.length > 0) {
      const message = tryJson(dataLines.join("\n"));
      dataLines = [];
      if (message) return message;
    }
  }
  if (dataLines.length > 0) {
    const message = tryJson(dataLines.join("\n"));
    if (message) return message;
  }
  throw new WebUseError("Could not parse Exa MCP SSE response");
}

type McpResult = { message: Record<string, unknown>; sessionId?: string };

async function mcpRequest(
  url: string,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<McpResult> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!method.startsWith("notifications/")) body.id = 1;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "web-use/1.0",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (apiKey) headers["x-api-key"] = apiKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combineSignals(signal, AbortSignal.timeout(MCP_TIMEOUT_MS)),
    });
  } catch (error) {
    throw new WebUseError(`Exa MCP request failed: ${errorText(error)}`);
  }

  const nextSessionId = response.headers.get("Mcp-Session-Id") ?? sessionId ?? undefined;
  if (!response.ok) {
    throw new WebUseError(`Exa MCP request failed: HTTP ${response.status}`);
  }

  const payload = await response.text();
  if (!payload.trim()) return { message: {}, sessionId: nextSessionId }; // e.g. a notification ACK
  if (payload.trimStart().startsWith("{")) {
    return { message: JSON.parse(payload) as Record<string, unknown>, sessionId: nextSessionId };
  }
  return { message: parseMcpSse(payload), sessionId: nextSessionId };
}

async function exaSession(
  signal: AbortSignal | undefined,
): Promise<{ url: string; sessionId: string; apiKey: string | undefined }> {
  const apiKey = process.env.EXA_API_KEY;
  const url = process.env.EXA_MCP_URL ?? EXA_MCP_URL;
  const initialized = await mcpRequest(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "web_use", version: "1.0" },
  }, undefined, apiKey, signal);
  if (!initialized.sessionId) throw new WebUseError("Exa MCP did not return a session id");

  try {
    await mcpRequest(url, "notifications/initialized", {}, initialized.sessionId, apiKey, signal);
  } catch {
    // Notifications are fire-and-forget; ignore any reply quirk.
  }
  return { url, sessionId: initialized.sessionId, apiKey };
}

function mcpText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

/** Parse the "-separated blocks Exa returns from `web_search_exa`. */
export function parseExaSearch(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const rawBlock of text.split(/\n-{3,}\n/)) {
    const block = rawBlock.trim();
    if (!block) continue;

    let title = "";
    let url = "";
    const body: string[] = [];
    for (const line of block.split("\n")) {
      if (!title && line.startsWith("Title:")) {
        title = line.slice(6).trim();
      } else if (!url && line.startsWith("URL:")) {
        url = line.slice(4).trim();
      } else if (line.startsWith("Published:") || line.startsWith("Author:") || line.startsWith("Highlights:")) {
        continue;
      } else {
        body.push(line);
      }
    }
    if (!title && !url) continue;

    const description = body.map((part) => part.trim()).filter(Boolean).join(" ").trim();
    results.push({ title, url, description });
  }
  return results;
}

/** Exa repeats the URL in the title slot when a page has no usable title. */
function isBareUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** Parse the title and body Exa returns from `web_fetch_exa`. */
export function parseExaFetch(text: string): { title: string; body: string } {
  const lines = text.split(/\r\n|\r|\n/);
  let title = "";
  let bodyStart = 0;
  for (const [index, line] of lines.slice(0, 4).entries()) {
    const stripped = line.trim();
    if (!title && stripped.startsWith("# ")) {
      title = stripped.slice(2).trim();
    } else if (!title && stripped.startsWith("Title:")) {
      title = stripped.slice(6).trim();
    }
    if (stripped === "" && index >= 1) {
      bodyStart = index + 1;
      break;
    }
  }
  const body = bodyStart ? lines.slice(bodyStart).join("\n").trim() : text.trim();
  return { title: isBareUrl(title) ? "" : title, body };
}

async function callExaTool(
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const session = await exaSession(signal);
  const { message } = await mcpRequest(
    session.url,
    "tools/call",
    { name, arguments: args },
    session.sessionId,
    session.apiKey,
    signal,
  );
  const result = (message.result ?? {}) as Record<string, unknown>;
  if (result.isError) {
    throw new WebUseError(`${name === "web_search_exa" ? "Exa search" : "Exa fetch"} error: ${mcpText(result)}`);
  }
  return result;
}

async function exaMcpSearch(query: string, limit: number, signal?: AbortSignal): Promise<SearchPayload> {
  const result = await callExaTool("web_search_exa", { query, numResults: limit }, signal);
  const text = mcpText(result);
  if (!text.trim()) throw new WebUseError("Exa search returned no content");

  const results = parseExaSearch(text);
  if (results.length === 0) throw new WebUseError("No search results parsed from Exa");
  return { mode: "search", engine: "exa", query, results };
}

async function exaMcpFetch(url: string, signal?: AbortSignal): Promise<FetchPayload> {
  const result = await callExaTool("web_fetch_exa", { urls: [url], maxCharacters: MAX_EXA_FETCH_CHARS }, signal);
  const text = mcpText(result);
  if (!text.trim()) throw new WebUseError("Exa fetch returned no content");

  const { title, body } = parseExaFetch(text);
  return {
    mode: "fetch",
    engine: "exa",
    url,
    page_title: title,
    page_text: body.slice(0, MAX_FETCH_TEXT),
    text_length: body.length,
    truncated: body.length > MAX_FETCH_TEXT,
  };
}

// ---------------------------------------------------------------------------
// DuckDuckGo search (hardened fallback)
// ---------------------------------------------------------------------------

/**
 * Pull the target URL out of a DuckDuckGo redirect link.
 *
 * Result links look like `//duckduckgo.com/l/?uddg=<encoded>&rut=<hash>`; a
 * direct link is returned unchanged, and links that stay on duckduckgo.com are
 * dropped because they are ads or internal pages rather than web results.
 */
export function unwrapDuckDuckGoUrl(href: string): string {
  const decoded = decodeEntities(href).trim();
  if (!decoded) return "";
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return "";
  }
  const target = parsed.searchParams.get("uddg");
  if (target) return target;
  if (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) return "";
  return absolute;
}

function findAnchor(block: string, className: string): { attributes: string; inner: string } | undefined {
  const pattern = new RegExp(
    `<a\\b([^>]*\\bclass="[^"]*\\b${className}\\b[^"]*"[^>]*)>([\\s\\S]*?)<\\/a>`,
    "i",
  );
  const match = pattern.exec(block);
  return match ? { attributes: match[1], inner: match[2] } : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Read the organic results out of the no-JS HTML page.
 *
 * Each result carries a `result__a` title link, so the page is walked anchor by
 * anchor rather than by container class, which DuckDuckGo changes more often.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const anchors = [...html.matchAll(/<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)];
  const results: SearchResult[] = [];

  for (const [index, match] of anchors.entries()) {
    if (results.length >= limit) break;

    const title = stripHtmlFragment(match[2]);
    const url = unwrapDuckDuckGoUrl(/\bhref="([^"]*)"/i.exec(match[1])?.[1] ?? "");
    if (!title || !url) continue;

    // Everything up to the next title link holds this result's snippet and site.
    const rest = html.slice(match.index, anchors[index + 1]?.index ?? html.length);
    const description = stripHtmlFragment(findAnchor(rest, "result__snippet")?.inner ?? "");
    const site = stripHtmlFragment(findAnchor(rest, "result__url")?.inner ?? "") || hostOf(url);
    results.push({ title, url, description, ...(site ? { site } : {}) });
  }
  return results;
}

async function duckduckgoSearch(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchPayload> {
  const url = `${DDG_HTML_URL}?${new URLSearchParams({ q: query, kl: "us-en" }).toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: DDG_HEADERS,
      redirect: "follow",
      signal: combineSignals(signal, AbortSignal.timeout(DDG_TIMEOUT_MS)),
    });
  } catch (error) {
    throw new WebUseError(`DuckDuckGo request failed: ${errorText(error)}`);
  }

  const html = await response.text();
  if (response.status === 202 || html.includes("anomaly-modal")) {
    throw new WebUseError("DuckDuckGo returned its bot challenge page");
  }
  if (!response.ok) {
    throw new WebUseError(`DuckDuckGo returned HTTP ${response.status}`);
  }

  const results = parseDuckDuckGoHtml(html, limit);
  if (results.length === 0) throw new WebUseError("No search results parsed from DuckDuckGo");
  return { mode: "search", engine: "duckduckgo", query, results };
}

// ---------------------------------------------------------------------------
// curl fetch (fallback) and full HTML
// ---------------------------------------------------------------------------

function requireHttpUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new WebUseError("URL must start with http:// or https://");
  }
}

async function curlFetchUrl(url: string, signal?: AbortSignal): Promise<FetchPayload> {
  const body = await runCurl([url], { signal });
  const { title, text } = extractVisibleText(body);
  if (!text) throw new WebUseError("Fetched page did not contain readable text");

  return {
    mode: "fetch",
    engine: "curl",
    url,
    page_title: title,
    page_text: text.slice(0, MAX_FETCH_TEXT),
    text_length: text.length,
    truncated: text.length > MAX_FETCH_TEXT,
  };
}

export async function curlFetchFull(url: string, signal?: AbortSignal): Promise<FullPayload> {
  // Guard the scheme so this cannot read local files or pass curl options.
  requireHttpUrl(url);
  const html = await runCurl([url], { signal });
  return { mode: "full", engine: "curl", url, html, html_length: html.length };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Run each backend in order and return the first success. When every backend
 * fails, the single-backend case rethrows the original error so its message
 * survives, and the multi-backend case names each failure.
 */
async function runBackends<T>(
  order: readonly WebBackend[],
  run: (backend: WebBackend) => Promise<T>,
  label: string,
): Promise<T> {
  const failures: string[] = [];
  let lastError: unknown;

  for (const backend of order) {
    try {
      return await run(backend);
    } catch (error) {
      lastError = error;
      failures.push(`${backend}: ${errorText(error)}`);
    }
  }
  if (failures.length === 1) throw lastError;
  throw new WebUseError(`${label} failed on every backend (${failures.join("; ")})`);
}

async function searchWith(
  backend: WebBackend,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<SearchPayload> {
  if (backend === "exa") return exaMcpSearch(query, limit, signal);
  if (backend === "ddg") return duckduckgoSearch(query, limit, signal);
  throw new WebUseError(`Backend "${backend}" cannot search`);
}

async function fetchWith(
  backend: WebBackend,
  url: string,
  signal: AbortSignal | undefined,
): Promise<FetchPayload> {
  if (backend === "exa") return exaMcpFetch(url, signal);
  if (backend === "curl") return curlFetchUrl(url, signal);
  throw new WebUseError(`Backend "${backend}" cannot fetch a page`);
}

/**
 * Search the web. `backend` selects one backend; leaving it at "auto" uses
 * SEARCH_BACKENDS in order.
 */
export async function runSearch(
  query: string,
  limit = 5,
  backend: WebBackend = "auto",
  signal?: AbortSignal,
): Promise<SearchPayload> {
  const cappedLimit = Math.max(1, Math.min(limit, 10));
  const order = backend === "auto" ? SEARCH_BACKENDS : [backend];
  return runBackends(order, (name) => searchWith(name, query, cappedLimit, signal), "search");
}

/**
 * Fetch a page and return its text. `backend` selects one backend; leaving it at
 * "auto" uses FETCH_BACKENDS in order.
 */
export async function runFetch(
  url: string,
  backend: WebBackend = "auto",
  signal?: AbortSignal,
): Promise<FetchPayload> {
  requireHttpUrl(url);
  const order = backend === "auto" ? FETCH_BACKENDS : [backend];
  return runBackends(order, (name) => fetchWith(name, url, signal), "fetch");
}
