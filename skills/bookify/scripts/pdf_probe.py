#!/usr/bin/env python3
"""Map a scanned PDF: page ranges per chapter, OCR text, and word bounding boxes.

bookify works from two dumps per PDF, both produced here:

  <work>/text.txt    layout-preserving text, pages separated by form feeds
  <work>/bbox.html   word bounding boxes (XHTML), used to crop figures/equations

Usage:
    pdf_probe.py dump   book.pdf --work /tmp/book
    pdf_probe.py ranges book.pdf --titles titles.txt
    pdf_probe.py page   book.pdf 42 --out /tmp/page42.png --dpi 200
    pdf_probe.py crop   book.pdf 42 --frac 0.10,0.30,0.90,0.55 --out fig.png
    pdf_probe.py crop   book.pdf 42 --points 40,120,420,300 --out fig.png

`ranges` guesses chapter starts by matching chapter titles near the top of each
page and prints a table plus a ready-to-edit mapping. Always eyeball the result:
running heads ("CHAPTER 4 ...") appear on every page and produce false hits, so
the matcher only looks at the first lines of a page and ignores pages before the
contents pages (--skip).

Requires poppler-utils: pdftotext, pdftoppm.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


# --------------------------------------------------------------------- dumps
def dump(pdf: Path, work: Path) -> None:
    work.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pdftotext", "-layout", str(pdf), str(work / "text.txt")], check=True)
    subprocess.run(["pdftotext", "-bbox-layout", str(pdf), str(work / "bbox.html")], check=True)
    pages = len((work / "text.txt").read_text(errors="replace").split("\f")) - 1
    print(f"text.txt and bbox.html written to {work}  ({pages} pages)")


def read_pages(work: Path) -> list[str]:
    return (work / "text.txt").read_text(errors="replace").split("\f")


# ------------------------------------------------------------- chapter ranges
def ranges(pdf: Path, work: Path, titles: Path, skip: int, top: int) -> None:
    """titles.txt holds one chapter title per line, in order."""
    wanted = [t.strip() for t in titles.read_text().splitlines() if t.strip()]
    pages = read_pages(work)

    def head(page: str, chars: int = 120) -> str:
        return re.sub(r"\s+", " ", " ".join(page.splitlines()[:top]))[:chars].lower()

    starts: list[tuple[str, int]] = []
    for title in wanted:
        needle = re.sub(r"[^a-z0-9 ]", " ", title.lower()).split()
        needle = " ".join(needle[:4])
        found = None
        for i, page in enumerate(pages, 1):
            if i <= skip:
                continue
            if needle and needle in re.sub(r"[^a-z0-9 ]", " ", head(page)):
                found = i
                break
        starts.append((title, found or -1))

    print(f"{'start':>6}  title")
    for title, start in starts:
        print(f"{start:>6}  {title[:70]}")

    # consecutive ranges, last = one page before the next start
    known = [(t, s) for t, s in starts if s > 0]
    print("\n# ranges.py: paste into your converter")
    for i, (title, start) in enumerate(known):
        end = (known[i + 1][1] - 1) if i + 1 < len(known) else len(pages) - 1
        print(f'    {start}: ({title!r}, {start}, {end}),')
    print("\n# first chapter should start at the first content page; verify by eye")


# ------------------------------------------------------------------- render
def render(pdf: Path, page: int, out: Path, dpi: int, frac=None, points=None) -> None:
    if points:
        x0, y0, x1, y1 = map(float, points.split(","))
        scale = dpi / 72.0
        box = [int(v * scale) for v in (x0, y0, x1 - x0, y1 - y0)]
    elif frac:
        # fractions of the page, converted with the MediaBox from pdftoppm
        fx0, fy0, fx1, fy1 = map(float, frac.split(","))
        width, height = media_box(pdf, page)
        scale = dpi / 72.0
        box = [int(fx0 * width * scale), int(fy0 * height * scale),
               int((fx1 - fx0) * width * scale), int((fy1 - fy0) * height * scale)]
    else:
        box = None

    args = ["pdftoppm", "-f", str(page), "-l", str(page), "-r", str(dpi),
            "-png", "-singlefile"]
    if box:
        args += ["-x", str(box[0]), "-y", str(box[1]), "-W", str(box[2]), "-H", str(box[3])]
    args += [str(pdf), str(out.with_suffix(""))]
    subprocess.run(args, check=True)
    print(out)


def media_box(pdf: Path, page: int) -> tuple[float, float]:
    out = subprocess.run(["pdfinfo", "-f", str(page), "-l", str(page), str(pdf)],
                         capture_output=True, text=True, check=True).stdout
    m = re.search(r"Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)", out)
    if not m:
        raise SystemExit("could not read the page size from pdfinfo")
    return float(m.group(1)), float(m.group(2))


# --------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("dump", help="write text.txt and bbox.html")
    d.add_argument("pdf", type=Path)
    d.add_argument("--work", type=Path, default=Path("/tmp/bookify"))

    r = sub.add_parser("ranges", help="guess chapter page ranges")
    r.add_argument("pdf", type=Path)
    r.add_argument("--titles", type=Path, required=True, help="one chapter title per line")
    r.add_argument("--work", type=Path, default=Path("/tmp/bookify"))
    r.add_argument("--skip", type=int, default=0, help="ignore pages before this one (contents pages)")
    r.add_argument("--top", type=int, default=3, help="how many first lines to inspect")

    p = sub.add_parser("page", help="render one whole page")
    p.add_argument("pdf", type=Path)
    p.add_argument("page", type=int)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--dpi", type=int, default=200)

    c = sub.add_parser("crop", help="render one region of a page")
    c.add_argument("pdf", type=Path)
    c.add_argument("page", type=int)
    c.add_argument("--out", type=Path, required=True)
    c.add_argument("--dpi", type=int, default=300)
    c.add_argument("--frac", help="x0,y0,x1,y1 as fractions of the page")
    c.add_argument("--points", help="x0,y0,x1,y1 in PDF points")

    args = ap.parse_args()
    if args.cmd == "dump":
        dump(args.pdf, args.work)
    elif args.cmd == "ranges":
        ranges(args.pdf, args.work, args.titles, args.skip, args.top)
    else:
        render(args.pdf, args.page, args.out, args.dpi,
               frac=args.frac, points=args.points)


if __name__ == "__main__":
    main()
