#!/usr/bin/env python3
"""Data engine for the usage-report skill.

Reads pi session JSONL files and returns (rows, sessions, extras). This module is a
pure library: it never writes files and it renders nothing. The renderer lives in
render.py. Keep the metric definitions here stable, because the report's numbers
depend on them.
"""
from __future__ import annotations

import collections
import glob
import json
import os
import statistics as st
from datetime import date as _date
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
SESSIONS_GLOB = os.environ.get(
    "PI_SESSIONS_GLOB", os.path.join(HOME, ".pi/agent/sessions/**/*.jsonl"))
TZ = ZoneInfo("Asia/Kolkata")
CATS = ["input", "output", "cacheRead", "cacheWrite"]
CATNAME = {"cacheRead": "Cache read", "input": "Input (fresh)",
           "output": "Output", "cacheWrite": "Cache write"}
DOWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts[:-1] + "+00:00")


def collect():
    rows, sessions = [], []
    tool_tot: collections.Counter = collections.Counter()
    tool_err: collections.Counter = collections.Counter()
    think_levels: collections.Counter = collections.Counter()
    week_abort: dict = collections.defaultdict(lambda: [0, 0])
    week_ctx: dict = collections.defaultdict(list)
    active_dates: set = set()
    reply_lat, think_lat = [], []
    turns_total = aborts = prov_errors = 0
    ctx_max = out_max = out_all = reason_all = 0
    ctx_all: list = []
    edits_add = edits_del = edit_calls = 0
    for path in sorted(glob.glob(SESSIONS_GLOB, recursive=True)):
        with open(path) as fh:
            lines = [json.loads(x) for x in fh if x.strip()]
        if not lines:
            continue
        hdr = lines[0] if lines[0].get("type") == "session" else {}
        cwd = hdr.get("cwd") or "unknown"
        stamps, turns, users, tools, active = [], 0, 0, 0, 0.0
        stot, scost = 0, 0.0
        models: dict[str, int] = {}
        prev = None          # (role, dt) for latencies
        prev_asst = None     # previous assistant timestamp, for active time
        run = best_run = 0
        switches = 0
        last_model = None
        sess_aborts = 0
        for o in lines:
            ts = o.get("timestamp")
            dt = parse(ts) if ts else None
            if dt:
                stamps.append(dt)
                active_dates.add(str(dt.date()))
            typ = o.get("type")
            if typ == "model_change":
                mid = o.get("modelId")
                if last_model is not None and mid != last_model:
                    switches += 1
                last_model = mid
            elif typ == "thinking_level_change":
                think_levels[o.get("thinkingLevel")] += 1
            if typ != "message":
                continue
            m = o["message"]
            role = m.get("role")
            if role == "user":
                users += 1
                if prev and prev[0] == "assistant" and dt:
                    reply_lat.append((dt - prev[1]).total_seconds())
                prev = ("user", dt)
            elif role == "assistant":
                turns += 1
                turns_total += 1
                mk = m.get("model") or "unknown"
                models[mk] = models.get(mk, 0) + 1
                sr = m.get("stopReason")
                if sr == "aborted":
                    aborts += 1
                    sess_aborts += 1
                elif sr == "error":
                    prov_errors += 1
                if dt:
                    wk = dt.strftime("%G-W%V")
                    week_abort[wk][1] += 1
                    if sr == "aborted":
                        week_abort[wk][0] += 1
                if dt and prev and prev[0] == "user":
                    think_lat.append((dt - prev[1]).total_seconds())
                if sr == "toolUse":
                    run += 1
                    best_run = max(best_run, run)
                else:
                    run = 0
                for c in m.get("content", []):
                    if c.get("type") == "toolCall":
                        tools += 1
                        tool_tot[c.get("name")] += 1
                if dt and prev_asst:
                    active += min((dt - prev_asst).total_seconds(), 600)
                if dt:
                    prev_asst = dt
                prev = ("assistant", dt)
            elif role == "toolResult":
                nm = m.get("toolName")
                if m.get("isError"):
                    tool_err[nm] += 1
                d = m.get("details")
                if isinstance(d, dict) and isinstance(d.get("diff"), str):
                    edit_calls += 1
                    for ln in d["diff"].splitlines():
                        if ln.startswith("+") and not ln.startswith("+++"):
                            edits_add += 1
                        elif ln.startswith("-") and not ln.startswith("---"):
                            edits_del += 1
            u = m.get("usage")
            if not u:
                continue
            co = u.get("cost") or {}
            cost = float(co.get("total") or 0.0)
            inp = int(u.get("input") or 0)
            out = int(u.get("output") or 0)
            cr = int(u.get("cacheRead") or 0)
            cw = int(u.get("cacheWrite") or 0)
            rsn = int(u.get("reasoning") or 0)
            total = int(u.get("totalTokens") or 0)
            rows.append({
                "model": m.get("model") or "subagent",
                "kind": "assistant" if role == "assistant" else "subagent",
                "ts": dt,
                "input": inp, "output": out, "cacheRead": cr, "cacheWrite": cw,
                "reasoning": rsn, "total": total, "cost": cost,
                "cost_input": float(co.get("input") or 0.0),
                "cost_output": float(co.get("output") or 0.0),
                "cost_cacheRead": float(co.get("cacheRead") or 0.0),
                "cost_cacheWrite": float(co.get("cacheWrite") or 0.0),
            })
            stot += total
            scost += cost
            if role == "assistant":
                ctx = inp + cr + cw
                ctx_all.append(ctx)
                ctx_max = max(ctx_max, ctx)
                out_all += out
                reason_all += rsn
                out_max = max(out_max, out)
                if dt:
                    week_ctx[dt.strftime("%G-W%V")].append(ctx)
        if stamps:
            sessions.append({"cwd": cwd, "turns": turns, "users": users, "tools": tools,
                             "total": stot, "cost": scost, "active": active,
                             "start": min(stamps), "end": max(stamps),
                             "best_run": best_run, "switches": switches, "aborts": sess_aborts,
                             "top_model": max(models, key=models.get) if models else "unknown"})

    ds = sorted(active_dates)
    best_streak = cur = 1 if ds else 0
    for i in range(1, len(ds)):
        gap = (_date.fromisoformat(ds[i]) - _date.fromisoformat(ds[i - 1])).days
        cur = cur + 1 if gap == 1 else 1
        best_streak = max(best_streak, cur)
    n_sess = len(sessions)
    weeks = []
    for wk in sorted(set(week_abort) | set(week_ctx)):
        a, b = week_abort.get(wk, [0, 0])
        c = week_ctx.get(wk, [])
        weeks.append({"w": wk[-3:], "rate": round(100 * a / b, 2) if b else 0,
                      "ctx": int(st.median(c)) if c else 0})
    tools_top = [{"name": k, "calls": v,
                  "err": round(100 * tool_err.get(k, 0) / v, 1) if v else 0}
                 for k, v in tool_tot.most_common(12)]
    X = {
        "aborts": aborts, "turns": turns_total, "errors": prov_errors,
        "interrupt_rate": 100 * aborts / turns_total if turns_total else 0,
        "sessions_interrupted": sum(1 for s in sessions if s["aborts"] > 0),
        "max_session_aborts": max((s["aborts"] for s in sessions), default=0),
        "autonomy_median": st.median([s["best_run"] for s in sessions]) if sessions else 0,
        "autonomy_max": max((s["best_run"] for s in sessions), default=0),
        "ctx_median": st.median(ctx_all) if ctx_all else 0,
        "ctx_p90": (sorted(ctx_all)[int(0.9 * len(ctx_all))] if ctx_all else 0),
        "ctx_max": ctx_max,
        "reason_share": 100 * reason_all / out_all if out_all else 0,
        "reply_median": st.median(reply_lat) if reply_lat else 0,
        "think_median": st.median(think_lat) if think_lat else 0,
        "tool_calls": sum(tool_tot.values()),
        "tool_err_rate": (100 * sum(tool_err.values()) / sum(tool_tot.values())
                          if tool_tot else 0),
        "edit_calls": edit_calls, "edits_add": edits_add, "edits_del": edits_del,
        "switch_sessions": sum(1 for s in sessions if s["switches"] > 0),
        "max_switches": max((s["switches"] for s in sessions), default=0),
        "ask": tool_tot.get("ask_question", 0),
        "self_compact": tool_tot.get("self_compact", 0),
        "recall": tool_tot.get("context_recall", 0),
        "max_out": out_max, "streak": best_streak,
        "weeks": weeks, "tools": tools_top, "think_levels": think_levels,
    }
    return rows, sessions, X


def fi(n):
    return f"{int(round(n)):,}"


def ftok(n):
    n = float(n)
    for unit, div in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if abs(n) >= div:
            return f"{n/div:.2f}{unit}"
    return f"{n:,.0f}"


def fusd(n):
    return f"${n:,.2f}"


def fhms(sec):
    sec = int(round(sec))
    h, r = divmod(sec, 3600)
    m, _ = divmod(r, 60)
    return f"{h}h {m}m" if h else f"{m}m"


def hist(values, edges, labels):
    out = []
    for i, lab in enumerate(labels):
        lo, hi = edges[i], edges[i + 1]
        n = sum(1 for v in values if (lo <= v <= hi if i == len(labels) - 1 else lo <= v < hi))
        out.append({"label": lab, "count": n})
    return out
