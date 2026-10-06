---
name: usage-report
description: >-
  Generate the pi token-usage report from ~/.pi/agent/sessions. Use when the
  user asks for token usage, cost, model breakdowns, time-of-day or session
  statistics, interruption metrics, or a pi usage report. Produces a single
  clean, professional, table-free HTML page with a fixed set of metrics,
  charts, and bespoke signals. HTML only: no PDF, no CSV, no download links.
version: 1
created: "2026-10-06"
updated: "2026-10-06"
compatibility: Requires the Python environment at /Users/subwave/dev/tmp/random-tasks/.venv. Charts and fonts load from CDNs, so viewing the report needs network access.
---

# Usage report

Build the pi token-usage report from the session logs. The report has a fixed
visual language and a fixed set of metrics; do not redesign it or re-derive the
numbers by hand. The two scripts in `scripts/` are the canonical implementation:

- `scripts/engine.py` — data engine. Reads the session JSONL files and returns
  `(rows, sessions, extras)`. Pure library: it renders nothing and writes nothing.
- `scripts/render.py` — renderer. Calls the engine and writes a single
  `index.html` into an output directory.

The deliverable is **one HTML file**. Do not produce a PDF, a CSV, or download
links.

Run everything relative to this skill directory.

## When to use

Use for any request about pi usage: total tokens, spend, per-model or per-project
breakdowns, daily/weekly trends, time-of-day rhythm, session length, cache
behaviour, or the bespoke signals (interruptions, autonomy, latency, tool errors,
code churn). Also use it to regenerate an existing report after new sessions.

## Quick start

```bash
SK=/Users/subwave/.pi/agent/extensions/skills/usage-report
PY=/Users/subwave/dev/tmp/random-tasks/.venv/bin/python

# writes <out>/index.html (default output dir is the skill's scripts/ dir)
"$PY" "$SK/scripts/render.py" /path/to/output
# or: USAGE_REPORT_OUT=/path/to/output "$PY" "$SK/scripts/render.py"
```

The only output is `<out>/index.html`, a self-contained page (Chart.js and fonts
come from CDNs). Open it with the local server link pattern from the project
instructions, for example `http://localhost:1002/<path-from-home>/index.html`.

## Data source

- Default glob: `~/.pi/agent/sessions/**/*.jsonl`.
- Override with `PI_SESSIONS_GLOB` (read by `engine.py`). It accepts a glob path,
  e.g. `PI_SESSIONS_GLOB='/tmp/fixtures/*.jsonl'`.
- Each file is one session. The first line is `{"type":"session",...,"cwd":...}`.
- Only messages carry usage. Assistant messages have `usage`; the `subagent` tool
  result also carries aggregate `usage` for delegated runs.

## Metric definitions (do not change)

All of these already live in `engine.collect()`. Reproduce them exactly if you
port the engine; changing a formula changes the report.

### Period totals

```python
T = sum(r["total"] for r in rows)                 # all usage-bearing messages
C = sum(r["cost"] for r in rows)                  # provider-reported USD
grand = {k: sum(r[k] for r in rows) for k in ("input","output","cacheRead","cacheWrite")}
gcost = {k: sum(r["cost_"+k] for r in rows) for k in ("input","output","cacheRead","cacheWrite")}
fresh = grand["input"] + grand["output"]
fresh_cost = gcost["input"] + gcost["output"]
cache_hit = grand["cacheRead"] / (grand["cacheRead"] + grand["input"])
```

- `usage.totalTokens` is the token total; it equals input + output + cacheRead +
  cacheWrite.
- Reasoning tokens are a subset of output; never add them again.
- `cache_hit` is the cache-read share used everywhere as a percentage.

### Counts and time

```python
sessions = one per JSONL file with at least one timestamp
turns    = sum(session["turns"])      # assistant messages
users    = sum(session["users"])      # user messages
tools    = sum(session["tools"])      # toolCall content items
active   = sum over consecutive assistant messages of min(gap_seconds, 600)
active_h = sum(session["active"]) / 3600
```

- Active time ignores idle gaps over 10 minutes (600 s).
- Wall-clock span is unreliable: sessions can be resumed across days.

### Local-time groupings

Timestamps are stored in UTC. Convert to `Asia/Kolkata` (constant `TZ` in
`engine.py`) for every day, hour, weekday and month bucket.

- Daily series is a continuous calendar range from the first to the last local
  date, zero-filled for days with no usage.
