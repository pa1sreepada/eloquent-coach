#!/usr/bin/env python3
"""Copy already-downloaded ASR model files into the app's models folder.

Use this when the Hugging Face download fails (403, proxy, offline). Pass GGUF files
or folders to search, e.g. Handy's models folder:

    python3 scripts/import_models.py ~/Library/Application\\ Support/com.pais.handy/models
    python3 scripts/import_models.py /path/to/parakeet-unified-en-0.6b-Q8_0.gguf

Files are matched by name (exact, or a close variant such as different casing), checked for
the GGUF header and copied to backend/models/ (override with ELOQUENT_MODELS_DIR).
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from model_files import ASR_FILE, MODELS_DIR, VAD_FILE  # noqa: E402

# target name -> lowercase substrings a differently named copy must contain
WANTED = {ASR_FILE: ("parakeet", "unified", "0.6b", "q8_0"), VAD_FILE: ("silero", "vad", "f32")}


def is_gguf(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            return f.read(4) == b"GGUF"
    except OSError:
        return False


def candidates(sources: list[Path]) -> list[Path]:
    out = []
    for src in sources:
        src = src.expanduser()
        if src.is_file():
            out.append(src)
        elif src.is_dir():
            out.extend(p for p in src.rglob("*") if p.is_file() and p.suffix.lower() == ".gguf")
        else:
            print(f"! not found: {src}")
    return out


def match(target: str, files: list[Path]) -> Path | None:
    exact = [p for p in files if p.name == target]
    loose = [p for p in files if p.name.lower() == target.lower()
             or all(k in p.name.lower() for k in WANTED[target])]
    for p in exact + loose:
        if is_gguf(p):
            return p
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="+", type=Path, help="GGUF files or folders to search")
    ap.add_argument("--force", action="store_true", help="overwrite files already in the models folder")
    args = ap.parse_args()

    files = candidates(args.sources)
    dest_dir = Path(MODELS_DIR)
    dest_dir.mkdir(parents=True, exist_ok=True)
    missing = []
    for target in WANTED:
        src, dest = match(target, files), dest_dir / target
        if src is None:
            missing.append(target)
            continue
        if dest.exists() and not args.force and dest.stat().st_size == src.stat().st_size:
            print(f"✓ {target} already present")
            continue
        tmp = dest.with_suffix(".part")
        print(f"→ copying {src} ({src.stat().st_size / 1e6:.0f} MB)")
        shutil.copyfile(src, tmp)
        os.replace(tmp, dest)
        print(f"✓ {dest}")

    if missing:
        print("\nNot found in the given sources (will still be downloaded from Hugging Face if possible):")
        for m in missing:
            print(f"  - {m}")
    print("\nRestart the backend to pick up imported models.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
