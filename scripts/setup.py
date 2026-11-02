#!/usr/bin/env python3
"""One-shot setup for a fresh clone (macOS, Linux, Windows).

    python3 scripts/setup.py              # backend venv + npm packages
    python3 scripts/setup.py --models     # also pre-download the ASR models (~700 MB)
    python3 scripts/setup.py --import-models PATH   # copy existing GGUF files instead (e.g. Handy's models folder)
    python3 scripts/setup.py --recreate   # rebuild backend/venv from scratch

Everything is fetched from public registries (PyPI, npm, Hugging Face); nothing is vendored.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND, APP = ROOT / "backend", ROOT / "app"
VENV = BACKEND / "venv"
MIN_PY, MAX_TESTED_PY, MIN_NODE = (3, 10), (3, 13), (22, 18)


def node_env() -> dict[str, str]:
    """Trust the OS certificate store (corporate TLS-inspection proxies) — Node 22.15+."""
    env = dict(os.environ)
    if "--use-system-ca" not in env.get("NODE_OPTIONS", ""):
        env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + " --use-system-ca").strip()
    return env


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(cmd: list, cwd: Path | None = None) -> None:
    print(f"\n$ {' '.join(map(str, cmd))}", flush=True)
    subprocess.run([str(c) for c in cmd], cwd=cwd, check=True, env=node_env())


def fail(msg: str) -> None:
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)


def check_python() -> None:
    v = sys.version_info[:2]
    if v < MIN_PY:
        fail(f"Python {'.'.join(map(str, MIN_PY))}+ required (found {sys.version.split()[0]}).")
    if v > MAX_TESTED_PY:
        print(f"! Python {v[0]}.{v[1]} is newer than tested ({MAX_TESTED_PY[0]}.{MAX_TESTED_PY[1]}); "
              "if transcribe-cpp has no wheel yet, re-run with python3.13.")


def check_node() -> str:
    npm = shutil.which("npm")
    node = shutil.which("node")
    if not (npm and node):
        fail("Node.js (with npm) not found. Install Node 22.18+ from https://nodejs.org or via nvm (see app/.nvmrc).")
    out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip().lstrip("v")
    if tuple(int(x) for x in out.split(".")[:2]) < MIN_NODE:
        fail(f"Node {MIN_NODE[0]}.{MIN_NODE[1]}+ required (found {out}).")
    return npm


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", action="store_true", help="pre-download Parakeet + Silero VAD GGUF models")
    ap.add_argument("--import-models", metavar="PATH", nargs="+",
                    help="copy already-downloaded GGUF model files/folders instead of downloading")
    ap.add_argument("--recreate", action="store_true", help="delete and rebuild backend/venv")
    ap.add_argument("--dev", action="store_true", help="also install dev tools (pip-audit)")
    args = ap.parse_args()

    check_python()
    npm = check_node()

    if args.recreate and VENV.exists():
        shutil.rmtree(VENV)
    if not venv_python().exists():
        run([sys.executable, "-m", "venv", VENV])
    py = venv_python()
    run([py, "-m", "pip", "install", "--upgrade", "pip"])
    run([py, "-m", "pip", "install", "-r", BACKEND / ("requirements-dev.txt" if args.dev else "requirements.txt")])

    run([npm, "ci" if (APP / "package-lock.json").exists() else "install", "--no-audit", "--no-fund"], cwd=APP)

    if args.import_models:
        run([sys.executable, ROOT / "scripts" / "import_models.py", *args.import_models])
    if args.models:
        run([py, "-c", "from asr_service import resolve_model_paths; print(*resolve_model_paths(), sep='\\n')"],
            cwd=BACKEND)

    print("\n✓ Setup complete.\n\n  cd app && npm run dev\n\n"
          "First launch calibrates the ASR for this machine (~25 s, once) and downloads the models\n"
          "if you skipped --models. See README.md for audio routing and LLM setup.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        fail(f"Command failed with exit code {e.returncode}: {' '.join(map(str, e.cmd))}")
