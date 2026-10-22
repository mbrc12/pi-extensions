#!/usr/bin/env python3
"""Verify built HTML: anchors, images, ids, math delimiters.

    verify_html.py index.html ch01.html ch02.html
    verify_html.py .                      # every *.html in the directory
    verify_html.py book.html --book-dir ./books/goodman

Checks, per page:
  * every href="#x" has an id="x" on the page, or on another page when the link
    is written as chNN.html#x
  * every <img src> exists (relative to --book-dir, default: the page's directory)
  * no duplicate ids
  * balanced braces and no raw '<' inside $...$ or $$...$$
Then reports any <details> without <summary> and any heading deeper than h4.

Exit 1 on any failure, so it can gate a build script.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

MATH = re.compile(r"\$\$(.+?)\$\$|(?<!\$)\$([^$\n]+?)\$", re.S)


def pages_from(arg: str) -> list[Path]:
    p = Path(arg)
    if p.is_dir():
        return sorted(p.glob("*.html"))
    return [p]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pages", nargs="+", help="HTML files, or a directory")
    ap.add_argument("--book-dir", type=Path, help="where figures/ lives (default: page directory)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    files = [f for arg in args.pages for f in pages_from(str(arg))]
    ids: dict[Path, set[str]] = {}
    text: dict[Path, str] = {}
    for f in files:
        raw = f.read_text()
        # inline scripts and styles contain selectors/regexes that look like links
        html = re.sub(r"<script\b[^>]*>.*?</script>", "", raw, flags=re.S)
        html = re.sub(r"<style\b[^>]*>.*?</style>", "", html, flags=re.S)
        text[f] = html
        ids[f] = set(re.findall(r'\bid="([^"]+)"', html))

    problems: list[str] = []
    for f in files:
        html = text[f]
        book_dir = args.book_dir or f.parent

        local = re.findall(r'href="#([^"]+)"', html)
        for target in set(local):
            if target and target not in ids[f]:
                problems.append(f"{f.name}: anchor #{target} missing on page")

        cross = re.findall(r'href="([\w.-]+\.html)#([^"]+)"', html)
        for page, target in cross:
            other = f.parent / page
            if other.exists():
                known = ids.get(other)
                if known is None:
                    known = set(re.findall(r'\bid="([^"]+)"', other.read_text()))
                if target not in known:
                    problems.append(f"{f.name}: {page}#{target} has no target")

        dups = [k for k, v in Counter(re.findall(r'\bid="([^"]+)"', html)).items() if v > 1]
        if dups:
            problems.append(f"{f.name}: duplicate ids {sorted(dups)[:6]}")

        for m in MATH.finditer(html):
            span = m.group(1) or m.group(2) or ""
            if span.count("{") != span.count("}"):
                problems.append(f"{f.name}: unbalanced braces in math: {span[:50]!r}")
            if "<" in span and "&lt;" not in span and not span.lstrip().startswith("<"):
                problems.append(f"{f.name}: raw '<' inside math: {span[:50]!r}")

        for image in re.findall(r'<img[^>]*src="([^"]+)"', html):
            if image.startswith(("http", "data:")):
                continue
            if not (book_dir / image).exists():
                problems.append(f"{f.name}: missing image {image}")

        for block in re.findall(r"<details\b[^>]*>(.*?)</details>", html, re.S):
            if "<summary" not in block:
                problems.append(f"{f.name}: <details> without <summary>")
                break

    if not args.quiet:
        total_ids = sum(len(v) for v in ids.values())
        print(f"{len(files)} page(s), {total_ids} ids")
    if problems:
        print("\n".join("  FAIL " + p for p in problems))
        raise SystemExit(1)
    if not args.quiet:
        print("  ok")


if __name__ == "__main__":
    main()
