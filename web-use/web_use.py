#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from urllib.parse import quote_plus

USER_AGENT = "Mozilla/5.0"
MAX_FETCH_TEXT = 20000


class WebUseError(RuntimeError):
    pass


def run_curl(*args: str) -> str:
    cmd = [
        "curl",
        "-L",
        "--compressed",
        "--fail",
        "--silent",
        "--show-error",
        "-A",
        USER_AGENT,
        *args,
    ]
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


@dataclass
class SearchResult:
    title: str
    url: str
    description: str
    site: str | None = None


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


def duckduckgo_search(query: str, limit: int) -> dict[str, object]:
    serp_html = run_curl("https://duckduckgo.com/?q=" + quote_plus(query) + "&ia=web")
    djs_match = re.search(r'https://links[.]duckduckgo[.]com/d[.]js[^"\']+', serp_html)
    if not djs_match:
        raise WebUseError("Could not find DuckDuckGo result payload URL")

    results_js = run_curl(djs_match.group(0))
    raw_array = extract_balanced_array(results_js, "DDG.pageLayout.load('d',")
    parsed = json.loads(raw_array)

    results: list[SearchResult] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        title = strip_html_fragment(str(item.get("t") or ""))
        url = str(item.get("u") or item.get("c") or "").strip()
        description = strip_html_fragment(str(item.get("a") or ""))
        site = strip_html_fragment(str(item.get("sn") or item.get("d") or "")) or None
        if not title or not url:
            continue
        results.append(SearchResult(title=title, url=url, description=description, site=site))
        if len(results) >= limit:
            break

    if not results:
        raise WebUseError("No search results parsed from DuckDuckGo")

    return {
        "mode": "search",
        "query": query,
        "results": [result.__dict__ for result in results],
    }


def fetch_url(url: str) -> dict[str, object]:
    body = run_curl(url)
    parser = VisibleTextParser()
    parser.feed(body)
    parser.close()

    page_title = parser.get_title()
    page_text = parser.get_text()

    if not page_text:
        raise WebUseError("Fetched page did not contain readable text")

    truncated = len(page_text) > MAX_FETCH_TEXT
    model_text = page_text[:MAX_FETCH_TEXT]

    return {
        "mode": "fetch",
        "url": url,
        "page_title": page_title,
        "page_text": model_text,
        "text_length": len(page_text),
        "truncated": truncated,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="DuckDuckGo search + curl fetch helper")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--search", metavar="QUERY", help="Run a DuckDuckGo search")
    group.add_argument("--fetch", metavar="URL", help="Fetch a URL with curl and return readable text")
    parser.add_argument("--limit", type=int, default=5, help="Max search results to return")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = parser.parse_args()

    try:
        if args.search:
            payload = duckduckgo_search(args.search, max(1, min(args.limit, 10)))
        else:
            payload = fetch_url(args.fetch)
    except Exception as exc:  # noqa: BLE001
        json.dump({"error": str(exc)}, sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    json.dump(payload, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
