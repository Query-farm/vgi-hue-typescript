#!/usr/bin/env python3
# managed-by: vgi-starters (edit upstream in shared/, then run tools/render.py)
"""Turn this VGI starter template into your own worker, and keep up with it later.

    python3 scripts/vgi_template.py init weather            # or: make init NAME=weather
    python3 scripts/vgi_template.py init weather --repo acme/weather-worker
    python3 scripts/vgi_template.py template-diff           # or: make template-diff

``init`` renames every identifier derived from ``starter`` (catalog, package,
binary, env vars, secret type), removes template-only blocks and files,
enables fork-only lines, regenerates lockfiles, and records where the project
came from in ``.vgi-starter.json``.

``template-diff`` shows what changed upstream since your copy was made, so you
can pick up fixes to CI, docs and examples.

Only the Python standard library is used, so this runs anywhere Python 3.9+
does (macOS, Linux, Windows).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROVENANCE = ROOT / ".vgi-starter.json"
SELF = Path(__file__).resolve()

SKIP_DIRS = {".git", ".venv", ".tools", "node_modules", "target", "build", "dist", "bin", "obj", ".gradle",
             "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache", ".idea", ".vscode"}
LOCKFILES = {"uv.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "packages.lock.json"}
# Phrases that mention the template itself and must survive the rename.
# The hosted demo API keeps its name in every fork.
PROTECTED = [
    "vgi-starter-api.query-farm.services",
    "starter template",
    "Starter template",
    "Starter Template",
    "vgi-starters",
]

RESERVED = {"main", "system", "temp", "memory", "information_schema", "pg_catalog", "default",
            "select", "from", "where", "table", "order", "group", "end", "interval"}


def _names(snake: str) -> dict[str, str]:
    parts = snake.split("_")
    return {
        "snake": snake,
        "kebab": "-".join(parts),
        "pascal": "".join(p.capitalize() for p in parts),
        "upper": snake.upper(),
        "title": " ".join(p.capitalize() for p in parts),
    }


def _replacements(n: dict[str, str], lang: str, repo: str) -> list[tuple[re.Pattern[str], str]]:
    """Ordered (pattern, replacement) pairs; longest, most specific first."""
    word = r"(?<![A-Za-z0-9]){}(?![A-Za-z0-9])"
    pairs = [
        (re.escape(f"Query-farm/vgi-starter-{lang}"), repo),
        (re.escape("vgi-starter-worker"), f"vgi-{n['kebab']}-worker"),
        (re.escape(f"vgi-starter-{lang}"), repo.split("/")[-1]),
        (re.escape("starter_worker"), f"{n['snake']}_worker"),
        (re.escape("starter_api"), f"{n['snake']}_api"),
        (re.escape("starter-worker"), f"{n['kebab']}-worker"),
        (r"(?<![A-Za-z0-9])STARTER_", f"{n['upper']}_"),
        (re.escape("StarterWorker"), f"{n['pascal']}Worker"),
        (word.format("Starter"), n["pascal"]),
        (word.format("starter"), n["snake"]),
    ]
    return [(re.compile(p), r) for p, r in pairs]


def _rename_text(text: str, reps: list[tuple[re.Pattern[str], str]]) -> str:
    shields = {}
    for i, phrase in enumerate(PROTECTED):
        token = f"\x00{i}\x00"
        shields[token] = phrase
        text = text.replace(phrase, token)
    for pattern, replacement in reps:
        text = pattern.sub(replacement, text)
    for token, phrase in shields.items():
        text = text.replace(token, phrase)
    return text


_BLOCK = re.compile(r"^[^\n]*template-only:start[^\n]*\n.*?^[^\n]*template-only:end[^\n]*\n", re.S | re.M)
_FORK_ONLY = re.compile(r"^(\s*)(?:#|//|--|<!--)\s*fork-only:\s?(.*?)(?:\s*-->)?$", re.M)


def _strip_template_only(text: str) -> str:
    text = _BLOCK.sub("", text)
    return _FORK_ONLY.sub(lambda m: m.group(1) + m.group(2), text)


def _iter_files() -> list[Path]:
    """Files git would track (honours .gitignore); a plain walk outside a git checkout."""
    try:
        out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                             cwd=ROOT, capture_output=True, text=True, check=True).stdout
        return [ROOT / f for f in out.split("\0") if f and (ROOT / f).is_file()]
    except (OSError, subprocess.CalledProcessError):
        pass
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        files.extend(Path(dirpath) / f for f in filenames)
    return files


def _git_remote_slug() -> str | None:
    try:
        url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True,
                             text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    m = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?$", url)
    if not m or m.group(1).lower().startswith("query-farm/vgi-starter"):
        return None
    return m.group(1)


def cmd_init(args: argparse.Namespace) -> int:
    prov = json.loads(PROVENANCE.read_text())
    if prov.get("name"):
        print(f"already initialized as {prov['name']!r}; nothing to do", file=sys.stderr)
        return 1
    snake = args.name.strip().lower().replace("-", "_")
    if not re.fullmatch(r"[a-z][a-z0-9_]{1,40}", snake) or snake in RESERVED or snake == "starter":
        print(f"invalid name {args.name!r}: use snake_case letters/digits (e.g. weather, crm_sync), "
              "not a SQL keyword", file=sys.stderr)
        return 2
    lang = prov["lang"]
    n = _names(snake)
    repo = args.repo or _git_remote_slug() or f"your-org/vgi-{n['kebab']}"
    reps = _replacements(n, lang, repo)

    for rel in prov.get("template_only_files", []):
        target = ROOT / rel
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
    if args.minimal:
        for rel in prov.get("optional_files", []):
            (ROOT / rel).unlink(missing_ok=True)

    changed = 0
    for path in _iter_files():  # snapshot before renames below
        if path.resolve() in (SELF, PROVENANCE.resolve()) or path.name in LOCKFILES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary file
        new = _rename_text(_strip_template_only(text), reps)
        if new != text:
            path.write_text(new, encoding="utf-8")
            changed += 1

    # Rename files and directories whose names contain the identifiers (deepest first).
    files = _iter_files()
    dirs = {parent for f in files for parent in f.relative_to(ROOT).parents if parent != Path(".")}
    paths = sorted([*files, *(ROOT / d for d in dirs)], key=lambda p: len(p.parts), reverse=True)
    for path in paths:
        if path.resolve() in (SELF, PROVENANCE.resolve()):
            continue
        new_name = _rename_text(path.name, reps)
        if new_name != path.name:
            path.rename(path.with_name(new_name))

    prov.update({"name": snake, "repo": repo, "initialized": dt.date.today().isoformat()})
    PROVENANCE.write_text(json.dumps(prov, indent=2) + "\n")
    print(f"renamed starter -> {snake} in {changed} files (repo: {repo})")

    if not args.no_post:
        for command in prov.get("post_init", []):
            print(f"$ {command}")
            if subprocess.run(command, shell=True, cwd=ROOT).returncode != 0:
                print(f"post-init step failed: {command} (fix it, then re-run it by hand)", file=sys.stderr)
                return 1
    print("done. Next: make check")
    return 0


def cmd_template_diff(args: argparse.Namespace) -> int:
    prov = json.loads(PROVENANCE.read_text())
    url = f"https://github.com/Query-farm/{prov['template']}.git"
    base_tag, target = f"v{prov['template_version']}", args.to
    print(f"fetching {url} ({base_tag} .. {target})")
    refspecs = [f"refs/tags/{base_tag}:refs/vgi-template/base", f"{target}:refs/vgi-template/target"]
    fetch = subprocess.run(["git", "fetch", "--no-tags", "--force", url, *refspecs], cwd=ROOT)
    if fetch.returncode != 0:
        return fetch.returncode
    diff = ["git", "diff", "--stat" if args.stat else "--patch", "refs/vgi-template/base", "refs/vgi-template/target"]
    return subprocess.run(diff, cwd=ROOT).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_init = sub.add_parser("init", help="rename the template to your worker's name")
    p_init.add_argument("name", help="snake_case worker name, e.g. weather or crm_sync")
    p_init.add_argument("--repo", help="GitHub owner/repo for links (default: from git origin)")
    p_init.add_argument("--minimal", action="store_true", help="also drop optional files (nightly CI, dependabot)")
    p_init.add_argument("--no-post", action="store_true", help="skip lockfile regeneration")
    p_init.set_defaults(func=cmd_init)
    p_diff = sub.add_parser("template-diff", help="show upstream template changes since this copy was made")
    p_diff.add_argument("--to", default="main", help="upstream ref to compare against (default: main)")
    p_diff.add_argument("--stat", action="store_true", help="summary only")
    p_diff.set_defaults(func=cmd_template_diff)
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
