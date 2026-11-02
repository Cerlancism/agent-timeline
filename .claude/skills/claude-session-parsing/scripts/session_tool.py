#!/usr/bin/env python3
"""Inspect Claude Code session transcripts stored under ~/.claude/projects.

Subcommands (run with -h for options):
  find      locate a session by id or id prefix and print where it lives
  summary   one-screen overview: title, cwd, models, turns, tools, cost, subagents
  tree      the subagent spawn tree with per-agent stats
  timeline  chronological conversation: prompts, replies, tool calls, spawns
  export    normalized JSON events for downstream tooling

Every command accepts either a session id (full or prefix), a subagent id,
or a direct path to a .jsonl file. Set CLAUDE_PROJECTS_DIR to override the
default ~/.claude/projects location.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import Counter, OrderedDict, defaultdict
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover
    pass

PROJECTS_DIR = os.environ.get("CLAUDE_PROJECTS_DIR") or os.path.join(
    os.path.expanduser("~"), ".claude", "projects"
)

# User records whose text is injected by the harness rather than typed by a person.
INJECTED_PREFIXES = ("<task-notification>", "Another Claude session sent a message:", "<local-command")


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------

def parse_ts(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"warning: {os.path.basename(path)} line {n} is not valid JSON; skipped", file=sys.stderr)
    return rows


def resolve(target):
    """Turn a session id, subagent id, prefix, or path into a .jsonl path."""
    if os.path.isfile(target):
        return os.path.abspath(target)
    if os.path.isfile(target + ".jsonl"):
        return os.path.abspath(target + ".jsonl")
    pats = [
        os.path.join(PROJECTS_DIR, "*", f"{target}*.jsonl"),
        os.path.join(PROJECTS_DIR, "*", "*", "subagents", f"agent-{target}*.jsonl"),
        os.path.join(PROJECTS_DIR, "*", "*", "subagents", f"{target}*.jsonl"),
    ]
    hits = []
    for p in pats:
        hits.extend(glob.glob(p))
    hits = sorted(set(hits))
    if not hits:
        sys.exit(f"no session matching '{target}' under {PROJECTS_DIR}")
    if len(hits) > 1:
        print("ambiguous id, candidates:", file=sys.stderr)
        for h in hits:
            print("  " + h, file=sys.stderr)
        sys.exit(2)
    return hits[0]


def session_dir(path):
    """Sidecar directory holding subagents/ and tool-results/ for a top-level session."""
    base, _ = os.path.splitext(path)
    return base


def load_meta(agent_jsonl):
    meta = agent_jsonl[: -len(".jsonl")] + ".meta.json"
    if os.path.isfile(meta):
        try:
            return json.load(open(meta, encoding="utf-8"))
        except Exception:
            return {}
    return {}


# ----------------------------------------------------------------------------
# Normalisation
# ----------------------------------------------------------------------------

def text_of(content):
    """Flatten a message content field (string or block list) to its text parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                parts.append(b.get("text", ""))
            elif t == "image":
                parts.append("[image]")
        return "\n".join(parts)
    return ""


def classify_user(d):
    """Return human | tool_result | injected (injected = harness text in the user role)."""
    content = d.get("message", {}).get("content")
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return "tool_result"
    origin = (d.get("origin") or {}).get("kind")
    if origin == "human":
        return "human"
    if origin in ("peer", "task-notification"):
        return "injected"
    if d.get("isMeta"):
        return "injected"
    txt = text_of(content).lstrip()
    if txt.startswith(INJECTED_PREFIXES):
        return "injected"
    return "human"


def merge_assistant(rows):
    """Group assistant records by API message id.

    One API response is written as several lines (one per content block, see
    apiBlockIndex) and each line repeats the same usage object, so token counts
    must be taken once per message id, not once per line.
    """
    msgs = OrderedDict()
    for d in rows:
        if d.get("type") != "assistant":
            continue
        m = d.get("message", {})
        mid = m.get("id") or d.get("uuid")
        entry = msgs.get(mid)
        if entry is None:
            entry = msgs[mid] = {
                "id": mid,
                "uuid": d.get("uuid"),
                "timestamp": d.get("timestamp"),
                "model": m.get("model"),
                "usage": m.get("usage") or {},
                "stop_reason": m.get("stop_reason"),
                "blocks": [],
                "thinking_ms": d.get("thinkingDurationMs"),
                "agentId": d.get("agentId"),
            }
        for b in m.get("content") or []:
            entry["blocks"].append(b)
        if d.get("thinkingDurationMs"):
            entry["thinking_ms"] = d["thinkingDurationMs"]
    return msgs


