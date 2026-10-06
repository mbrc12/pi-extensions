#!/usr/bin/env python3
"""Validate a hierarchical claim-tree HTML file using only the standard library."""

from __future__ import annotations

import re
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(message, file=sys.stderr)


def main() -> int:
    if len(sys.argv) != 2:
        fail("Usage: python3 validate_tree.py <html-file>")
        return 2

    path = Path(sys.argv[1])
    html = path.read_text(encoding="utf-8")
    errors: list[str] = []

    claim_ids = re.findall(r'id="claim-([0-9-]+)"', html)
    numbers = re.findall(r'<span class="num">([0-9.]+)</span>', html)

    if not claim_ids:
        errors.append("No claim IDs found.")
    if len(set(claim_ids)) != len(claim_ids):
        errors.append("Claim IDs are not unique.")
    if len(claim_ids) != len(numbers):
        errors.append(
            f"Found {len(claim_ids)} claim IDs but {len(numbers)} displayed numbers."
        )

    for claim_id, number in zip(claim_ids, numbers):
        expected = claim_id.replace("-", ".")
        if number != expected:
            errors.append(
                f"ID claim-{claim_id} does not match displayed number {number}."
            )

    tag_pairs = (
        ("details", r"<details\b", r"</details>"),
        ("ordered lists", r"<ol\b", r"</ol>"),
        ("list items", r"<li\b", r"</li>"),
    )
    for label, opening, closing in tag_pairs:
        opens = len(re.findall(opening, html))
        closes = len(re.findall(closing, html))
        if opens != closes:
            errors.append(f"Unbalanced {label}: {opens} open, {closes} close.")

    placeholders = (
        "DOCUMENT_TITLE",
        "DOCUMENT_SCOPE_NOTE",
        "TOP_LEVEL_CLAIM",
        "CHILD_CLAIM_WITH_OPTIONAL_MATH",
        "SOURCE_URL",
        "SOURCE_CITATION",
    )
    for token in placeholders:
        if token in html:
            errors.append(f"Unreplaced template placeholder: {token}.")

    prose = re.sub(r"<script\b[\s\S]*?</script>", "", html, flags=re.IGNORECASE)
    prose = re.sub(r"<style\b[\s\S]*?</style>", "", prose, flags=re.IGNORECASE)

    if prose.count("$$") % 2:
        errors.append("Unbalanced $$ display-math delimiters.")
    if prose.count(r"\(") != prose.count(r"\)"):
        errors.append("Unbalanced inline-math delimiters.")

    math_patterns = (r"\$\$([\s\S]*?)\$\$", r"\\\(([\s\S]*?)\\\)")
    for pattern in math_patterns:
        for match in re.finditer(pattern, prose):
            if "<" in match.group(1):
                errors.append(
                    f"Raw < inside mathematics near character {match.start()}; use &lt;."
                )

    if errors:
        fail(f"Validation failed for {path}:")
        for error in errors:
            fail(f"- {error}")
        return 1

    print(
        f"Validated {path}: {len(claim_ids)} unique numbered claims; "
        "balanced tree tags and math delimiters."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
