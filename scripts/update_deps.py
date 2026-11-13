#!/usr/bin/env python3
"""Safe, manual dependency updater.

    python3 scripts/update_deps.py               # apply safe updates, test, roll back on failure
    python3 scripts/update_deps.py --check       # report only: outdated + known vulnerabilities
    python3 scripts/update_deps.py --skip-build  # skip `vite build` (e.g. if a security agent blocks bundlers)
    python3 scripts/update_deps.py --only npm    # or --only python

"Safe" means:
  * npm   : `npm update` within package.json ranges + `npm audit fix` (never --force)
  * python: upgrade within requirements.txt ranges (which cap the next major)
  * then  : backend tests, frontend typecheck/tests/build. Any failure restores the previous
            lockfile / environment exactly.
Major-version upgrades are never applied; they are listed in the report for review
(Dependabot opens PRs for them on GitHub).
Reports are written to .dependency-reports/ (git-ignored).
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
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND, APP = ROOT / "backend", ROOT / "app"
REPORTS = ROOT / ".dependency-reports"
NPM_FILES = ("package.json", "package-lock.json")
PY = BACKEND / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
NPM = shutil.which("npm") or "npm"


def node_env() -> dict[str, str]:
    """Trust the OS certificate store (corporate TLS-inspection proxies) — Node 22.15+."""
    env = dict(os.environ)
    if "--use-system-ca" not in env.get("NODE_OPTIONS", ""):
        env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + " --use-system-ca").strip()
    return env


def sh(cmd: list, cwd: Path = ROOT, check: bool = False) -> subprocess.CompletedProcess:
    print(f"$ {' '.join(map(str, cmd))}", flush=True)
    p = subprocess.run([str(c) for c in cmd], cwd=cwd, capture_output=True, text=True, env=node_env())
    if check and p.returncode:
        raise RuntimeError(f"{' '.join(map(str, cmd))} failed:\n{(p.stdout + p.stderr)[-3000:]}")
    return p


def as_json(p: subprocess.CompletedProcess, default):
    try:
        return json.loads(p.stdout or "null") or default
    except json.JSONDecodeError:
        return default


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


# ---------- inventories ----------

def npm_versions() -> dict[str, str]:
    deps = as_json(sh([NPM, "ls", "--depth=0", "--json"], APP), {}).get("dependencies", {})
    return {k: v.get("version", "?") for k, v in deps.items()}


def npm_outdated() -> dict[str, dict]:
    return as_json(sh([NPM, "outdated", "--json"], APP), {})


def npm_audit(prod_only: bool) -> dict[str, int]:
    cmd = [NPM, "audit", "--json"] + (["--omit=dev"] if prod_only else [])
    meta = as_json(sh(cmd, APP), {}).get("metadata", {})
    return {k: v for k, v in meta.get("vulnerabilities", {}).items() if k != "total" and v}


def py_versions() -> dict[str, str]:
    return {norm(d["name"]): d["version"] for d in as_json(sh([PY, "-m", "pip", "list", "--format=json"]), [])}


def py_direct() -> set[str]:
    names = set()
    for line in (BACKEND / "requirements.txt").read_text().splitlines():
        line = line.split("#")[0].strip()
        if line and not line.startswith("-"):
            names.add(norm(re.split(r"[\[<>=~!; ]", line, maxsplit=1)[0]))
    return names


def py_outdated() -> dict[str, dict]:
    rows = as_json(sh([PY, "-m", "pip", "list", "--outdated", "--format=json"]), [])
    direct = py_direct()
    return {norm(r["name"]): r for r in rows if norm(r["name"]) in direct}


def py_audit() -> list[str]:
    if sh([PY, "-m", "pip_audit", "--version"]).returncode:
        sh([PY, "-m", "pip", "install", "-q", "-r", BACKEND / "requirements-dev.txt"])
    data = as_json(sh([PY, "-m", "pip_audit", "--format=json", "--progress-spinner=off"], BACKEND), {})
    return [f"{d['name']} {d['version']}: {', '.join(sorted({v['id'] for v in d['vulns']}))}"
            for d in data.get("dependencies", []) if d.get("vulns")]


# ---------- verification ----------

def verify(do_npm: bool, do_py: bool, skip_build: bool) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, list, Path]] = []
    if do_py:
        checks += [
            ("backend imports", [PY, "-c", "import main"], BACKEND),
            ("backend coach tests", [PY, "tests/test_coach.py"], BACKEND),
            ("backend adaptive tests", [PY, "tests/test_adaptive.py"], BACKEND),
            ("backend encryption tests", [PY, "tests/test_secure_store.py"], BACKEND),
            ("backend API auth tests", [PY, "tests/test_api_auth.py"], BACKEND),
        ]
    if do_npm:
        checks += [("frontend typecheck", [NPM, "run", "typecheck"], APP),
                   ("frontend tests", [NPM, "test"], APP)]
        if not skip_build:
            checks.append(("frontend build", [NPM, "exec", "--", "vite", "build"], APP))
    results = []
    for name, cmd, cwd in checks:
        p = sh(cmd, cwd)
        results.append((name, p.returncode == 0, (p.stdout + p.stderr)[-2500:]))
        print(f"  {'✓' if p.returncode == 0 else '✗'} {name}")
    return results


# ---------- main ----------

def diff(before: dict, after: dict) -> list[str]:
    return [f"{k}: {before.get(k, '—')} → {v}" for k, v in sorted(after.items()) if before.get(k) != v]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report only; change nothing")
    ap.add_argument("--skip-build", action="store_true", help="skip the vite production build check")
    ap.add_argument("--only", choices=["npm", "python"])
    args = ap.parse_args()
    do_npm, do_py = args.only != "python", args.only != "npm"

    if do_py and not PY.exists():
        print("backend/venv missing — run `python3 scripts/setup.py` first.", file=sys.stderr)
        return 2
    if do_npm and not (APP / "node_modules").exists():
        print("app/node_modules missing — run `python3 scripts/setup.py` first.", file=sys.stderr)
        return 2

    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    lines = [f"# Dependency update — {stamp}", "", f"Mode: {'check only' if args.check else 'safe update'}", ""]
    backup = Path(tempfile.mkdtemp(prefix="ec-deps-"))
    npm_before = npm_versions() if do_npm else {}
    py_before = py_versions() if do_py else {}
    ok = True

    try:
        if not args.check:
            if do_npm:
                for f in NPM_FILES:
                    shutil.copy2(APP / f, backup / f)
            if do_py:
                (backup / "freeze.txt").write_text(sh([PY, "-m", "pip", "freeze"]).stdout)

            try:
                if do_npm:
                    sh([NPM, "update", "--no-fund"], APP, check=True)
                    sh([NPM, "audit", "fix", "--no-fund"], APP)  # non-zero when unfixable issues remain
                if do_py:
                    sh([PY, "-m", "pip", "install", "-q", "--upgrade", "pip"], check=True)
                    sh([PY, "-m", "pip", "install", "-q", "--upgrade", "-r", BACKEND / "requirements-dev.txt"],
                       check=True)
                print("\nVerifying…")
                results = verify(do_npm, do_py, args.skip_build)
            except RuntimeError as e:
                results = [("apply updates", False, str(e)[-2500:])]
            ok = all(r[1] for r in results)
            lines += ["## Verification", ""] + [f"- {'✅' if r[1] else '❌'} {r[0]}" for r in results] + [""]
            for name, passed, out in results:
                if not passed:
                    lines += [f"<details><summary>{name} output</summary>", "", "```", out, "```", "</details>", ""]

            if not ok:
                print("\nVerification failed — rolling back…")
                if do_npm:
                    for f in NPM_FILES:
                        shutil.copy2(backup / f, APP / f)
                    sh([NPM, "ci", "--no-audit", "--no-fund"], APP, check=True)
                if do_py:
                    sh([PY, "-m", "pip", "install", "-q", "-r", backup / "freeze.txt"], check=True)
                lines += ["**Rolled back.** The previous lockfile and Python environment were restored.", ""]
            else:
                changed = diff(npm_before, npm_versions()) + diff(py_before, py_versions())
                lines += ["## Updated", ""] + ([f"- {c}" for c in changed] or ["- nothing to update"]) + [""]
    finally:
        shutil.rmtree(backup, ignore_errors=True)

    # Majors and vulnerabilities that remain need a human decision.
    majors = []
    if do_npm:
        for name, o in npm_outdated().items():
            # Only flag upgrades the declared range blocks (wanted < latest).
            if o.get("latest") and o.get("latest") != o.get("wanted"):
                majors.append(f"npm  {name}: {o.get('current')} → {o['latest']} (range allows {o.get('wanted')})")
    if do_py:
        for name, o in py_outdated().items():
            majors.append(f"pip  {name}: {o['version']} → {o['latest_version']} (outside requirements.txt range)")
    lines += ["## Needs review (major / out-of-range upgrades)", ""] + ([f"- {m}" for m in majors] or ["- none"]) + [""]

    vulns = []
    if do_npm:
        prod = npm_audit(prod_only=True)
        everything = npm_audit(prod_only=False)
        vulns += [f"npm (shipped in app): {n} {sev}" for sev, n in prod.items()]
        vulns += [f"npm (dev/build tools only): {n - prod.get(sev, 0)} {sev}"
                  for sev, n in everything.items() if n - prod.get(sev, 0) > 0]
        if everything:
            vulns.append("run `cd app && npm audit` for details; fixes that need a major upgrade are left for review")
    if do_py:
        vulns += [f"pip: {v}" for v in py_audit()]
    lines += ["## Known vulnerabilities remaining", ""] + ([f"- {v}" for v in vulns] or ["- none"]) + [""]

    REPORTS.mkdir(exist_ok=True)
    report = REPORTS / f"{stamp}.md"
    report.write_text("\n".join(lines), encoding="utf-8")
    print("\n" + "\n".join(lines))
    print(f"Report: {report.relative_to(ROOT)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