- Heatmap is weekday (Mon=0 … Sun=6) × hour (0–23).
- Night share: local hour ≥ 20 or < 4.
- Weekend share: weekday ≥ 5.

### Bespoke signals (`extras`, referenced as `X`)

| Key | Definition |
|---|---|
| `aborts` | assistant messages with `stopReason == "aborted"` |
| `turns` | all assistant messages (denominator for rates) |
| `interrupt_rate` | `100 * aborts / turns` |
| `errors` | assistant messages with `stopReason == "error"` |
| `sessions_interrupted` | sessions with at least one abort |
| `max_session_aborts` | most aborts in a single session |
| `autonomy_median` / `autonomy_max` | longest run of consecutive `stopReason == "toolUse"` assistant messages per session; median and max |
| `ctx_median` / `ctx_p90` / `ctx_max` | per assistant call, prompt tokens = `cacheRead + input + cacheWrite` |
| `reason_share` | `100 * sum(reasoning) / sum(output)` |
| `reply_median` | median seconds from an assistant message to the next user message |
| `think_median` | median seconds from a user message to the next assistant message |
| `tool_calls` / `tool_err_rate` | total tool calls; `100 * tool errors / tool calls` |
| `edit_calls` / `edits_add` / `edits_del` | tool results with `details.diff`; diff lines starting `+` / `−`, excluding `+++` / `---` |
| `switch_sessions` / `max_switches` | sessions with a `model_change` to a different `modelId`; most switches |
| `ask` / `self_compact` / `recall` | counts of `ask_question`, `self_compact`, `context_recall` calls |
| `streak` | longest run of consecutive active calendar days |
| `tools` | top 12 tools by calls, each with `err` = error percentage |
| `weeks` | weekly `{w, rate, ctx}` (interruption rate and median context per week) |

### Weekly trends (`render.trends()`)

Weekly buckets use ISO week `strftime("%G-W%V")` in local time; labels are the
last three characters (for example `W27`). Each series is a list aligned to
`labels`.

| Series key | Meaning |
|---|---|
| `abort_rate` | weekly abort percentage |
| `sessions_cut` | sessions with ≥ 1 abort, by session start week |
| `autonomy` | median autonomous run length |
| `reply` | median reply latency |
| `reason_share` | reasoning ÷ output percentage |
| `ctx` | median prompt per call |
| `tool_err` | tool error percentage |
| `prov_err` | provider error percentage |
| `churn` | lines added |
| `active_days` | distinct days with usage (0–7) |
| `switches` | model switches |
| `questions` | `ask_question` calls |
| `tools_calls` | total tool calls |

## Report structure

Keep this order and every section. Never drop information to make the page
shorter.

1. Header: eyebrow `Pi token report`, `h1` `Token usage report`, sub-line with
   `first → last`, `Asia/Kolkata`, generated timestamp.
2. Lede paragraph.
3. Stats: 6 cards — total tokens, reported cost, sessions, cache-read share,
   fresh tokens, active time.
4. What stands out: 5 numbered notes.
5. Where the tokens go: cost doughnut + two prose paragraphs.
6. Over time: 4 charts — cost per day, tokens per day (stacked), fresh tokens per
   day, cumulative tokens and cost.
7. Models: tokens by model and cost by model (horizontal bars, top 10) + a note.
8. Projects: top projects by tokens (horizontal bar, top 10) + a note.
9. When the work happens: weekday × hour heatmap, colour only, with a scale bar.
10. Sessions: sessions by total tokens and by active time (2 histograms) + a note.
11. Usage signals: 12 metric cards, each with a weekly sparkline; then the tools
    chart (calls with error share) plus a weekly tool-call sparkline.
12. Method and data: 6 notes (A–F).
13. Footer.

Chart canvas IDs are fixed: `cat`, `daily`, `dailyTok`, `fresh`, `cum`,
`modelTok`, `modelCost`, `proj`, `tokBins`, `durBins`, `tools`, `sp0`…`sp11`,
`spTools`.

## Design system (exact tokens)

Single-hue blue. Never introduce a second hue, and never use a warm/beige
background.

```css
:root {
  --bg:#ffffff; --soft:#f6f8fb; --line:#e4e9f0; --line2:#cfd8e3;
  --text:#17212f; --muted:#5c6a7a; --accent:#2563eb; --accent2:#1e40af;
}
/* data series, darkest → lightest */
S1 #1e40af   S2 #2563eb   S3 #60a5fa   S4 #bfdbfe
```

