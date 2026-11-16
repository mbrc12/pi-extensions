#!/usr/bin/env bash
# selftest.sh — prove the toolchain and the skill's own assets still work.
# Compiles the bundled example figure end to end (PDF -> PNG preview -> SVG)
# in a throwaway temp dir. Nothing is written outside $TMPDIR.
# usage: bash selftest.sh [--keep]   (--keep prints the temp dir instead of removing it)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
keep=""
[ "${1:-}" = "--keep" ] && keep=1

work="$(mktemp -d)"
trap '[ -n "$keep" ] || rm -rf "$work"' EXIT

cp "$root/assets/preamble.tex" "$root"/assets/example/* "$work"/
cd "$work"

fail=0
step() { printf '  %-28s' "$1"; }
ok()   { echo "[ok]"; }
bad()  { echo "[FAIL] $1"; fail=1; }

step "compile example-figure.tex"; bash "$here/compile.sh" example-figure.tex >/dev/null 2>&1 \
  && [ -s example-figure.pdf ] && ok || bad "see $work/example-figure.log"
step "preview -> PNG"; bash "$here/preview.sh" example-figure.pdf >/dev/null 2>&1 \
  && [ -s example-figure.preview.png ] && ok || bad "pdftoppm failed"
step "export -> SVG"; bash "$here/export_svg.sh" example-figure.tex >/dev/null 2>&1 \
  && [ -s example-figure.svg ] && ok || bad "dvisvgm --pdf failed (needs mutool)"

echo
if [ "$fail" = 0 ]; then
  echo "SELFTEST PASS — toolchain and assets are good."
  if [ -n "$keep" ]; then echo "artifacts: $work"; fi
else
  echo "SELFTEST FAIL — artifacts kept at $work"
  exit 1
fi
