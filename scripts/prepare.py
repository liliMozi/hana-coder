#!/usr/bin/env python3
"""Prepare a repository-bound, self-contained Hana Coder card package."""
import argparse
import datetime
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE_BUDGET = 60 * 1024


def script_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def replace_block(html, attribute, value):
    pattern = r'(<script\b[^>]*\b' + re.escape(attribute) + r'[^>]*>)[\s\S]*?(</script>)'
    html, count = re.subn(pattern, lambda m: m[1] + script_json(value) + m[2], html, count=1)
    if count != 1:
        raise ValueError("Template must contain " + attribute)
    return html


def read_block(html, attribute):
    found = re.search(r'<script\b[^>]*\b' + re.escape(attribute) + r'[^>]*>([\s\S]*?)</script>', html)
    if not found:
        raise ValueError("Template is missing " + attribute)
    return json.loads(found.group(1))


def collect(args):
    argv = [sys.executable, str(ROOT / "scripts" / "collect.py"), args.kind, "--repo", args.repo]
    if args.kind == "prs":
        if not args.remote:
            raise ValueError("PR preparation requires --remote OWNER/REPO")
        argv += ["--remote", args.remote, "--host", args.host, "--limit", str(args.limit)]
        if args.number is not None:
            argv += ["--number", str(args.number)]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Collection failed")
    line = next((line for line in result.stdout.splitlines() if line.startswith("HANA_SNAPSHOT=")), None)
    if line is None:
        raise ValueError("Collector did not return HANA_SNAPSHOT")
    return json.loads(line[len("HANA_SNAPSHOT="):]), argv


def summaries_for(args, records, key="id"):
    if not args.summaries:
        return {}
    value = json.loads(pathlib.Path(args.summaries).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("--summaries must contain a JSON object keyed by object identity")
    if args.kind == "worktrees" and not all(isinstance(v, str) for v in value.values()):
        raise ValueError("Worktree summaries must be strings")
    if args.kind == "prs" and not all(isinstance(v, dict) and isinstance(v.get("summary"), str) for v in value.values()):
        raise ValueError("PR summaries must contain objects with summary text")
    return {r[key]: value[r[key]] for r in records if r[key] in value}


def shell_command(argv):
    return ("& " + " ".join("'" + part.replace("'", "''") + "'" for part in argv)) if os.name == "nt" else shlex.join(argv)


def command_panel(args):
    if not args.repo:
        raise ValueError("Command preparation requires --repo")
    repo = str(pathlib.Path(args.repo).expanduser().resolve())
    if not pathlib.Path(repo).is_dir():
        raise ValueError("Repository directory does not exist")
    commands = json.loads(pathlib.Path(args.commands).read_text(encoding="utf-8")) if args.commands else [
        {"id": "status", "name": "查看改动", "argv": ["git", "status", "--short"]},
        {"id": "log", "name": "最近提交", "argv": ["git", "log", "-10", "--oneline"]},
        {"id": "diff", "name": "改动概览", "argv": ["git", "diff", "--stat"]},
        {"id": "trees", "name": "工作树列表", "argv": ["git", "worktree", "list"]},
    ]
    if not isinstance(commands, list) or not commands:
        raise ValueError("--commands must contain a nonempty command array")
    bindings, items, seen = {}, [], set()
    for command in commands:
        if not isinstance(command, dict) or not isinstance(command.get("id"), str) or not isinstance(command.get("name"), str):
            raise ValueError("Command id and name are required")
        identity, argv = command["id"], command.get("argv")
        if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,50}', identity) or identity in seen:
            raise ValueError("Command ids must be unique lowercase identifiers")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and '\x00' not in a for a in argv):
            raise ValueError("Command argv must contain strings")
        cwd = str(pathlib.Path(command.get("cwd", repo)).expanduser().resolve())
        if not pathlib.Path(cwd).is_dir():
            raise ValueError("Command working directory does not exist")
        seen.add(identity)
        binding = 'run-' + identity
        runner = [sys.executable, str(ROOT / 'scripts' / 'run_command.py'), '--cwd', cwd, '--argv-json', json.dumps(argv, ensure_ascii=False)]
        bindings[binding] = {"tool": "exec_command", "input": {"cmd": shell_command(runner), "shell": "powershell" if os.name == "nt" else "bash", "workdir": cwd, "yield_time_ms": 60000, "max_output_tokens": 8000, "timeout": 360}}
        items.append({"id": identity, "name": command['name'], "argv": argv, "cwd": cwd, "command": shlex.join(argv), "mode": "binding", "bindingId": binding})
    return {"repoPath": repo, "repoLabel": pathlib.Path(repo).name, "commands": items, "requestId": None, "pending": False, "draft": "", "runs": {}, "activeRun": None, "message": ""}, bindings


