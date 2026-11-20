"""In-memory performance telemetry for the health panel: recent LLM call timings and system memory.

Nothing here is persisted or contains meeting content: only durations, success flags and timestamps.
"""
from __future__ import annotations

import asyncio
import collections
import os
import re
import subprocess
import sys
import threading
import time

KINDS = ("coach", "task")    # coach = live coaching cards; task = summaries, briefs, rehearsal, rephrase…
_calls: dict[str, collections.deque] = {k: collections.deque(maxlen=40) for k in KINDS}
_lock = threading.Lock()


def record_llm(kind: str, seconds: float, ok: bool) -> None:
    with _lock:
        _calls.setdefault(kind, collections.deque(maxlen=40)).append((time.time(), round(seconds, 2), ok))


def reset() -> None:
    with _lock:
        for d in _calls.values():
            d.clear()


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def llm_summary(kind: str) -> dict:
    with _lock:
        calls = list(_calls.get(kind, ()))
    ok = [s for _, s, good in calls if good]
    return {"calls": len(calls), "failures": sum(1 for *_, good in calls if not good),
            "p50_s": _pct(ok, 0.5), "p90_s": _pct(ok, 0.9), "last_s": calls[-1][1] if calls else None,
            "last_at": calls[-1][0] if calls else None}


class Timer:
    """`async with perf.Timer("task") as t: ...; t.ok = bool(result)` records one call.
    Cancelled calls (preempted cards) aren't recorded; exceptions count as failures."""

    def __init__(self, kind: str):
        self.kind, self.ok = kind, True

    async def __aenter__(self):
        self.t0 = time.monotonic()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if exc_type is not None and issubclass(exc_type, asyncio.CancelledError):
            return False
        record_llm(self.kind, time.monotonic() - self.t0, self.ok and exc_type is None)
        return False


# ---------------------------------------------------------------- memory
_mem_cache: tuple[float, dict] | None = None


def _sysctl(name: str) -> str:
    try:
        return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def parse_swapusage(s: str) -> float | None:
    """`total = 2048.00M  used = 1234.50M  free = …` → used GB."""
    m = re.search(r"used\s*=\s*([\d.]+)([KMG])", s or "")
    if not m:
        return None
    mb = float(m[1]) * {"K": 1 / 1024, "M": 1, "G": 1024}[m[2]]
    return round(mb / 1024, 1)


def memory() -> dict:
    """{total_gb, swap_used_gb, pressure: normal|warning|critical|None}; cached for 10 s."""
    global _mem_cache
    if _mem_cache and time.time() - _mem_cache[0] < 10:
        return _mem_cache[1]
    out: dict = {"total_gb": None, "swap_used_gb": None, "pressure": None}
    try:
        if sys.platform == "darwin":
            total = _sysctl("hw.memsize")
            out["total_gb"] = round(int(total) / 2**30) if total.isdigit() else None
            out["swap_used_gb"] = parse_swapusage(_sysctl("vm.swapusage"))
            out["pressure"] = {"1": "normal", "2": "warning", "4": "critical"}.get(_sysctl("kern.memorystatus_vm_pressure_level"))
        elif os.path.exists("/proc/meminfo"):
            info = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    k, _, v = line.partition(":")
                    info[k] = int(v.split()[0]) if v.split() else 0
            out["total_gb"] = round(info.get("MemTotal", 0) / 2**20)
            out["swap_used_gb"] = round((info.get("SwapTotal", 0) - info.get("SwapFree", 0)) / 2**20, 1)
            avail = info.get("MemAvailable", 0) / max(1, info.get("MemTotal", 1))
            out["pressure"] = "critical" if avail < 0.05 else "warning" if avail < 0.15 else "normal"
    except (OSError, ValueError):
        pass
    _mem_cache = (time.time(), out)
    return out
