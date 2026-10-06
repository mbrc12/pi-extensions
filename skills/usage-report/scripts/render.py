#!/usr/bin/env python3
"""Renderer for the usage-report skill.

Reads pi session logs through engine.py and writes a single, self-contained,
professional, table-free HTML report. Entry point:

    python render.py [OUTPUT_DIR]

OUTPUT_DIR defaults to the USAGE_REPORT_OUT environment variable, then to this
script's directory. Data source is PI_SESSIONS_GLOB (see engine.py). Only
index.html is produced: no CSV, no PDF, no download links.
"""
from __future__ import annotations

import collections
import glob
import json
import os
import statistics as st
import sys
from datetime import date as _date
from datetime import datetime, timedelta

import engine as base
from engine import CATNAME, CATS, DOWS, TZ, fi, ftok, fhms, fusd, hist

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = (os.environ.get("USAGE_REPORT_OUT")
           or (sys.argv[1] if len(sys.argv) > 1 else HERE))
os.makedirs(OUT_DIR, exist_ok=True)
OUT_HTML = os.path.join(OUT_DIR, "index.html")


def trends():
    """Weekly series for the bespoke metrics, read straight from the session logs."""
    files = sorted(glob.glob(base.SESSIONS_GLOB, recursive=True))
    W: dict = {}

    def b(wk):
        if wk not in W:
            W[wk] = {"turns": 0, "aborts": 0, "errors": 0, "ctx": [], "reason": 0,
                     "out": 0, "reply": [], "think": [], "runs": [], "tcalls": 0,
                     "terr": 0, "add": 0, "rem": 0, "edits": 0, "switches": 0,
                     "ask": 0, "compact": 0, "recall": 0, "dates": set(), "sess_cut": 0}
        return W[wk]

    for path in files:
        with open(path) as fh:
            lines = [json.loads(x) for x in fh if x.strip()]
        prev, run, last_model, sess_aborts, sess_start = None, 0, None, 0, None
        for o in lines:
            ts = o.get("timestamp")
            dt = base.parse(ts) if ts else None
            lt = dt.astimezone(TZ) if dt else None
            wk = lt.strftime("%G-W%V") if lt else None
            typ = o.get("type")
            if typ == "model_change":
                mid = o.get("modelId")
                if last_model is not None and mid != last_model and wk:
                    b(wk)["switches"] += 1
                last_model = mid
                continue
            if typ != "message":
                continue
            m = o["message"]
            role = m.get("role")
            bb = b(wk) if wk else None
            if bb:
                bb["dates"].add(str(lt.date()))
            if role == "user":
                if prev and prev[0] == "assistant" and dt and bb:
                    bb["reply"].append((dt - prev[1]).total_seconds())
                prev = ("user", dt)
            elif role == "assistant":
                if sess_start is None:
                    sess_start = wk
                sr = m.get("stopReason")
                if bb:
                    bb["turns"] += 1
                    if sr == "aborted":
                        bb["aborts"] += 1
                        sess_aborts += 1
                    if sr == "error":
                        bb["errors"] += 1
                    if dt and prev and prev[0] == "user":
                        bb["think"].append((dt - prev[1]).total_seconds())
                if sr == "toolUse":
                    run += 1
                else:
                    if run and bb:
                        bb["runs"].append(run)
                    run = 0
                if bb:
                    for c in m.get("content", []):
                        if c.get("type") == "toolCall":
                            bb["tcalls"] += 1
                            nm = c.get("name")
                            if nm == "ask_question":
                                bb["ask"] += 1
                            elif nm == "self_compact":
                                bb["compact"] += 1
                            elif nm == "context_recall":
                                bb["recall"] += 1
                u = m.get("usage")
                if u and bb:
                    bb["ctx"].append(int(u.get("cacheRead") or 0) + int(u.get("input") or 0)
                                      + int(u.get("cacheWrite") or 0))
                    bb["reason"] += int(u.get("reasoning") or 0)
                    bb["out"] += int(u.get("output") or 0)
                prev = ("assistant", dt)
            elif role == "toolResult":
                if bb and m.get("isError"):
                    bb["terr"] += 1
                d = m.get("details")
                if isinstance(d, dict) and isinstance(d.get("diff"), str) and bb:
                    bb["edits"] += 1
                    for ln in d["diff"].splitlines():
                        if ln.startswith("+") and not ln.startswith("+++"):
                            bb["add"] += 1
                        elif ln.startswith("-") and not ln.startswith("---"):
                            bb["rem"] += 1
        if run and sess_start:
            b(sess_start)["runs"].append(run)
        if sess_aborts and sess_start:
            b(sess_start)["sess_cut"] += 1

    wks = sorted(W)
    med = lambda xs: st.median(xs) if xs else 0
    return {
        "labels": [w[-3:] for w in wks],
        "abort_rate": [100 * W[w]["aborts"] / W[w]["turns"] if W[w]["turns"] else 0 for w in wks],
        "sessions_cut": [W[w]["sess_cut"] for w in wks],
        "autonomy": [med(W[w]["runs"]) for w in wks],
        "reply": [med(W[w]["reply"]) for w in wks],
        "reason_share": [100 * W[w]["reason"] / W[w]["out"] if W[w]["out"] else 0 for w in wks],
        "ctx": [med(W[w]["ctx"]) for w in wks],
        "tool_err": [100 * W[w]["terr"] / W[w]["tcalls"] if W[w]["tcalls"] else 0 for w in wks],
        "prov_err": [100 * W[w]["errors"] / W[w]["turns"] if W[w]["turns"] else 0 for w in wks],
        "churn": [W[w]["add"] for w in wks],
        "active_days": [len(W[w]["dates"]) for w in wks],
        "switches": [W[w]["switches"] for w in wks],
        "questions": [W[w]["ask"] for w in wks],
        "tools_calls": [W[w]["tcalls"] for w in wks],
    }


