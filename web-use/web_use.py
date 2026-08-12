#!/usr/bin/env python3
"""web_use helper: web search + page fetch for the pi web_use extension.

Backends, in order:
  - Exa MCP (keyless, https://mcp.exa.ai/mcp)  -- primary for search and fetch
  - DuckDuckGo scrape (hardened)              -- search fallback
  - curl                                      -- raw HTML (--full), fetch fallback

Optional env vars:
  EXA_MCP_URL   override the Exa MCP endpoint (default https://mcp.exa.ai/mcp)
  EXA_API_KEY   send as x-api-key to lift Exa's free-plan rate limits
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from html import unescape
from html.parser import HTMLParser
from urllib.parse import quote_plus

EXA_MCP_URL = "https://mcp.exa.ai/mcp"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
CURL_TIMEOUT = 20
MCP_TIMEOUT = 30
MAX_FETCH_TEXT = 20000
MAX_EXA_FETCH_CHARS = 20000


class WebUseError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# curl helpers
# --------------------------------------------------------------------------

def run_curl(*args: str, cookie_jar: str | None = None, timeout: int = CURL_TIMEOUT) -> str:
    cmd = [
        "curl", "-L", "--compressed", "--silent", "--show-error",
        "-A", BROWSER_UA, "--max-time", str(timeout),
    ]
    if cookie_jar:
        cmd += ["-b", cookie_jar, "-c", cookie_jar]
    cmd += list(args)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise WebUseError(result.stderr.strip() or f"curl failed with exit code {result.returncode}")
    return result.stdout


def extract_balanced_array(text: str, marker: str) -> str:
    marker_index = text.find(marker)
    if marker_index == -1:
        raise WebUseError(f"Could not find marker: {marker}")

    start = text.find("[", marker_index)
    if start == -1:
        raise WebUseError("Could not find JSON array start")

    depth = 0
    in_string = False
    escape = False

    for index in range(start, len(text)):
        ch = text[index]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]

    raise WebUseError("Could not find JSON array end")


TAG_RE = re.compile(r"<[^>]+>")
WHITESPACE_RE = re.compile(r"\s+")


def strip_html_fragment(value: str | None) -> str:
    if not value:
        return ""
    cleaned = TAG_RE.sub(" ", value)
    cleaned = unescape(cleaned)
    return WHITESPACE_RE.sub(" ", cleaned).strip()


class VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.skip_stack: list[str] = []
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self._inside_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self.skip_stack.append(tag)
        elif tag in {"p", "div", "section", "article", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.text_parts.append("\n")
        elif tag == "title":
            self._inside_title = True

    def handle_endtag(self, tag: str) -> None:
        if self.skip_stack and self.skip_stack[-1] == tag:
            self.skip_stack.pop()
        if tag == "title":
            self._inside_title = False
        if tag in {"p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.text_parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_stack:
            return
        if self._inside_title:
            self.title_parts.append(data)
            return
        self.text_parts.append(data)

    def get_title(self) -> str:
        return WHITESPACE_RE.sub(" ", "".join(self.title_parts)).strip()

    def get_text(self) -> str:
        text = unescape("".join(self.text_parts))
        text = re.sub(r"\n\s*\n+", "\n\n", text)
        text = WHITESPACE_RE.sub(" ", text)
        return text.strip()


# --------------------------------------------------------------------------
# Exa MCP client (streamable HTTP, keyless)
# --------------------------------------------------------------------------

def _mcp_request(
    url: str,
    method: str,
    params: dict,
    session_id: str | None,
    api_key: str | None,
) -> tuple[dict, str | None]:
    body: dict = {"jsonrpc": "2.0", "method": method, "params": params}
    if not method.startswith("notifications/"):
        body["id"] = 1
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "web-use/1.0",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    if api_key:
        headers["x-api-key"] = api_key

    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=MCP_TIMEOUT) as resp:
            session_id = resp.headers.get("Mcp-Session-Id") or session_id
            payload = resp.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise WebUseError(f"Exa MCP request failed: {exc}") from exc

    if not payload.strip():
        return {}, session_id  # e.g. notification ACK with empty body

    if payload.lstrip().startswith("{"):
        return json.loads(payload), session_id

    return _parse_sse(payload), session_id


def _parse_sse(payload: str) -> dict:
    def try_json(text: str) -> dict | None:
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            return None
        return msg if ("result" in msg or "error" in msg) else None

    data_lines: list[str] = []
    for line in payload.splitlines():
        line = line.rstrip("\r")
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line and data_lines:
            msg = try_json("\n".join(data_lines))
            data_lines = []
            if msg:
                return msg
    if data_lines:
        msg = try_json("\n".join(data_lines))
        if msg:
            return msg
    raise WebUseError("Could not parse Exa MCP SSE response")


def _exa_session() -> tuple[str, str, str | None]:
    api_key = os.environ.get("EXA_API_KEY")
    url = os.environ.get("EXA_MCP_URL", EXA_MCP_URL)
    msg, session_id = _mcp_request(url, "initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "web_use", "version": "1.0"},
    }, None, api_key)
    if not session_id:
        raise WebUseError("Exa MCP did not return a session id")
    try:
        _mcp_request(url, "notifications/initialized", {}, session_id, api_key)
    except Exception:
        pass  # notifications are fire-and-forget; ignore any reply quirk
    return url, session_id, api_key


def _mcp_text(result: dict) -> str:
    parts = []
    for content in result.get("content", []) or []:
        if content.get("type") == "text":
            parts.append(content.get("text") or "")
    return "\n".join(parts)


def _parse_exa_search(text: str) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for block in re.split(r"\n-{3,}\n", text):
        block = block.strip()
        if not block:
            continue
        title = ""
        url = ""
        body: list[str] = []
        for line in block.splitlines():
            if line.startswith("Title:") and not title:
                title = line[6:].strip()
            elif line.startswith("URL:") and not url:
                url = line[4:].strip()
            elif line.startswith(("Published:", "Author:", "Highlights:")):
                continue
            else:
                body.append(line)
        if not title and not url:
            continue
        description = " ".join(part.strip() for part in body if part.strip()).strip()
        results.append({"title": title, "url": url, "description": description})
    return results


def exa_mcp_search(query: str, limit: int) -> dict[str, object]:
    url, session_id, api_key = _exa_session()
    msg, session_id = _mcp_request(url, "tools/call", {
        "name": "web_search_exa",
        "arguments": {"query": query, "numResults": limit},
    }, session_id, api_key)
    result = msg.get("result") or {}
    if result.get("isError"):
        raise WebUseError("Exa search error: " + _mcp_text(result))
    text = _mcp_text(result)
    if not text.strip():
        raise WebUseError("Exa search returned no content")
    results = _parse_exa_search(text)
    if not results:
        raise WebUseError("No search results parsed from Exa")
    return {"mode": "search", "engine": "exa", "query": query, "results": results}


def _parse_exa_fetch(text: str) -> tuple[str, str]:
    lines = text.splitlines()
    title = ""
    body_start = 0
    for i, line in enumerate(lines[:4]):
        stripped = line.strip()
        if not title and stripped.startswith("# "):
            title = stripped[2:].strip()
        elif not title and stripped.startswith("Title:"):
            title = stripped[6:].strip()
        if stripped == "" and i >= 1:
            body_start = i + 1
            break
    body = "\n".join(lines[body_start:]).strip() if body_start else text.strip()
    return title, body


def exa_mcp_fetch(url: str) -> dict[str, object]:
    mcp_url, session_id, api_key = _exa_session()
    msg, session_id = _mcp_request(mcp_url, "tools/call", {
        "name": "web_fetch_exa",
        "arguments": {"urls": [url], "maxCharacters": MAX_EXA_FETCH_CHARS},
    }, session_id, api_key)
    result = msg.get("result") or {}
    if result.get("isError"):
        raise WebUseError("Exa fetch error: " + _mcp_text(result))
    text = _mcp_text(result)
    if not text.strip():
        raise WebUseError("Exa fetch returned no content")
    page_title, body = _parse_exa_fetch(text)
    truncated = len(body) > MAX_FETCH_TEXT
    return {
        "mode": "fetch",
        "engine": "exa",
        "url": url,
        "page_title": page_title,
        "page_text": body[:MAX_FETCH_TEXT],
        "text_length": len(body),
        "truncated": truncated,
    }


# --------------------------------------------------------------------------
# DuckDuckGo search (hardened fallback)
# --------------------------------------------------------------------------

def duckduckgo_search(query: str, limit: int) -> dict[str, object]:
    jar = tempfile.NamedTemporaryFile(prefix="web_use_cookies_", suffix=".txt", delete=False)
    jar_path = jar.name
    jar.close()
    last_err = "DuckDuckGo search failed"
    try:
        for _attempt in range(2):
            try:
                serp_html = run_curl(
                    "https://duckduckgo.com/?q=" + quote_plus(query) + "&ia=web",
                    cookie_jar=jar_path,
                )
                djs_match = re.search(r"https://links[.]duckduckgo[.]com/d[.]js[^\"']+", serp_html)
                if not djs_match:
                    raise WebUseError("Could not find DuckDuckGo result payload URL (bot challenge page)")
                results_js = run_curl(djs_match.group(0), cookie_jar=jar_path)
                raw_array = extract_balanced_array(results_js, "DDG.pageLayout.load('d',")
                parsed = json.loads(raw_array)

                results: list[dict[str, str | None]] = []
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    title = strip_html_fragment(str(item.get("t") or ""))
                    url = str(item.get("u") or item.get("c") or "").strip()
                    description = strip_html_fragment(str(item.get("a") or ""))
                    site = strip_html_fragment(str(item.get("sn") or item.get("d") or "")) or None
                    if not title or not url:
                        continue
                    results.append({"title": title, "url": url, "description": description, "site": site})
                    if len(results) >= limit:
                        break

                if not results:
                    raise WebUseError("No search results parsed from DuckDuckGo")
                return {"mode": "search", "engine": "duckduckgo", "query": query, "results": results}
            except WebUseError as exc:
                last_err = str(exc)
        raise WebUseError(last_err)
    finally:
        try:
            os.unlink(jar_path)
        except OSError:
            pass


# --------------------------------------------------------------------------
# curl fetch (fallback) / full HTML
# --------------------------------------------------------------------------

def curl_fetch_url(url: str) -> dict[str, object]:
    body = run_curl(url)
    parser = VisibleTextParser()
    parser.feed(body)
    parser.close()

    page_title = parser.get_title()
    page_text = parser.get_text()

    if not page_text:
        raise WebUseError("Fetched page did not contain readable text")

    truncated = len(page_text) > MAX_FETCH_TEXT
    return {
        "mode": "fetch",
        "engine": "curl",
        "url": url,
        "page_title": page_title,
        "page_text": page_text[:MAX_FETCH_TEXT],
        "text_length": len(page_text),
        "truncated": truncated,
    }


def curl_fetch_full(url: str) -> dict[str, object]:
    body = run_curl(url)
    return {
        "mode": "full",
        "engine": "curl",
        "url": url,
        "html": body,
        "html_length": len(body),
    }


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------

def run_search(query: str, limit: int, backend: str) -> dict[str, object]:
    exa_err: str | None = None
    if backend in ("exa", "auto"):
        try:
            return exa_mcp_search(query, limit)
        except Exception as exc:  # noqa: BLE001 - fall through to next backend
            if backend == "exa":
                raise
            exa_err = str(exc)
    try:
        return duckduckgo_search(query, limit)
    except Exception as exc:  # noqa: BLE001
        if exa_err:
            raise WebUseError(f"Exa failed ({exa_err}); DuckDuckGo fallback failed ({exc})") from exc
        raise


def run_fetch(url: str, backend: str) -> dict[str, object]:
    if not url.startswith(("http://", "https://")):
        raise WebUseError("URL must start with http:// or https://")
    exa_err: str | None = None
    if backend in ("exa", "auto"):
        try:
            return exa_mcp_fetch(url)
        except Exception as exc:  # noqa: BLE001
            if backend == "exa":
                raise
            exa_err = str(exc)
    try:
        return curl_fetch_url(url)
    except Exception as exc:  # noqa: BLE001
        if exa_err:
            raise WebUseError(f"Exa failed ({exa_err}); curl fallback failed ({exc})") from exc
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Web search + fetch helper (Exa MCP primary, DuckDuckGo fallback)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--search", metavar="QUERY", help="Run a web search")
    group.add_argument("--fetch", metavar="URL", help="Fetch a URL and return readable text")
    group.add_argument("--full", metavar="URL", help="Fetch the full HTML of a URL")
    parser.add_argument("--limit", type=int, default=5, help="Max search results to return")
    parser.add_argument("--backend", choices=["auto", "exa", "ddg", "curl"], default="auto",
                        help="Backend selection (auto tries Exa first, then falls back)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = parser.parse_args()

    try:
        if args.search:
            payload = run_search(args.search, max(1, min(args.limit, 10)), args.backend)
        elif args.full:
            payload = curl_fetch_full(args.full)
        else:
            payload = run_fetch(args.fetch, args.backend)
    except Exception as exc:  # noqa: BLE001
        json.dump({"error": str(exc)}, sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    json.dump(payload, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
