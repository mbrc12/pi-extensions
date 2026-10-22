#!/usr/bin/env python3
"""Make generic ids unique across chapters, then flatten includes into one file.

    normalize.py ids books/            # intro -> intro-6, problems -> problems-2, ...
    normalize.py flatten book.xml      # write book_all.xml with chapters inlined

Why: chapters written independently tend to reuse the same anchors (`intro`,
`problems`, `references`). Duplicate ids silently break cross-chapter links.
Namespacing by chapter fixes it without touching prose.

`flatten` produces a single XML containing every chapter, which is handy when
you want to ship one source file or feed the build a single input.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

GENERIC = ("intro", "introduction", "problems", "references", "footnotes",
           "index", "toc", "contents", "demos")


def normalise_ids(directory: Path) -> None:
    for path in sorted(directory.glob("ch*.xml")):
        m = re.search(r"(\d+)\.xml$", path.name)
        if not m:
            continue
        ch = int(m.group(1))
        text = path.read_text()
        changed = []
        for name in GENERIC:
            if f'id="{name}"' in text:
                text = text.replace(f'id="{name}"', f'id="{name}-{ch}"')
                text = text.replace(f'to="{name}"', f'to="{name}-{ch}"')
                changed.append(name)
        if changed:
            path.write_text(text)
            print(f"{path.name}: namespaced {', '.join(changed)}")


def flatten(book: Path) -> Path:
    text = book.read_text()
    out: list[str] = []
    for line in text.splitlines():
        m = re.search(r'<include src="([^"]+)"\s*/>', line)
        if not m:
            out.append(line)
            continue
        chapter = (book.parent / m.group(1)).read_text()
        chapter = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", chapter)
        out.append(chapter.rstrip())
    target = book.with_name(book.stem + "_all.xml")
    target.write_text("\n".join(out) + "\n")
    print(f"{target}  ({target.stat().st_size // 1024} KB)")
    return target


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("ids", help="namespaced generic ids per chapter")
    i.add_argument("directory", type=Path)
    f = sub.add_parser("flatten", help="inline <include> files into one XML")
    f.add_argument("book", type=Path)
    args = ap.parse_args()

    if args.cmd == "ids":
        normalise_ids(args.directory)
    else:
        flatten(args.book)


if __name__ == "__main__":
    main()