def tool_results(rows):
    out = {}
    for d in rows:
        if d.get("type") != "user":
            continue
        content = d.get("message", {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                out[b.get("tool_use_id")] = {
                    "timestamp": d.get("timestamp"),
                    "content": b.get("content"),
                    "is_error": bool(b.get("is_error")),
                    "toolUseResult": d.get("toolUseResult"),
                    "permission": d.get("permissionDecision"),
                }
    return out


def short(s, n):
    s = (s or "").replace("\r", "")
    if n <= 0 or len(s) <= n:
        return s
    return s[:n].rstrip() + f"... [+{len(s) - n} chars]"


def one_line(s, n):
    return short(" ".join((s or "").split()), n)


def tool_input_brief(name, inp, n):
    inp = inp or {}
    if name == "Bash":
        return one_line(inp.get("command", ""), n)
    if name in ("Read", "Write", "Edit", "NotebookEdit"):
        return one_line(inp.get("file_path") or inp.get("notebook_path") or "", n)
    if name in ("Glob", "Grep"):
        return one_line(f"{inp.get('pattern', '')} {inp.get('path', '')}", n)
    if name == "Agent":
        return one_line(f"[{inp.get('subagent_type', '?')}] {inp.get('description', '')}", n)
    if name == "Skill":
        return one_line(f"{inp.get('skill', '')} {inp.get('args', '')}", n)
    if name == "SendMessage":
        return one_line(f"to={inp.get('to')} {inp.get('message', '')}", n)
    if name == "SubagentHandback":
        return one_line(inp.get("message", ""), n)
    return one_line(json.dumps(inp, ensure_ascii=False), n)


def titles(rows):
    t = {}
    for d in rows:
        ty = d.get("type")
        if ty == "ai-title":
            t["ai"] = d.get("aiTitle")
        elif ty == "custom-title":
            t["custom"] = d.get("customTitle")
        elif ty == "agent-name":
            t["agent_name"] = d.get("agentName")
        elif ty == "summary":  # legacy record type
            t["summary"] = d.get("summary")
    return t


def best_title(rows):
    t = titles(rows)
    return t.get("custom") or t.get("agent_name") or t.get("ai") or t.get("summary") or ""


def model_of(rows):
    c = Counter()
    for d in rows:
        if d.get("type") == "assistant":
            c[d.get("message", {}).get("model")] += 1
    return ", ".join(f"{m} x{n}" for m, n in c.most_common()) if c else "?"


def first_last_ts(rows):
    ts = [parse_ts(d.get("timestamp")) for d in rows if d.get("timestamp")]
    ts = [t for t in ts if t]
    if not ts:
        return None, None
    return min(ts), max(ts)


def fmt_dur(a, b):
    if not a or not b:
        return "?"
    s = int((b - a).total_seconds())
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


def sum_usage(msgs):
    tot = Counter()
    for m in msgs.values():
        u = m.get("usage") or {}
        for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            tot[k] += u.get(k) or 0
    return dict(tot)


# ----------------------------------------------------------------------------
# Subagents
# ----------------------------------------------------------------------------

def subagent_files(path):
    """agentId -> jsonl path for every subagent transcript beside this session."""
    out = {}
    d = os.path.join(session_dir(path), "subagents")
    for f in sorted(glob.glob(os.path.join(d, "agent-*.jsonl"))):
        aid = os.path.basename(f)[len("agent-"):-len(".jsonl")]
        out[aid] = f
    return out


def agent_stats(path):
    rows = read_jsonl(path)
    msgs = merge_assistant(rows)
    tools = Counter()
    handback = ""
    for m in msgs.values():
        for b in m["blocks"]:
            if b.get("type") == "tool_use":
                tools[b.get("name")] += 1
                if b.get("name") == "SubagentHandback":
                    handback = (b.get("input") or {}).get("message", "")
    a, b = first_last_ts(rows)
    return {
        "lines": len(rows),
        "messages": len(msgs),
        "model": model_of(rows),
        "tools": tools,
        "start": a,
        "end": b,
        "handback": handback,
        "usage": sum_usage(msgs),
        "first_prompt": next((text_of(d["message"].get("content")) for d in rows if d.get("type") == "user"), ""),
    }


def build_tree(path):
    files = subagent_files(path)
    metas = {aid: load_meta(f) for aid, f in files.items()}
    children = defaultdict(list)
    for aid, meta in metas.items():
        children[meta.get("parentAgentId") or "ROOT"].append(aid)
    return files, metas, children


def print_tree(path, verbose):
    files, metas, children = build_tree(path)
    if not files:
        print("no subagents/ directory beside this session")
        return

    def walk(parent, depth):
        for aid in sorted(children.get(parent, []), key=lambda a: os.path.getmtime(files[a])):
            meta = metas[aid]
            st = agent_stats(files[aid])
            pad = "  " * depth
            shape = meta.get("requestShape", "?")
            fin = "done" if meta.get("finished") else "unfinished"
            print(f"{pad}- {aid}  {meta.get('agentType', '?')}  \"{meta.get('description', '')}\"")
            print(f"{pad}    shape={shape} {fin}  model={st['model']}  dur={fmt_dur(st['start'], st['end'])}  "
                  f"msgs={st['messages']}  tools={sum(st['tools'].values())}  out_tok={st['usage'].get('output_tokens', 0)}")
            if verbose:
                top = ", ".join(f"{k} x{v}" for k, v in st["tools"].most_common(6))
                print(f"{pad}    tools: {top}")
                print(f"{pad}    prompt: {one_line(st['first_prompt'], 160)}")
                if st["handback"]:
                    print(f"{pad}    handback: {one_line(st['handback'], 200)}")
            walk(aid, depth + 1)

    walk("ROOT", 0)


# ----------------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------------

def cmd_find(args):
    path = resolve(args.target)
    rows = read_jsonl(path)
    a, b = first_last_ts(rows)
    print(f"path:      {path}")
    print(f"project:   {os.path.basename(os.path.dirname(path))}")
    sd = session_dir(path)
    print(f"sidecar:   {sd if os.path.isdir(sd) else '(none)'}")
    print(f"title:     {best_title(rows)}")
    first = next((text_of(d['message'].get('content')) for d in rows
                  if d.get('type') == 'user' and classify_user(d) == 'human'), "")
    print(f"first:     {one_line(first, 120)}")
    cwd = next((d.get("cwd") for d in rows if d.get("cwd")), "?")
    ver = next((d.get("version") for d in rows if d.get("version")), "?")
    ep = next((d.get("entrypoint") for d in rows if d.get("entrypoint")), "?")
    print(f"cwd:       {cwd}   version: {ver}   entrypoint: {ep}")
    print(f"span:      {a.isoformat() if a else '?'} .. {b.isoformat() if b else '?'}  ({fmt_dur(a, b)})")
    print(f"lines:     {len(rows)}   subagents: {len(subagent_files(path))}")
    for d in rows:
        if d.get("type") == "continued-in":
            print(f"continued: {d.get('continuedInSessionId')}")


def cmd_summary(args):
    path = resolve(args.target)
    rows = read_jsonl(path)
    msgs = merge_assistant(rows)
    results = tool_results(rows)
    a, b = first_last_ts(rows)
    types = Counter(d.get("type") for d in rows)
    user_kinds = Counter(classify_user(d) for d in rows if d.get("type") == "user")
    tools = Counter()
    errors = 0
    spawned = []
    for m in msgs.values():
        for blk in m["blocks"]:
            if blk.get("type") == "tool_use":
                tools[blk.get("name")] += 1
                r = results.get(blk.get("id"))
                if r and r["is_error"]:
                    errors += 1
                if blk.get("name") == "Agent":
                    spawned.append((blk.get("input") or {}).get("description", ""))
    sys_sub = Counter(d.get("subtype") for d in rows if d.get("type") == "system")
    usage = sum_usage(msgs)

    print(f"session:   {os.path.basename(path)}")
    print(f"title:     {best_title(rows)}")
    cwd = next((d.get("cwd") for d in rows if d.get("cwd")), "?")
    print(f"cwd:       {cwd}")
    print(f"span:      {a.isoformat() if a else '?'} .. {b.isoformat() if b else '?'}  ({fmt_dur(a, b)})")
    print(f"models:    {model_of(rows)}")
    print(f"turns:     {user_kinds.get('human', 0)} human prompts, {user_kinds.get('injected', 0)} injected, "
          f"{len(msgs)} assistant messages, {user_kinds.get('tool_result', 0)} tool results")
    print(f"tokens:    in={usage.get('input_tokens', 0)} out={usage.get('output_tokens', 0)} "
          f"cache_read={usage.get('cache_read_input_tokens', 0)} cache_write={usage.get('cache_creation_input_tokens', 0)}"
          "  (this file only)")
    print(f"tools:     {', '.join(f'{k} x{v}' for k, v in tools.most_common())}" + (f"   errors={errors}" if errors else ""))
    if sys_sub:
        print(f"system:    {', '.join(f'{k} x{v}' for k, v in sys_sub.most_common())}")
    cost = next((d for d in reversed(rows) if d.get("type") == "cost-state"), None)
    if cost:
        print(f"cost:      ${cost.get('totalCostUSD', 0):.4f}  api={cost.get('totalAPIDuration', 0) / 1000:.0f}s "
              f"tool={cost.get('totalToolDuration', 0) / 1000:.0f}s  +{cost.get('totalLinesAdded', 0)}/-{cost.get('totalLinesRemoved', 0)} lines "
              "(cumulative, includes subagents)")
        for model, u in (cost.get("modelUsage") or {}).items():
            print(f"             {model}: out={u.get('outputTokens', 0)} think={u.get('thinkingTokens', 0)} "
                  f"cache_read={u.get('cacheReadInputTokens', 0)} ${u.get('costUSD', 0):.4f}")
    subs = subagent_files(path)
    print(f"subagents: {len(subs)} transcripts" + (f"; spawned here: {', '.join(spawned)}" if spawned else ""))
    print(f"records:   {', '.join(f'{k} x{v}' for k, v in types.most_common())}")
    print()
    print("human prompts:")
    for d in rows:
        if d.get("type") == "user" and classify_user(d) == "human":
            print(f"  {d.get('timestamp', '')[11:19]}  {one_line(text_of(d['message'].get('content')), args.width)}")


def iter_events(rows, agent_label, opts):
    """Produce normalized events from one transcript's rows."""
    msgs = merge_assistant(rows)
    results = tool_results(rows)
    ev = []
    for d in rows:
        ty = d.get("type")
        ts = d.get("timestamp")
        if ty == "user":
            kind = classify_user(d)
            if kind == "tool_result":
                continue  # shown beside its tool_use
            if kind == "injected" and not opts.injected:
                continue
            ev.append({"ts": ts, "agent": agent_label, "kind": kind, "text": text_of(d["message"].get("content")),
                       "origin": (d.get("origin") or {}).get("kind"), "uuid": d.get("uuid")})
        elif ty == "system":
            st = d.get("subtype")
            if st in ("compact_boundary", "away_summary", "informational", "local_command") or opts.injected:
                ev.append({"ts": ts, "agent": agent_label, "kind": f"system:{st}", "text": d.get("content") or "",
                           "meta": d.get("compactMetadata"), "uuid": d.get("uuid")})
    for m in msgs.values():
        texts, thinks, uses = [], [], []
        for b in m["blocks"]:
            t = b.get("type")
            if t == "text":
                texts.append(b.get("text", ""))
            elif t == "thinking":
                thinks.append(b.get("thinking", ""))
            elif t == "tool_use":
                uses.append(b)
        if thinks and opts.thinking:
            ev.append({"ts": m["timestamp"], "agent": agent_label, "kind": "thinking", "text": "\n".join(thinks),
                       "thinking_ms": m.get("thinking_ms"), "model": m["model"], "msg": m["id"]})
        if texts:
            ev.append({"ts": m["timestamp"], "agent": agent_label, "kind": "assistant", "text": "\n".join(texts),
                       "model": m["model"], "msg": m["id"], "usage": m["usage"]})
        for u in uses:
            r = results.get(u.get("id"))
            tur = (r or {}).get("toolUseResult")
            e = {"ts": m["timestamp"], "agent": agent_label, "kind": "tool_use", "tool": u.get("name"),
                 "tool_use_id": u.get("id"), "input": u.get("input"), "model": m["model"], "msg": m["id"]}
            if r:
                e["result_ts"] = r["timestamp"]
                e["is_error"] = r["is_error"]
                e["result_text"] = r["content"] if isinstance(r["content"], str) else text_of(r["content"])
                if isinstance(tur, dict) and tur.get("agentId"):
                    e["spawned_agent"] = tur["agentId"]
                if isinstance(tur, dict) and tur.get("persistedOutputPath"):
                    e["persisted_output"] = tur["persistedOutputPath"]
                if r.get("permission"):
                    e["permission"] = r["permission"]
            else:
                e["result_text"] = None
            ev.append(e)
    ev.sort(key=lambda e: (e.get("ts") or ""))
    return ev


def collect_events(path, opts):
    rows = read_jsonl(path)
    main_label = None
    if os.path.basename(os.path.dirname(path)) == "subagents":
        main_label = os.path.basename(path)[len("agent-"):-len(".jsonl")]
    events = iter_events(rows, main_label, opts)
    if opts.agents:
        files, metas, _ = build_tree(path)
        for aid, f in files.items():
            if opts.agent and not aid.startswith(opts.agent):
                continue
            label = f"{aid}:{metas.get(aid, {}).get('agentType', '?')}"
            events.extend(iter_events(read_jsonl(f), label, opts))
        events.sort(key=lambda e: (e.get("ts") or ""))
    return events


def cmd_timeline(args):
    path = resolve(args.target)
    events = collect_events(path, args)
    w = 0 if args.full else args.width
    last_day = None
    for e in events:
        ts = e.get("ts") or ""
        day, clock = ts[:10], ts[11:19]
        if day != last_day:
            print(f"==== {day}")
            last_day = day
        tag = f"[{e['agent']}] " if e.get("agent") else ""
        k = e["kind"]
        if k == "human":
            print(f"{clock} {tag}USER: {short(e['text'], w)}")
        elif k == "injected":
            print(f"{clock} {tag}INJECTED({e.get('origin') or 'meta'}): {one_line(e['text'], w or 200)}")
        elif k == "assistant":
            print(f"{clock} {tag}ASSISTANT: {short(e['text'], w)}")
        elif k == "thinking":
            print(f"{clock} {tag}THINKING({e.get('thinking_ms')}ms): {short(e['text'], w)}")
        elif k == "tool_use":
            if args.no_tools:
                continue
            brief = tool_input_brief(e["tool"], e.get("input") or {}, w or 10**9)
            err = " ERROR" if e.get("is_error") else ""
            spawn = f" -> agent {e['spawned_agent']}" if e.get("spawned_agent") else ""
            print(f"{clock} {tag}TOOL {e['tool']}{err}{spawn}: {brief}")
            if e.get("result_text") is not None and not args.no_results:
                rb = one_line(e["result_text"], w or 10**9)
                if rb:
                    print(f"         {tag}  -> {rb}")
        elif k.startswith("system:"):
            print(f"{clock} {tag}{k.upper()}: {one_line(e['text'], w or 300)}")
        if args.blank:
            print()


def cmd_export(args):
    path = resolve(args.target)
    events = collect_events(path, args)
    rows = read_jsonl(path)
    a, b = first_last_ts(rows)
    doc = {
        "session": os.path.basename(path).replace(".jsonl", ""),
        "path": path,
        "title": best_title(rows),
        "cwd": next((d.get("cwd") for d in rows if d.get("cwd")), None),
        "start": a.isoformat() if a else None,
        "end": b.isoformat() if b else None,
        "events": events,
    }
    files, metas, _ = build_tree(path)
    doc["subagents"] = {aid: {**metas.get(aid, {}), "path": f} for aid, f in files.items()}
    out = json.dumps(doc, ensure_ascii=False, indent=None if args.compact else 2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out)
        print(f"wrote {args.out} ({len(events)} events)")
    else:
        print(out)


def cmd_tree(args):
    path = resolve(args.target)
    print_tree(path, args.verbose)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("target", help="session id, id prefix, subagent id, or path to a .jsonl")

    s = sub.add_parser("find", help="locate a session and print basic facts")
    common(s)
    s.set_defaults(fn=cmd_find)
    s = sub.add_parser("summary", help="overview of one transcript")
    common(s)
    s.add_argument("--width", type=int, default=160)
    s.set_defaults(fn=cmd_summary)
    s = sub.add_parser("tree", help="subagent spawn tree")
    common(s)
    s.add_argument("-v", "--verbose", action="store_true", help="show tools, prompt and handback per agent")
    s.set_defaults(fn=cmd_tree)
    for name, fn in (("timeline", cmd_timeline), ("export", cmd_export)):
        s = sub.add_parser(name, help=f"{name} of the conversation")
        common(s)
        s.add_argument("--agents", action="store_true", help="interleave every subagent transcript")
        s.add_argument("--agent", help="with --agents: only this agent id (prefix ok)")
        s.add_argument("--thinking", action="store_true", help="include thinking blocks (usually empty/redacted)")
        s.add_argument("--injected", action="store_true", help="include harness-injected user turns and all system records")
        if name == "timeline":
            s.add_argument("--width", type=int, default=240, help="truncate each line to N chars (0 = no limit)")
            s.add_argument("--full", action="store_true", help="no truncation at all")
            s.add_argument("--no-tools", action="store_true", help="hide tool calls")
            s.add_argument("--no-results", action="store_true", help="hide tool result previews")
            s.add_argument("--blank", action="store_true", help="blank line between events")
        else:
            s.add_argument("-o", "--out", help="write JSON here instead of stdout")
            s.add_argument("--compact", action="store_true")
        s.set_defaults(fn=fn)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