def main():
    rows, sessions, X = base.collect()
    TR = trends()

    T = sum(r["total"] for r in rows)
    C = sum(r["cost"] for r in rows)
    grand = {k: sum(r[k] for r in rows) for k in CATS}
    gcost = {k: sum(r[f"cost_{k}"] for r in rows) for k in CATS}
    fresh = grand["input"] + grand["output"]
    fresh_cost = gcost["input"] + gcost["output"]
    cread = grand["cacheRead"]
    reasoning = sum(r["reasoning"] for r in rows)
    cache_hit = cread / (cread + grand["input"]) if (cread + grand["input"]) else 0
    turns = sum(s["turns"] for s in sessions)
    users = sum(s["users"] for s in sessions)
    tools = sum(s["tools"] for s in sessions)
    active_h = sum(s["active"] for s in sessions) / 3600

    day_cost: dict[str, float] = {}
    day_tok: dict[str, int] = {}
    day_fresh: dict[str, int] = {}
    hour_tok = [0] * 24
    heat = [[0] * 24 for _ in range(7)]
    month_cost: dict[str, float] = {}
    night = weekend = 0
    for r in rows:
        lt = r["ts"].astimezone(TZ) if r["ts"] else None
        if lt is None:
            continue
        d = str(lt.date())
        day_cost[d] = day_cost.get(d, 0.0) + r["cost"]
        day_tok[d] = day_tok.get(d, 0) + r["total"]
        day_fresh[d] = day_fresh.get(d, 0) + r["input"] + r["output"]
        hour_tok[lt.hour] += r["total"]
        heat[lt.weekday()][lt.hour] += r["total"]
        mk = lt.strftime("%Y-%m")
        month_cost[mk] = month_cost.get(mk, 0.0) + r["cost"]
        if lt.hour >= 20 or lt.hour < 4:
            night += r["total"]
        if lt.weekday() >= 5:
            weekend += r["total"]

    first, last = min(day_cost), max(day_cost)
    d0, d1 = _date.fromisoformat(first), _date.fromisoformat(last)
    days = []
    while d0 <= d1:
        days.append(str(d0))
        d0 += timedelta(days=1)
    day_cost_series = [round(day_cost.get(x, 0.0), 4) for x in days]
    day_tok_series = [day_tok.get(x, 0) for x in days]
    day_fresh_series = [day_fresh.get(x, 0) for x in days]
    active_days = sum(1 for x in days if day_tok.get(x, 0) > 0)
    span_days = len(days)

    cum_t, cum_c, ct, cc = [], [], 0, 0.0
    for x in days:
        ct += day_tok.get(x, 0)
        cc += day_cost.get(x, 0.0)
        cum_t.append(ct)
        cum_c.append(round(cc, 2))

    bym: dict[str, dict] = {}
    for r in rows:
        b = bym.setdefault(r["model"], {"total": 0, "cost": 0.0, "calls": 0})
        b["total"] += r["total"]
        b["cost"] += r["cost"]
        b["calls"] += 1
    by_tok = sorted(bym.items(), key=lambda kv: -kv[1]["total"])
    by_cost = sorted(bym.items(), key=lambda kv: -kv[1]["cost"])
    top_tok_model, top_tok_v = by_tok[0]
    top_cost_model, top_cost_v = by_cost[0]
    free_models = sorted((k for k, v in bym.items() if v["cost"] == 0 and v["total"] > 0),
                         key=lambda k: -bym[k]["total"])

    byp: dict[str, dict] = {}
    for s in sessions:
        b = byp.setdefault(s["cwd"], {"total": 0, "cost": 0.0, "sessions": 0, "turns": 0})
        b["total"] += s["total"]
        b["cost"] += s["cost"]
        b["sessions"] += 1
        b["turns"] += s["turns"]
    by_proj = sorted(byp.items(), key=lambda kv: -kv[1]["total"])

    busiest = max(day_tok.items(), key=lambda kv: kv[1])
    priciest = max(day_cost.items(), key=lambda kv: kv[1])
    peak_hour = max(range(24), key=lambda h: hour_tok[h])
    big = max(sessions, key=lambda s: s["total"])
    busiest_dow = max(range(7), key=lambda i: sum(heat[i]))

    toks = [s["total"] for s in sessions]
    med_turns = st.median([s["turns"] for s in sessions])
    med_tok = st.median(toks)
    med_active = st.median([s["active"] for s in sessions])
    tok_bins = hist(toks, [0, 1e6, 5e6, 20e6, 50e6, 100e6, 250e6, 5e8, 1e18],
                    ["under 1M", "1–5M", "5–20M", "20–50M", "50–100M", "100–250M",
                     "250–500M", "500M+"])
    dur_bins = hist([min(s["active"], 21600) for s in sessions],
                    [0, 300, 900, 1800, 3600, 7200, 21600],
                    ["under 5m", "5–15m", "15–30m", "30–60m", "1–2h", "2h+"])

    # heatmap: single-hue blue ramp, no numbers in cells
    hmax = max((v for r in heat for v in r), default=1) or 1
    cells = ['<div class="lab"></div>']
    for h in range(24):
        cells.append(f'<div class="hh">{h:02d}</div>' if h % 3 == 0 else '<div class="hh"></div>')
    for di, name in enumerate(DOWS):
        cells.append(f'<div class="lab">{name}</div>')
        for h in range(24):
            v = heat[di][h]
            t = (v / hmax) ** 0.5 if v else 0
            col = f"hsl(221,{85 - 25 * t:.0f}%,{95 - 63 * t:.0f}%)" if v else "hsl(221,40%,95%)"
            cells.append(f'<div class="hc" style="background:{col}"'
                         f' title="{name} {h:02d}:00 — {fi(v)} tokens"></div>')
    heatmap = ('<div class="heat" role="img" aria-label="Heatmap of tokens by weekday and hour of '
               'day, local time. Darkest cells are late evening and early morning.">'
               + "".join(cells) + "</div>")

    data = {
        "days": days, "dayCost": day_cost_series, "dayTok": day_tok_series,
        "dayFresh": day_fresh_series,
        "cat": [{"name": CATNAME[k], "tokens": grand[k], "cost": round(gcost[k], 2)} for k in CATS],
        "cumT": cum_t, "cumC": cum_c,
        "modelTok": [{"name": k, "tokens": v["total"], "cost": v["cost"]} for k, v in by_tok[:10]],
        "modelCost": [{"name": k, "tokens": v["total"], "cost": v["cost"]} for k, v in by_cost[:10]],
        "proj": [{"name": k, "tokens": v["total"], "cost": v["cost"]} for k, v in by_proj[:10]],
        "tokBins": tok_bins, "durBins": dur_bins,
        "weeks": X["weeks"], "tools": X["tools"], "trends": TR,
    }
    jd = lambda o: json.dumps(o, separators=(",", ":"))

    stats = [
        ("Total tokens", ftok(T), f"{fi(T)}"),
        ("Reported cost", fusd(C), f"{active_days} active days"),
        ("Sessions", fi(len(sessions)), f"{fi(turns)} turns"),
        ("Cache-read share", f"{cache_hit*100:.1f}%", f"{ftok(cread)} from cache"),
        ("Fresh tokens", ftok(fresh), f"{fusd(fresh_cost)} of cost"),
        ("Active time", f"{active_h:,.0f} h", f"median {fhms(med_active)}"),
    ]
    notes = [
        f"Used on {active_days} of {span_days} calendar days, across {fi(len(sessions))} sessions "
        f"and {fi(turns)} assistant turns, with {fi(users)} user messages and {fi(tools)} tool calls.",
        f"Cache reads are <b>{cache_hit*100:.1f}%</b> of all tokens but only "
        f"<b>{gcost['cacheRead']/C*100:.0f}%</b> of the cost; cached input is billed far lower. "
        f"Fresh input and output are {ftok(fresh)} tokens and {fusd(fresh_cost)}.",
        f"September carried the spend at <b>{fusd(month_cost.get('2026-09', 0))}</b>, against "
        f"{fusd(month_cost.get('2026-08', 0))} in August and {fusd(month_cost.get('2026-07', 0))} "
        f"in July.",
        f"<b>{top_tok_model}</b> moved the most tokens ({ftok(top_tok_v['total'])}, "
        f"{top_tok_v['total']/T*100:.0f}%) for {fusd(top_tok_v['cost'])}. <b>{top_cost_model}</b> "
        f"cost the most, {fusd(top_cost_v['cost'])}, or {top_cost_v['cost']/C*100:.0f}% of the bill, "
        f"on {top_cost_v['total']/T*100:.0f}% of the tokens.",
        f"<b>{night/T*100:.0f}%</b> of tokens fall between 20:00 and 04:00, the busiest hour is "
        f"<b>{peak_hour:02d}:00</b>, and weekends account for {weekend/T*100:.0f}%.",
    ]
    signals = [
        ("Interrupted turns", f"{X['interrupt_rate']:.1f}%", f"{fi(X['aborts'])} of {fi(X['turns'])} aborted", "abort_rate", "line"),
        ("Sessions you cut in", fi(X["sessions_interrupted"]), f"of {fi(len(sessions))}; worst {X['max_session_aborts']}", "sessions_cut", "bar"),
        ("Longest solo run", fi(X["autonomy_max"]), f"tool calls; median {X['autonomy_median']:.0f}", "autonomy", "line"),
        ("Your reply time", f"{X['reply_median']:.0f} s", f"median; model-first {X['think_median']:.1f} s", "reply", "line"),
        ("Reasoning share", f"{X['reason_share']:.0f}%", "of output tokens", "reason_share", "line"),
        ("Context ceiling", ftok(X["ctx_max"]), f"one call; median {ftok(X['ctx_median'])}", "ctx", "line"),
        ("Tool errors", f"{X['tool_err_rate']:.1f}%", f"{fi(X['tool_calls'])} calls total", "tool_err", "line"),
        ("Provider errors", fi(X["errors"]), "turns ended in error", "prov_err", "line"),
        ("Code churn", f"+{ftok(X['edits_add'])}", f"\u2212{ftok(X['edits_del'])} lines, {fi(X['edit_calls'])} edits", "churn", "bar"),
        ("Longest streak", f"{X['streak']} d", "consecutive days used", "active_days", "bar"),
        ("Model switches", fi(X["switch_sessions"]), f"sessions; max {X['max_switches']}", "switches", "bar"),
        ("Questions to you", fi(X["ask"]), f"{fi(X['self_compact'])} compactions, {fi(X['recall'])} recalls", "questions", "bar"),
    ]

    gen = datetime.now(TZ).strftime("%Y-%m-%d %H:%M %Z")
    data["spark"] = [{"id": f"sp{i}", "key": s[3], "type": s[4]}
                     for i, s in enumerate(signals)]

    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi token usage report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
