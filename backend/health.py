"""System health: is everything the coach depends on working, and fast enough? Plus the first-run checklist.

GET /health/diagnostics is cheap (one short LLM probe, cached sysctl reads) so the UI can poll it.
"""
from __future__ import annotations

import time

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

import calendar_feed
import llm_provider
import perf
import realtime
from database import AppConfig, VoiceProfile, get_db

router = APIRouter()

LIVE_TIMEOUT_S = 20.0          # OpenAICompatClient default: slower live cards are dropped
SLOW_TASK_S = 45.0
SWAP_WARN_GB = 4.0
_STARTED = time.time()


async def _probe_llm(url: str, allow_remote: bool) -> dict:
    out = {"url": url, "reachable": False, "message": "", "probe_ms": None}
    try:
        url = llm_provider.check_url(url, allow_remote)
    except llm_provider.LlmError as err:
        out["message"] = str(err)
        return out
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(**llm_provider.client_kwargs()) as client:
            res = await client.get(f"{url}/models", timeout=2.5)
        out["reachable"] = res.status_code < 500
        out["probe_ms"] = round((time.monotonic() - t0) * 1000)
        if res.status_code >= 400:
            out["message"] = f"HTTP {res.status_code}"
    except httpx.HTTPError as err:
        out["message"] = llm_provider.describe_exception(err, url)
    return out


def assess(llm: dict, coach: dict, task: dict, memory: dict, asr_lag_ms: float | None) -> tuple[str, list[dict]]:
    """Overall status ("good" | "warning" | "problem") and plain-language findings with a fix for each."""
    issues: list[dict] = []
    if not llm["reachable"]:
        issues.append({"level": "problem", "title": "The local LLM isn't reachable",
                       "detail": llm["message"] or "No reply from the LLM server.",
                       "fix": "Start LM Studio or Ollama and load a model, or check the URL in Settings → LLM."})
    p90 = coach.get("p90_s")
    if coach["calls"] >= 3 and coach["failures"] / coach["calls"] >= 0.3:
        issues.append({"level": "problem", "title": f"{coach['failures']} of the last {coach['calls']} live coaching calls failed",
                       "detail": "Live cards are dropped when the model doesn't answer within "
                                 f"{LIVE_TIMEOUT_S:.0f} s, so you'll see few or no prompts.",
                       "fix": "Use a smaller or faster model, close memory-heavy apps, or turn thinking off in Settings → LLM."})
    elif p90 and p90 > LIVE_TIMEOUT_S * 0.6:
        issues.append({"level": "warning", "title": f"Live coaching is slow ({p90:.0f} s for most calls)",
                       "detail": f"Cards that take longer than {LIVE_TIMEOUT_S:.0f} s are dropped.",
                       "fix": "A smaller model (e.g. a 4B instruct model) or freeing memory will bring this down."})
    if task.get("p50_s") and task["p50_s"] > SLOW_TASK_S:
        issues.append({"level": "warning", "title": f"Summaries and briefs are slow ({task['p50_s']:.0f} s typical)",
                       "detail": "Usually memory pressure or a model that's too large for this Mac.",
                       "fix": "Free memory, or use an external model for post-meeting work (Settings → External LLM)."})
    if memory.get("pressure") == "critical" or (memory.get("swap_used_gb") or 0) >= SWAP_WARN_GB * 2:
        issues.append({"level": "problem", "title": "This Mac is very low on memory",
                       "detail": f"Memory pressure {memory.get('pressure') or 'high'}, {memory.get('swap_used_gb') or 0:.0f} GB swap in use. "
                                 "The LLM and speech recognition slow down sharply.",
                       "fix": "Quit unused apps and browser tabs, or unload other models in LM Studio."})
    elif memory.get("pressure") == "warning" or (memory.get("swap_used_gb") or 0) >= SWAP_WARN_GB:
        issues.append({"level": "warning", "title": "Memory is getting tight",
                       "detail": f"{memory.get('swap_used_gb') or 0:.0f} GB swap in use.",
                       "fix": "Close apps you don't need before an important meeting."})
    if asr_lag_ms and asr_lag_ms > 2500:
        issues.append({"level": "warning", "title": f"Speech recognition is lagging ({asr_lag_ms / 1000:.1f} s)",
                       "detail": "The app lowers ASR quality automatically to keep up.",
                       "fix": "Free memory or CPU; plug in if you're on battery."})
    status = "problem" if any(i["level"] == "problem" for i in issues) else "warning" if issues else "good"
    return status, issues


@router.get("/health/diagnostics")
async def diagnostics(db: Session = Depends(get_db)):
    cfg = {c.key: c.value for c in db.query(AppConfig).all()}
    llm = await _probe_llm((cfg.get("llm_api_url") or "").strip().rstrip("/"), llm_provider.parse_bool(cfg.get("llm_allow_remote")))
    llm.update(model=cfg.get("llm_model") or "auto", thinking=llm_provider.parse_bool(cfg.get("llm_thinking")),
               external=llm_provider.parse_bool(cfg.get("external_llm_enabled")),
               external_model=cfg.get("external_llm_model") or None)
    coach, task, memory = perf.llm_summary("coach"), perf.llm_summary("task"), perf.memory()

    rt = realtime.runtime
    live = []
    for s in list(rt.sessions):
        lags = [c.get("lag_p50_ms") for c in s.controller.status()["channels"].values() if c.get("lag_p50_ms") is not None]
        live.append({"meeting_id": s.meeting_id, "asr_lag_ms": max(lags) if lags else None,
                     "coach": s.coach.stats_line() if hasattr(s.coach, "stats_line") else None})
    asr_lag = max((m["asr_lag_ms"] for m in live if m["asr_lag_ms"] is not None), default=None)
    status, issues = assess(llm, coach, task, memory, asr_lag)

    try:
        encryption = f"SQLCipher {db.execute(text('PRAGMA cipher_version')).scalar()}"
    except Exception:  # noqa: BLE001
        encryption = None
    return {
        "status": status, "issues": issues, "uptime_s": round(time.time() - _STARTED),
        "llm": llm, "llm_calls": {"coach": coach, "task": task, "live_timeout_s": LIVE_TIMEOUT_S},
        "memory": memory,
        "asr": {"ready": rt.hw is not None if hasattr(rt, "hw") else None, "calibrated": getattr(rt, "cal", None) is not None,
                "calibrating": bool(getattr(rt, "calibrating", False)), "live": live},
        "security": {"encryption": encryption},
        "setup": setup_checklist(cfg, llm, db),
    }


def setup_checklist(cfg: dict, llm: dict, db: Session) -> list[dict]:
    """Server-side steps of first-run setup; the app adds audio devices (stored in the browser profile)."""
    return [
        {"id": "name", "label": "Tell the coach your name", "done": bool((cfg.get("leader_name") or "").strip()),
         "hint": "So commitments assigned to you are recognised."},
        {"id": "llm", "label": "Connect an LLM", "done": bool(llm["reachable"]),
         "hint": "LM Studio or Ollama on this Mac, or an OpenAI-compatible API."},
        {"id": "voice", "label": "Record your voice profile", "done": db.query(VoiceProfile).count() > 0,
         "hint": "About 30 seconds of speech; tells your voice from others in the room."},
        {"id": "calendar", "label": "Connect your calendar", "done": calendar_feed.connected(),
         "hint": "Optional. Shows today's meetings and pre-fills title and attendees."},
    ]