- Font: **Hanken Grotesk** (400/500/600/700, plus italic 400) from Google Fonts,
  `14.5px/1.6`, `system-ui` fallback. This is the project's default report font.
  Numbers use `font-variant-numeric: tabular-nums`.
- Layout: `.wrap { max-width:1120px; margin:0 auto; padding:0 24px }`.
- Stats grid: 6 columns, dropping to 3 at ≤1000 px and 2 at ≤760 px.
- Signals grid: 4 columns, dropping to 3 and 2 at the same breakpoints.
- Cards: `border:1px solid var(--line); border-radius:10px; padding:16px 17px`.
- Charts: `height:200px`; `tall` = 250 px; sparklines 46 px (tools spark 52 px).
- Heatmap cell: `hsl(221, S%, L%)` with `t = sqrt(v / max)`,
  `S = 85 - 25t`, `L = 95 - 63t`; empty cells `hsl(221,40%,95%)`.
  Scale bar: `linear-gradient(90deg, hsl(221,85%,95%), hsl(221,60%,32%))`.
- Chart.js defaults: `font.family "Hanken Grotesk"`, size 10.5, color `#5c6a7a`,
  `animation:false`, legend `boxWidth:10`; grid `rgba(23,33,47,.08)`, border
  `rgba(23,33,47,.18)`, ticks `padding:6, maxRotation:0`.
- Print: `@page { size:letter; margin:14mm 13mm }`,
  `print-color-adjust:exact`, `break-inside:avoid` on cards, stats, notes and
  split children; grids collapse to block; buttons hidden.

## Hard rules

- **HTML only.** The single deliverable is `index.html`. Do not generate a PDF or
  a CSV, and do not add download links or buttons.
- **No `<table>` elements anywhere.** Data lives in charts and prose.
- **No beige or warm background.** The page is white; panels may use `--soft`.
- **One hue only.** Blue (hue 221), varied by lightness.
- **Heatmap shows colour only**, with a scale bar; values on hover/tap.
- **Every chart has a plain-language caption.**
- **Every bespoke metric card has a weekly sparkline.**
- **Keep every section** and all 5 + 6 notes.

## Validation checklist

Run all of these after generating:

```bash
OUT=/path/to/output
grep -c '<table'      "$OUT/index.html"   # must be 0
grep -ci 'download'   "$OUT/index.html"   # must be 0
grep -o 'canvas id='  "$OUT/index.html" | wc -l   # expect 24
# extract the inline script and syntax-check it
"$PY" - "$OUT/index.html" <<'EOF'
import re, sys
h = open(sys.argv[1]).read()
open('/tmp/report.js','w').write(re.search(r'<script>\n(const D.*?)</script>', h, re.S).group(1))
EOF
node --check /tmp/report.js               # must pass
```

Then in the browser: no horizontal overflow at 375 px and 1200 px, all 24
canvases present, and the totals in the stats row match the console line printed
by `render.py`.

## Customizing

- **Output directory:** pass it as `argv[1]` or set `USAGE_REPORT_OUT`.
- **Data source:** set `PI_SESSIONS_GLOB`.
- **Hue:** change `221` in the heatmap HSL and the four `S1`–`S4` hex values
  together. Keep exactly one hue.
- **New bespoke metric:** add the period value to `engine.collect()` (returned in
  `extras`), add a weekly series to `render.trends()`, then add a 5-tuple
  `(label, value, sub, series_key, "line"|"bar")` to the `signals` list. The
  sparkline and `data.spark` wiring pick it up automatically.

## Pitfalls

- **Canvas overflow:** grids that hold canvases must use `minmax(0,1fr)` tracks
  and `min-width:0` on the item. A plain `1fr` track lets the canvas's 300 px
  intrinsic width blow out the page.
- **Do not run `engine.py` directly.** It is a library; the renderer is the entry
  point. Running the old engine `main()` would emit a different (brutalist) page.
- **Count subagent usage.** The `subagent` tool result carries its own `usage`;
  include it or totals will not match the provider.
- **Use active time, not span,** for session length.
- **The report includes the session that generates it,** so totals tick up on
  every run. State this when reporting numbers.
- **CDNs:** Chart.js and the font come from CDNs; an offline render falls back to
  system fonts and no charts.
- **Live snapshots:** numbers shift slightly if a session is written during
  generation.
- **No PDF step.** The report is HTML only. If a user asks for a PDF, treat it as
  a separate, explicit request; this skill does not produce one.
