#!/usr/bin/env python3
"""Check one converted chapter against the scan, and report coverage.

    check.py books/ch03.xml --text /tmp/book/text.txt --range 53,84 --chapter 3

What it measures:
  * sections, paragraphs, figures, problems and equation ids present
  * numbered equations printed in the scan but missing from the XML
    (the expected list is scraped from the OCR dump, so a number split across a
    line break can be missed - treat the gaps as "look here", not gospel)
  * figure/equation ids referenced but never defined, and ids defined twice

Exit status is 0 even with gaps: this is a coverage report, not a gate. The
build tool is the gate (it refuses unknown elements and unresolved hard refs).
"""

from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


def expected_equations(text: Path, lo: int, hi: int, chapter: int) -> set[int]:
    pages = text.read_text(errors="replace").split("\f")
    nums: set[int] = set()
    for page in pages[lo - 1:hi]:
        for m in re.finditer(rf"\({chapter}[-–](\d{{1,3}})\)", page):
            nums.add(int(m.group(1)))
    return nums


def spans(nums: list[int]) -> str:
    if not nums:
        return "-"
    out, start = [], nums[0]
    for prev, cur in zip(nums, nums[1:] + [None]):
        if cur != prev + 1:
            out.append(f"{start}" if start == prev else f"{start}-{prev}")
            start = cur
    return ", ".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("chapter_xml", type=Path)
    ap.add_argument("--text", type=Path, help="text dump from pdf_probe.py dump")
    ap.add_argument("--range", help="page range in the PDF, e.g. 53,84")
    ap.add_argument("--chapter", type=int, help="chapter number used in equation numbers")
    args = ap.parse_args()

    root = ET.parse(args.chapter_xml).getroot()
    counts = {tag: sum(1 for _ in root.iter(tag))
              for tag in ("section", "p", "fig", "table", "demo", "problem")}
    print(f"{args.chapter_xml.name}: " + ", ".join(f"{v} {k}" for k, v in counts.items() if v))

    ids = [n.get("id") for n in root.iter() if n.get("id")]
    dupes = [k for k, v in Counter(ids).items() if v > 1]
    if dupes:
        print(f"  duplicate ids: {sorted(dupes)[:8]}")

    refs = {n.get("to") for n in root.iter("ref") if n.get("to")}
    missing_local = sorted(r for r in refs if r not in set(ids) and r.startswith(("fig-", "eq-", "s")))
    if missing_local:
        print(f"  refs with no target in this chapter: {missing_local[:8]}"
              f"  (cross-chapter refs are expected here)")

    if args.text and args.range and args.chapter:
        lo, hi = (int(v) for v in args.range.split(","))
        want = expected_equations(args.text, lo, hi, args.chapter)
        have = {int(n.get("n").split("-")[1]) for n in root.iter("eq")
                if n.get("n") and "-" in n.get("n")}
        missing = sorted(want - have)
        print(f"  equations: {len(have)} present of {len(want)} seen in the scan")
        if missing:
            print(f"  missing numbers: {spans(missing)}")
        else:
            print("  no missing equation numbers")


if __name__ == "__main__":
    sys.exit(main())