:root {{
  --bg:#ffffff; --soft:#f6f8fb; --line:#e4e9f0; --line2:#cfd8e3;
  --text:#17212f; --muted:#5c6a7a; --accent:#2563eb; --accent2:#1e40af;
}}
* {{ box-sizing:border-box; }}
html {{ background:var(--bg); }}
body {{ margin:0; background:var(--bg); color:var(--text);
  font:400 14.5px/1.6 "Hanken Grotesk",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased; }}
.wrap {{ max-width:1120px; margin:0 auto; padding:0 24px; }}
a {{ color:var(--accent); }}
b, strong {{ font-weight:600; }}
code {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em;
  background:var(--soft); border:1px solid var(--line); border-radius:4px; padding:0 4px; }}

.head {{ border-bottom:1px solid var(--line); background:#fff; }}
.head .wrap {{ padding-top:34px; padding-bottom:26px; }}
.eyebrow {{ margin:0 0 8px; font-size:12px; font-weight:600; letter-spacing:.08em;
  text-transform:uppercase; color:var(--accent); }}
h1 {{ margin:0; font-size:clamp(1.7rem,3.6vw,2.3rem); font-weight:700; letter-spacing:-.01em; }}
.sub {{ margin:10px 0 0; color:var(--muted); font-size:13.5px; }}
.lede {{ margin:28px 0 0; font-size:16px; color:#33404f; max-width:74ch; }}

.stats {{ display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin:26px 0 0; }}
.stat {{ background:var(--soft); border:1px solid var(--line); border-radius:10px; padding:14px 15px; }}
.stat .k {{ font-size:12px; color:var(--muted); margin-bottom:6px; }}
.stat .v {{ font-size:1.35rem; font-weight:700; letter-spacing:-.01em; font-variant-numeric:tabular-nums; }}
.stat .s {{ font-size:12px; color:var(--muted); margin-top:4px; }}
.signals {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }}
.sig {{ background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 15px 10px;
  min-width:0; }}
.sig .k {{ font-size:12px; color:var(--muted); }}
.sig .v {{ font-size:1.3rem; font-weight:700; letter-spacing:-.01em; font-variant-numeric:tabular-nums;
  margin-top:2px; }}
.sig .s {{ font-size:11.5px; color:var(--muted); min-height:30px; }}
.spark {{ position:relative; height:46px; margin-top:8px; min-width:0; }}

section {{ margin-top:44px; }}
h2 {{ font-size:1.15rem; font-weight:600; margin:0 0 4px; }}
.h2row {{ display:flex; align-items:baseline; justify-content:space-between; gap:16px;
  border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:18px; }}
.meta {{ font-size:12.5px; color:var(--muted); }}

.notes {{ list-style:none; margin:0; padding:0; display:grid; grid-template-columns:1fr 1fr; gap:14px 28px; }}
.notes li {{ display:flex; gap:12px; }}
.notes .n {{ flex:0 0 auto; width:22px; height:22px; border-radius:50%; background:var(--soft);
  border:1px solid var(--line); color:var(--accent); font-size:12px; font-weight:600;
  display:flex; align-items:center; justify-content:center; }}
.notes p {{ margin:0; }}

.card {{ background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px 17px 15px; }}
.card h3 {{ margin:0 0 12px; font-size:12.5px; font-weight:600; color:#33404f; }}
.grid2 {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }}
.split {{ display:grid; grid-template-columns:minmax(260px,360px) 1fr; gap:26px; align-items:start; }}
.prose p {{ margin:0 0 12px; }}
.prose p:last-child {{ margin-bottom:0; }}
.big {{ font-size:1.5rem; font-weight:700; color:var(--accent2); font-variant-numeric:tabular-nums; }}
.chart {{ position:relative; width:100%; min-width:0; height:200px; }}
.chart.tall {{ height:250px; }}
.cap {{ font-size:12.5px; color:var(--muted); margin-top:10px; }}

.heat {{ display:grid; grid-template-columns:auto repeat(24,1fr); gap:2px; align-items:center; }}
.heat .lab {{ font-size:10.5px; color:var(--muted); text-align:right; padding-right:8px; white-space:nowrap; }}
.heat .hh {{ font-size:10px; color:var(--muted); text-align:center; }}
.heat .hc {{ aspect-ratio:1; border-radius:2px; background:hsl(221,40%,95%); }}
.scale {{ display:flex; align-items:center; gap:10px; margin-top:12px; font-size:11.5px; color:var(--muted); }}
.scale .bar {{ width:180px; height:8px; border-radius:4px; background:linear-gradient(90deg,
  hsl(221,85%,95%), hsl(221,60%,32%)); }}

.actions {{ display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }}
.btn {{ display:inline-block; font-size:13px; font-weight:600; text-decoration:none;
  color:#fff; background:var(--accent); border:1px solid var(--accent); border-radius:8px; padding:9px 15px; }}
.btn.alt {{ background:#fff; color:var(--accent); }}
.btn:hover {{ background:var(--accent2); border-color:var(--accent2); color:#fff; }}
.btn.alt:hover {{ background:var(--soft); color:var(--accent2); border-color:var(--line2); }}

footer {{ border-top:1px solid var(--line); margin-top:56px; padding:20px 0 56px;
  color:var(--muted); font-size:12.5px; }}
:focus-visible {{ outline:2px solid var(--accent); outline-offset:2px; }}
.print-only {{ display:none; }}

@media (max-width:1000px) {{
  .stats {{ grid-template-columns:repeat(3,minmax(0,1fr)); }}
  .signals {{ grid-template-columns:repeat(3,minmax(0,1fr)); }}
}}
@media (max-width:760px) {{
  .stats {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
  .signals {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
  .grid2, .split {{ grid-template-columns:1fr; }}
  .notes {{ grid-template-columns:1fr; }}
}}
@media print {{
  @page {{ size:letter; margin:14mm 13mm; }}
  body {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; font-size:10.5pt; }}
  section {{ margin-top:22px; }}
  h2 {{ break-after:avoid; }}
  .card, .stat, .notes li, .split > *, figure {{ break-inside:avoid; }}
  .grid2, .split {{ display:block; }}
  .grid2 > *, .split > * {{ margin-bottom:12px; }}
  .chart {{ height:200px; }} .chart.tall {{ height:235px; }}
  .btn {{ display:none; }} .print-only {{ display:inline; }}
}}
</style>
</head>
<body>
<header class="head">
  <div class="wrap">
    <p class="eyebrow">Pi token report</p>
    <h1>Token usage report</h1>
    <p class="sub">{first} → {last} · Asia/Kolkata · generated {gen}</p>
  </div>
</header>

<main class="wrap">
  <p class="lede">How one machine used pi over {span_days} days: total volume, where the money
  went, which models did the work, where it happened and when. There are no tables; every figure
  sits in a chart, with a plain-language summary beside it.</p>

  <div class="stats">
{''.join(f'<div class="stat"><div class="k">{a}</div><div class="v">{b}</div><div class="s">{c}</div></div>' for a, b, c in stats)}
  </div>

  <section>
    <div class="h2row"><h2>What stands out</h2><span class="meta">five notes</span></div>
    <ol class="notes">
{''.join(f'<li><span class="n">{i+1}</span><p>{x}</p></li>' for i, x in enumerate(notes))}
    </ol>
  </section>

  <section>
    <div class="h2row"><h2>Where the tokens go</h2><span class="meta">{fi(T)} tokens · {fusd(C)}</span></div>
    <div class="split">
      <div class="card"><h3>Share of cost</h3>
        <div class="chart"><canvas id="cat" role="img"
          aria-label="Doughnut chart of cost by token category."></canvas></div>
      </div>
      <div class="prose">
        <p><span class="big">{cache_hit*100:.1f}%</span> of the {ftok(T)} tokens is cache read, but it
        carries only {gcost['cacheRead']/C*100:.0f}% of the {fusd(C)} bill. Fresh input and output
        together are {ftok(fresh)} tokens — {fresh/T*100:.1f}% of the volume — for
        {fusd(fresh_cost)}, or {fresh_cost/C*100:.0f}% of the spend.</p>
        <p>Reasoning tokens add {ftok(reasoning)} on top of the output figure. They are already
        counted inside output, so they are not added again. Flat-rate models such as
        {', '.join(free_models[:3]) or 'none'} report zero cost.</p>
      </div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Over time</h2><span class="meta">daily and cumulative</span></div>
    <div class="grid2">
      <div class="card"><h3>Cost per day (USD)</h3>
        <div class="chart"><canvas id="daily" role="img"
          aria-label="Area chart of daily cost in US dollars."></canvas></div>
        <div class="cap">September was heaviest at {fusd(month_cost.get('2026-09', 0))}. The costliest
        day was {priciest[0]} at {fusd(priciest[1])}.</div>
      </div>
      <div class="card"><h3>Tokens per day</h3>
        <div class="chart"><canvas id="dailyTok" role="img"
          aria-label="Stacked bar chart of daily tokens by cache read versus fresh tokens."></canvas></div>
        <div class="cap">Busiest day by volume: {busiest[0]} with {ftok(busiest[1])} tokens. Cache
        reads dominate most days.</div>
      </div>
      <div class="card"><h3>Fresh tokens per day (input + output)</h3>
        <div class="chart"><canvas id="fresh" role="img"
          aria-label="Line chart of fresh tokens per day."></canvas></div>
        <div class="cap">The genuinely new text: {ftok(fresh)} tokens over the period, about
        {ftok(fresh/span_days)} on an average day.</div>
      </div>
      <div class="card"><h3>Cumulative tokens and cost</h3>
        <div class="chart"><canvas id="cum" role="img"
          aria-label="Line chart of cumulative tokens and cumulative cost."></canvas></div>
        <div class="cap">Both curves steepen from mid-August, when heavier models saw more use.</div>
      </div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Models</h2><span class="meta">{len(bym)} seen · top 10 shown</span></div>
    <div class="grid2">
      <div class="card"><h3>Tokens by model</h3>
        <div class="chart tall"><canvas id="modelTok" role="img"
          aria-label="Bar chart of total tokens by model."></canvas></div>
      </div>
      <div class="card"><h3>Cost by model</h3>
        <div class="chart tall"><canvas id="modelCost" role="img"
          aria-label="Bar chart of total cost by model."></canvas></div>
      </div>
    </div>
    <p class="cap"><b>{top_tok_model}</b> handled the most tokens — {ftok(top_tok_v['total'])},
    {top_tok_v['total']/T*100:.0f}% of the total — for {fusd(top_tok_v['cost'])}.
    <b>{top_cost_model}</b> cost the most at {fusd(top_cost_v['cost'])}
    ({top_cost_v['cost']/C*100:.0f}% of the bill) on {top_cost_v['total']/T*100:.0f}% of the tokens.
    Token volume and cost rarely rank the same way.</p>
  </section>

  <section>
    <div class="h2row"><h2>Projects</h2><span class="meta">{len(by_proj)} directories · top 10 shown</span></div>
    <div class="card"><h3>Top projects by tokens</h3>
      <div class="chart tall"><canvas id="proj" role="img"
        aria-label="Bar chart of tokens by project directory."></canvas></div>
      <div class="cap"><code>{by_proj[0][0]}</code> leads with {ftok(by_proj[0][1]['total'])} tokens
      across {by_proj[0][1]['sessions']} sessions ({fusd(by_proj[0][1]['cost'])}), ahead of
      <code>{by_proj[1][0]}</code> and <code>{by_proj[2][0]}</code>.</div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>When the work happens</h2><span class="meta">weekday × hour, local time</span></div>
    <div class="card">
      {heatmap}
      <div class="scale"><span>fewer tokens</span><span class="bar"></span><span>more</span></div>
      <div class="cap">Darker is more. Peak hour {peak_hour:02d}:00; heaviest weekday
      {DOWS[busiest_dow]}; {night/T*100:.0f}% of tokens fall between 20:00 and 04:00; weekends
      carry {weekend/T*100:.0f}%. Hover or tap a cell for its exact value.</div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Sessions</h2><span class="meta">{fi(len(sessions))} files · median {ftok(med_tok)}</span></div>
    <div class="grid2">
      <div class="card"><h3>Sessions by total tokens</h3>
        <div class="chart"><canvas id="tokBins" role="img"
          aria-label="Bar chart of sessions grouped by total token size."></canvas></div>
      </div>
      <div class="card"><h3>Sessions by active time</h3>
        <div class="chart"><canvas id="durBins" role="img"
          aria-label="Bar chart of sessions grouped by active time."></canvas></div>
      </div>
    </div>
    <p class="cap">A session is one conversation file and can be resumed across days, so active time
    — message gaps under ten minutes — is a fairer length than wall-clock span. The median session
    is <b>{med_turns:.0f} turns</b>, <b>{fi(med_tok)} tokens</b> and <b>{fhms(med_active)}</b> of
    active work. The largest single session used {ftok(big['total'])} tokens in
    <code>{big['cwd']}</code> and cost {fusd(big['cost'])}.</p>
  </section>

  <section>
    <div class="h2row"><h2>Usage signals</h2><span class="meta">weekly trends · derived from the session logs</span></div>
    <div class="signals">
{''.join(f'<div class="sig"><div class="k">{a}</div><div class="v">{b}</div><div class="s">{c}</div><div class="spark"><canvas id="sp{i}" role="img" aria-label="{a} weekly trend."></canvas></div></div>' for i, (a, b, c, key, typ) in enumerate(signals))}
    </div>
    <p class="cap">Each sparkline is the weekly trend from W27 to W41. The figure in each card is
    the period total or extreme; the sparkline shows that measure week by week as a rate, median or
    count.</p>
    <div class="card" style="margin-top:16px"><h3>Tools used, with error share</h3>
      <div class="chart tall"><canvas id="tools" role="img"
        aria-label="Bar chart of calls per tool."></canvas></div>
      <div class="spark" style="height:52px; margin-top:12px"><canvas id="spTools" role="img"
        aria-label="Weekly tool call volume."></canvas></div>
      <div class="cap">bash leads at {fi(X['tools'][0]['calls'])} calls; edit and read follow. The
      riskiest is ask_question, wrong about a third of the time. Across {fi(X['edit_calls'])} edits
      the agent added {fi(X['edits_add'])} lines and removed {fi(X['edits_del'])}. The sparkline
      tracks total tool calls per week.</div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Method and data</h2><span class="meta">sources and definitions</span></div>
    <div class="notes">
      <li><span class="n">A</span><p>Source: every <code>~/.pi/agent/sessions/**/*.jsonl</code> file,
      {fi(len(sessions))} in total.</p></li>
      <li><span class="n">B</span><p>Token counts come from each assistant message's
      <code>usage</code>: input, output, cache read, cache write. Subagent runs are counted under a
      <code>subagent</code> label so totals stay complete.</p></li>
      <li><span class="n">C</span><p>Timestamps are stored in UTC and converted to Asia/Kolkata for
      all day, hour and weekday groupings.</p></li>
      <li><span class="n">D</span><p>Active time sums gaps between assistant messages and ignores
      any gap over ten minutes.</p></li>
      <li><span class="n">E</span><p>Cost is the provider's own estimate, not recomputed from a price
      list; flat-rate models can legitimately show zero.</p></li>
      <li><span class="n">F</span><p>Totals are a live snapshot and include the session that wrote
      this page, so they rise slightly on each run.</p></li>
    </div>
  </section>

  <footer>
    Pi token report · {first} → {last} · Asia/Kolkata · generated {gen}. Totals include the session
    that wrote this page.
  </footer>
</main>

<script>
const D = {jd(data)};
const S1='#1e40af', S2='#2563eb', S3='#60a5fa', S4='#bfdbfe';
const fmtInt = n => Math.round(n).toLocaleString('en-US');
const fmtTok = n => {{ n=+n; if(n>=1e9) return (n/1e9).toFixed(2)+'B';
  if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'K'; return ''+n; }};
const usd = n => '$'+n.toLocaleString('en-US',{{maximumFractionDigits:2}});
const el = id => document.getElementById(id);
Chart.defaults.font.family = "'Hanken Grotesk',system-ui,sans-serif";
Chart.defaults.font.size = 10.5;
Chart.defaults.color = '#5c6a7a';
Chart.defaults.animation = false;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.font = {{size:10.5}};
const G = {{ grid:{{color:'rgba(23,33,47,.08)', drawTicks:false}}, border:{{color:'rgba(23,33,47,.18)'}},
  ticks:{{padding:6, maxRotation:0}} }};
const S = (x, y) => ({{ x: Object.assign({{}}, G, x||{{}}), y: Object.assign({{}}, G, y||{{}}) }});

new Chart(el('cat'), {{
  type:'doughnut',
  data:{{ labels:D.cat.map(c=>c.name), datasets:[{{ data:D.cat.map(c=>c.cost),
    backgroundColor:[S1, S3, S2, S4], borderColor:'#fff', borderWidth:2, hoverOffset:0 }}] }},
  options:{{ responsive:true, maintainAspectRatio:false, cutout:'58%',
    plugins:{{ legend:{{position:'right', labels:{{padding:10, boxHeight:9}}}}, tooltip:{{callbacks:{{
      label:x=>x.label+' · '+usd(x.raw)+' · '+fmtTok(D.cat[x.dataIndex].tokens)+' tok'}}}} }} }}
}});

new Chart(el('daily'), {{
  type:'line',
  data:{{ labels:D.days, datasets:[{{ data:D.dayCost, borderColor:S2, borderWidth:1.6,
    backgroundColor:'rgba(37,99,235,.12)', fill:true, tension:.22, pointRadius:0 }}] }},
  options:{{ responsive:true, maintainAspectRatio:false, interaction:{{mode:'index',intersect:false}},
    scales:S({{ticks:{{maxTicksLimit:6}}}}, {{beginAtZero:true, ticks:{{callback:v=>'$'+v}}}}),
    plugins:{{ legend:{{display:false}}, tooltip:{{callbacks:{{label:x=>usd(x.raw)+' · '+fmtInt(D.dayTok[x.dataIndex])+' tok'}}}} }} }}
}});

new Chart(el('dailyTok'), {{
  type:'bar',
  data:{{ labels:D.days, datasets:[
    {{ label:'Cache read', data:D.dayTok.map((v,i)=>v-D.dayFresh[i]), backgroundColor:S4, stack:'t' }},
    {{ label:'Fresh input + output', data:D.dayFresh, backgroundColor:S2, stack:'t' }} ] }},
  options:{{ responsive:true, maintainAspectRatio:false,
    scales:S({{stacked:true, ticks:{{maxTicksLimit:6}}}}, {{stacked:true, beginAtZero:true, ticks:{{callback:v=>fmtTok(v)}}}}),
    plugins:{{ legend:{{position:'bottom', labels:{{boxHeight:8}}}},
      tooltip:{{callbacks:{{label:x=>x.dataset.label+' · '+fmtInt(x.raw)}}}} }} }}
}});

new Chart(el('fresh'), {{
  type:'line',
  data:{{ labels:D.days, datasets:[{{ data:D.dayFresh, borderColor:S1, borderWidth:1.6,
    backgroundColor:'rgba(30,64,175,.08)', fill:true, tension:.22, pointRadius:0 }}] }},
  options:{{ responsive:true, maintainAspectRatio:false, interaction:{{mode:'index',intersect:false}},
    scales:S({{ticks:{{maxTicksLimit:6}}}}, {{beginAtZero:true, ticks:{{callback:v=>fmtTok(v)}}}}),
    plugins:{{ legend:{{display:false}}, tooltip:{{callbacks:{{label:x=>fmtInt(x.raw)+' fresh tokens'}}}} }} }}
}});

new Chart(el('cum'), {{
  type:'line',
  data:{{ labels:D.days, datasets:[
    {{ label:'Tokens', data:D.cumT, borderColor:S3, borderWidth:1.6, fill:true,
      backgroundColor:'rgba(96,165,250,.18)', tension:.2, pointRadius:0, yAxisID:'y' }},
    {{ label:'Cost (USD)', data:D.cumC, borderColor:S2, borderWidth:1.6, tension:.2,
      pointRadius:0, yAxisID:'y1' }} ] }},
  options:{{ responsive:true, maintainAspectRatio:false, interaction:{{mode:'index',intersect:false}},
    scales:{{ x:Object.assign({{}}, G, {{ticks:{{maxTicksLimit:6}}}}),
      y:Object.assign({{}}, G, {{position:'left', beginAtZero:true, ticks:{{callback:v=>fmtTok(v)}}}}),
      y1:Object.assign({{}}, G, {{position:'right', beginAtZero:true, grid:{{drawOnChartArea:false}},
        ticks:{{callback:v=>'$'+v}}}}) }},
    plugins:{{ legend:{{position:'bottom', labels:{{boxHeight:8}}}},
      tooltip:{{callbacks:{{label:x=>x.dataset.label+' · '+(x.dataset.yAxisID==='y1'?usd(x.raw):fmtInt(x.raw))}}}} }} }}
}});

function hbar(id, arr, key, color) {{
  new Chart(el(id), {{
    type:'bar',
    data:{{ labels:arr.map(m=>m.name), datasets:[{{ data:arr.map(m=>m[key]), backgroundColor:color }}] }},
    options:{{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      scales:{{ x:Object.assign({{}}, G, {{beginAtZero:true, ticks:{{callback:v=>key==='cost'?'$'+v:fmtTok(v)}}}}),
        y:Object.assign({{}}, G, {{ticks:{{autoSkip:false, font:{{size:10}}}}}}) }},
      plugins:{{ legend:{{display:false}}, tooltip:{{callbacks:{{label:x=>key==='cost'
        ?usd(x.raw)+' · '+fmtTok(arr[x.dataIndex].tokens)+' tok'
        :fmtInt(x.raw)+' tokens · '+usd(arr[x.dataIndex].cost)}}}} }} }}
  }});
}}
hbar('modelTok', D.modelTok, 'tokens', S1);
hbar('modelCost', D.modelCost, 'cost', S2);
hbar('proj', D.proj, 'tokens', S1);

function vbar(id, bins, color) {{
  new Chart(el(id), {{
    type:'bar',
    data:{{ labels:bins.map(b=>b.label), datasets:[{{ data:bins.map(b=>b.count), backgroundColor:color }}] }},
    options:{{ responsive:true, maintainAspectRatio:false,
      scales:S({{ticks:{{maxRotation:40, minRotation:40, autoSkip:false, font:{{size:9.5}}}}}}, {{beginAtZero:true}}),
      plugins:{{ legend:{{display:false}}, tooltip:{{callbacks:{{label:x=>fmtInt(x.raw)+' sessions'}}}} }} }}
  }});
}}
vbar('tokBins', D.tokBins, S1);
vbar('durBins', D.durBins, S2);

const spark = (id, arr, type, color) => {{
  new Chart(el(id), {{
    type: type,
    data:{{ labels:D.trends.labels, datasets:[{{ data:arr, borderColor:color,
      backgroundColor:type==='bar'?color:'rgba(37,99,235,.14)', fill:type!=='bar', tension:.3,
      pointRadius:0, borderWidth:1.4, barPercentage:.92, categoryPercentage:.92 }}] }},
    options:{{ responsive:true, maintainAspectRatio:false, animation:false,
      scales:{{ x:{{display:false}}, y:{{display:false, beginAtZero:true}} }},
      plugins:{{ legend:{{display:false}}, tooltip:{{enabled:false}} }}, elements:{{point:{{radius:0}}}} }}
  }});
}};
D.spark.forEach((s,i)=>spark(s.id, D.trends[s.key], s.type, i%2 ? S2 : S1));

new Chart(el('tools'), {{
  type:'bar',
  data:{{ labels:D.tools.map(t=>t.name), datasets:[{{ data:D.tools.map(t=>t.calls), backgroundColor:S1 }}] }},
  options:{{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
    scales:{{ x:Object.assign({{}}, G, {{beginAtZero:true, ticks:{{callback:v=>fmtInt(v)}}}}),
      y:Object.assign({{}}, G, {{ticks:{{autoSkip:false, font:{{size:10}}}}}}) }},
    plugins:{{ legend:{{display:false}}, tooltip:{{callbacks:{{label:x=>fmtInt(x.raw)+' calls · '+D.tools[x.dataIndex].err+'% errors'}}}} }} }}
}});
spark('spTools', D.trends.tools_calls, 'bar', S2);
</script>
</body>
</html>
"""
    with open(OUT_HTML, "w") as fh:
        fh.write(doc)
    print(f"wrote {OUT_HTML}")
    print(f"tokens {fi(T)}  cost {fusd(C)}  sessions {len(sessions)}  active days {active_days}")


if __name__ == "__main__":
    main()