def prepare(args):
    out = pathlib.Path(args.out).expanduser().resolve()
    if out.exists():
        raise ValueError("Output already exists; choose a new card directory: " + str(out))
    if args.kind in ("worktrees", "prs"):
        if not args.repo:
            raise ValueError("Repository path is required")
        args.repo = str(pathlib.Path(args.repo).expanduser().resolve())
        snapshot, argv = collect(args)
        name = "worktrees" if args.kind == "worktrees" else "pr-review"
        model = dict(snapshot)
        records = model.get("rows" if args.kind == "worktrees" else "prs", [])
        model.update(summaries=summaries_for(args, records), phase="idle", refreshId=None, message="")
        if args.kind == "prs":
            model.update(reviews={}, reviewRequest=None, notes={}, page=0)
            model.setdefault("number", args.number)
        state = {"uiLanguage": args.language, "model": model}
    elif args.kind == "commands":
        panel, command_bindings = command_panel(args)
        name, argv = "commands", None
        snapshot = panel
        state = {"uiLanguage": args.language, "panel": panel}
    else:
        name = args.kind
        if not args.state:
            raise ValueError("Issue preparation requires a complete --state JSON file")
        state = json.loads(pathlib.Path(args.state).read_text(encoding="utf-8"))
        if not isinstance(state, dict) or not isinstance(state.get("groups"), list):
            raise ValueError("Issue state must contain groups")
        state.setdefault("uiLanguage", args.language)
        state["hero"] = True
        snapshot = state
        argv = None
    if len(script_json(state).encode("utf-8")) > STATE_BUDGET:
        raise ValueError("Snapshot exceeds the card state budget; reduce the PR limit or requested scope")
    source = ROOT / "assets" / (name + ".card.html")
    html = source.read_text(encoding="utf-8")
    manifest = read_block(html, "data-card-manifest")
    if argv:
        command = shell_command(argv)
        manifest["toolBindings"] = {"scan": {"tool": "exec_command", "input": {
            "cmd": command, "shell": "powershell" if os.name == "nt" else "bash", "workdir": args.repo,
            "yield_time_ms": 60000, "max_output_tokens": 24000, "timeout": 120,
        }}}
    if args.kind == "commands":
        manifest["toolBindings"] = command_bindings
    html = replace_block(html, "data-card-manifest", manifest)
    html = replace_block(html, "data-card-state", state)
    assets = manifest.get("packageAssets", [])
    resolved = []
    for item in assets:
        relative = pathlib.PurePosixPath(item)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.parts[0] != "assets":
            raise ValueError("Invalid package asset: " + str(item))
        asset = ROOT.joinpath(*relative.parts)
        if not asset.is_file():
            raise ValueError("Package asset is missing: " + item)
        resolved.append((relative, asset))
    out.mkdir(parents=True)
    for relative, asset in resolved:
        destination = out.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset, destination)
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / "snapshot.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"cardDirectory": str(out), "file": {"type": "path", "path": str(out)},
            "snapshotPath": str(out / "snapshot.json"), "kind": args.kind,
            "at": snapshot.get("at"), "objects": len(snapshot.get("rows", snapshot.get("prs", snapshot.get("groups", snapshot.get("commands", [])))))}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("kind", choices=["worktrees", "prs", "issue-gate", "issue-report", "commands"])
    p.add_argument("--repo")
    p.add_argument("--remote")
    p.add_argument("--host", default="github.com")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--number", type=int)
    p.add_argument("--out", required=True)
    p.add_argument("--summaries")
    p.add_argument("--commands")
    p.add_argument("--state")
    p.add_argument("--language", default="zh")
    return p


if __name__ == "__main__":
    try:
        print(json.dumps(prepare(parser().parse_args()), ensure_ascii=False))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print("Cannot prepare card: " + str(error), file=sys.stderr)
        sys.exit(1)
