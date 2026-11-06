"""Teleprompter: scripts, rehearsal history, a mic-only speech stream, and two LLM helpers.

    GET/POST /scripts, GET/PUT/DELETE /scripts/{id}   script library (plain text with light markup)
    POST /scripts/{id}/runs                           save a read-through report from the prompter
    POST /prompter/bridge                             one spoken line to get from an ad-lib back to the script
    POST /prompter/polish                             rewrite a script for the ear (contractions, beats, cues)
    WS   /ws/prompter?script_id=N                     client → 80 ms interleaved stereo frames (mic on L);
                                                      server → transcript events for "Me" only
The follower that turns transcripts into scrolling runs in the prompter window (app/src/prompter/follower.ts).
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import re
from collections import deque

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import realtime
from asr_service import StreamingTranscriptionService
from database import Script, ScriptRun, SessionLocal, get_db
from lm_studio_client import LMStudioClient

logger = logging.getLogger(__name__)
router = APIRouter()
_llm = LMStudioClient()

MAX_SCRIPT_CHARS = 200_000
MAX_POLISH_CHARS = 20_000
VOCAB_LIMIT = 40


# ---------------------------------------------------------------- script text helpers
def _spoken_lines(content: str) -> list[str]:
    return [ln for ln in (content or "").splitlines()
            if ln.strip() and not re.match(r"^\s*(#{1,3}\s|>)", ln)]


def spoken_words(content: str) -> int:
    """Words read aloud: headings, > notes and [cues] excluded (mirrors the app's parser)."""
    text = re.sub(r"\[[^\]]{1,40}\]", " ", "\n".join(_spoken_lines(content)))
    return sum(1 for w in text.split() if re.search(r"[A-Za-z0-9]", w))


def script_vocabulary(content: str, limit: int = VOCAB_LIMIT) -> list[str]:
    """Names, acronyms and figures from the script, to bias the recogniser toward what I'm about to say."""
    seen: dict[str, None] = {}
    for line in _spoken_lines(content):
        line = re.sub(r"\[[^\]]{1,40}\]", " ", line)
        words = line.split()
        for i, raw in enumerate(words):
            w = raw.strip("*_.,!?;:\"'()[]“”‘’")
            if len(w) < 3 or not re.search(r"[A-Za-z]", w):
                continue
            sentence_start = i == 0 or re.search(r"[.!?:]$", words[i - 1].strip("*_\"'”’)"))
            acronym = sum(c.isupper() for c in w) >= 2 or any(c.isdigit() for c in w)
            if acronym or (w[0].isupper() and not sentence_start):
                seen.setdefault(w, None)
            if len(seen) >= limit:
                return list(seen)
    return list(seen)


# ---------------------------------------------------------------- library
class ScriptIn(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str | None = Field(None, max_length=MAX_SCRIPT_CHARS)
    target_wpm: int | None = Field(None, ge=60, le=260)


def _run_json(r: ScriptRun) -> dict:
    try:
        details = json.loads(r.details) if r.details else {}
    except ValueError:
        details = {}
    return {"id": r.id, "started_at": r.started_at.isoformat() if r.started_at else None,
            "duration_s": r.duration_s, "avg_wpm": r.avg_wpm, "coverage_pct": r.coverage_pct,
            "adlib_s": r.adlib_s, "fillers": r.fillers, "finished": bool(r.finished), "details": details}


def _script_json(s: Script, full: bool = False) -> dict:
    out = {"id": s.id, "title": s.title or "Untitled script", "target_wpm": s.target_wpm or 150,
           "words": spoken_words(s.content or ""),
           "updated_at": s.updated_at.isoformat() if s.updated_at else None,
           "runs_count": len(s.runs),
           "last_run": _run_json(s.runs[-1]) if s.runs else None}
    if full:
        out["content"] = s.content or ""
        out["runs"] = [_run_json(r) for r in reversed(s.runs[-30:])]
    return out


def _get(db: Session, script_id: int) -> Script:
    s = db.query(Script).filter(Script.id == script_id).first()
    if not s:
        raise HTTPException(404, "Script not found")
    return s


@router.get("/scripts")
def list_scripts(db: Session = Depends(get_db)):
    return [_script_json(s) for s in db.query(Script).order_by(Script.updated_at.desc()).all()]


@router.post("/scripts")
def create_script(body: ScriptIn, db: Session = Depends(get_db)):
    s = Script(title=(body.title or "").strip() or "Untitled script", content=body.content or "",
               target_wpm=body.target_wpm or 150)
    db.add(s)
    db.commit()
    db.refresh(s)
    return _script_json(s, full=True)


@router.get("/scripts/{script_id}")
def get_script(script_id: int, db: Session = Depends(get_db)):
    return _script_json(_get(db, script_id), full=True)


@router.put("/scripts/{script_id}")
def update_script(script_id: int, body: ScriptIn, db: Session = Depends(get_db)):
    s = _get(db, script_id)
    if body.title is not None:
        s.title = body.title.strip() or "Untitled script"
    if body.content is not None:
        s.content = body.content
    if body.target_wpm is not None:
        s.target_wpm = body.target_wpm
    s.updated_at = datetime.datetime.utcnow()
    db.commit()
    return _script_json(s, full=True)


@router.delete("/scripts/{script_id}")
def delete_script(script_id: int, db: Session = Depends(get_db)):
    db.delete(_get(db, script_id))
    db.commit()
    return {"status": "deleted"}


class RunIn(BaseModel):
    duration_s: int = Field(0, ge=0, le=86_400)
    avg_wpm: int | None = Field(None, ge=0, le=1000)
    coverage_pct: int = Field(0, ge=0, le=100)
    adlib_s: int = Field(0, ge=0, le=86_400)
    fillers: int = Field(0, ge=0)
    finished: bool = False
    details: dict = Field(default_factory=dict)


@router.post("/scripts/{script_id}/runs")
def save_run(script_id: int, body: RunIn, db: Session = Depends(get_db)):
    s = _get(db, script_id)
    details = json.dumps(body.details)[:100_000]
    run = ScriptRun(script_id=s.id, duration_s=body.duration_s, avg_wpm=body.avg_wpm, coverage_pct=body.coverage_pct,
                    adlib_s=body.adlib_s, fillers=body.fillers, finished=int(body.finished), details=details)
    db.add(run)
    db.commit()
    db.refresh(run)
    return _run_json(run)


# ---------------------------------------------------------------- LLM helpers
BRIDGE_PROMPT = (
    "You help a speaker who wandered off their script get back to it smoothly. Given what they just said "
    "off script and the next line of their script, write ONE short spoken transition (at most 18 words) that "
    "links what they said to that next line, so they can say it and carry straight on reading. First person, "
    "conversational, no new facts or numbers, no quotes, no preamble. Output only the sentence.")

POLISH_PROMPT = (
    "You are a speechwriter. Rewrite the script below so it sounds natural when read aloud from a teleprompter "
    "by the person who wrote it.\n"
    "- Keep the meaning, every fact, figure and name. Do not add new claims.\n"
    "- Short sentences, plain words, contractions, active voice; one idea per sentence.\n"
    "- Keep the speaker's voice and any lines that start with '#' (section titles) or '>' (private notes).\n"
    "- Add delivery cues sparingly in square brackets, only from: [pause] [slow] [look up] [smile] [breathe] "
    "[next slide]. Keep any cues already there.\n"
    "- Mark at most one or two key words per paragraph for stress with *asterisks*.\n"
    "- Separate paragraphs with a blank line.\n"
    "Output only the rewritten script, nothing else.")


class BridgeIn(BaseModel):
    said: str = Field(..., max_length=2000)
    next: str = Field(..., max_length=1000)
    title: str = Field("", max_length=200)


def clean_line(raw: str, max_words: int = 30) -> str:
    line = next((ln.strip() for ln in (raw or "").splitlines() if ln.strip()), "")
    line = re.sub(r"^(transition|bridge|line)\s*:\s*", "", line, flags=re.I).strip().strip('"“”\'‘’*').strip()
    words = line.split()
    return " ".join(words[:max_words])


@router.post("/prompter/bridge")
async def bridge(body: BridgeIn):
    if not body.next.strip():
        return {"line": None, "error": "Nothing left in the script to bridge to."}
    user = (f"TOPIC: {body.title.strip() or 'a talk'}\nWHAT I JUST SAID (off script): {body.said.strip()}\n"
            f"NEXT LINE OF MY SCRIPT: {body.next.strip()}")
    try:
        raw = await asyncio.wait_for(_llm.complete(BRIDGE_PROMPT, user, max_tokens=60, temperature=0.5), 25)
    except asyncio.TimeoutError:
        return {"line": None, "error": "The local LLM took too long."}
    line = clean_line(raw)
    return {"line": line or None, "error": None if line else (_llm.last_error or "The local LLM returned nothing.")}


class PolishIn(BaseModel):
    content: str = Field(..., max_length=MAX_POLISH_CHARS)


def clean_polish(raw: str) -> str:
    text = re.sub(r"^(here(’|')?s|here is)[^\n]*:\s*\n", "", (raw or "").strip(), flags=re.I).strip()
    return re.sub(r"^```[a-z]*\n?|\n?```$", "", text).strip()


@router.post("/prompter/polish")
async def polish(body: PolishIn):
    if not body.content.strip():
        return {"content": None, "error": "The script is empty."}
    if realtime.runtime.sessions:
        return {"content": None, "error": "A meeting is in progress. Polish the script after it ends so live coaching stays fast."}
    budget = min(6000, int(len(body.content) / 2.5) + 400)
    raw = await _llm.complete(POLISH_PROMPT, body.content, max_tokens=budget, temperature=0.4)
    text = clean_polish(raw)
    if not text:
        return {"content": None, "error": _llm.last_error or "The local LLM returned nothing. Make sure LM Studio or Ollama is running."}
    return {"content": text, "error": None}


# ---------------------------------------------------------------- mic-only speech stream
def _load_vocab(script_id: int | None, extra: list[str]) -> list[str]:
    words = list(extra)
    if script_id is not None:
        db = SessionLocal()
        try:
            s = db.query(Script).filter(Script.id == script_id).first()
            if s:
                words += script_vocabulary(s.content or "")
        finally:
            db.close()
    return list(dict.fromkeys(words))[:80]


@router.websocket("/ws/prompter")
async def prompter_ws(ws: WebSocket, script_id: int | None = None):
    """Transcribes only my mic (left channel) for the teleprompter; nothing is stored."""
    await ws.accept()
    await realtime.runtime.start()
    cfg = await asyncio.to_thread(realtime.RealtimeConfig.load)
    vocab = await asyncio.to_thread(_load_vocab, script_id, cfg.vocabulary)
    me = realtime.runtime.plan(cfg).channels["Me"]
    send_lock = asyncio.Lock()

    async def sink(ev) -> None:
        async with send_lock:
            try:
                await ws.send_json(ev.to_json())
            except Exception:  # noqa: BLE001 — socket closing
                pass

    def load() -> StreamingTranscriptionService:
        assert realtime.runtime.paths is not None
        return StreamingTranscriptionService(*realtime.runtime.paths, sink=sink, speakers=("Me",),
                                             vocabulary=vocab or None, channels={"Me": (me.device, me.profile)})

    await ws.send_json({"type": "prompter_status", "state": "loading"})
    loading = asyncio.ensure_future(asyncio.to_thread(load))
    backlog: deque[bytes] = deque(maxlen=realtime.BACKLOG_FRAMES)
    asr: StreamingTranscriptionService | None = None
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if asr is None and loading.done():
                asr = loading.result()
                await ws.send_json({"type": "prompter_status", "state": "ready"})
                while backlog:
                    asr.push_interleaved(backlog.popleft())
            if msg.get("bytes"):
                if asr is None:
                    backlog.append(msg["bytes"])
                else:
                    asr.push_interleaved(msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        if asr is None:
            try:
                asr = await loading
            except Exception:  # noqa: BLE001
                logger.exception("prompter: ASR failed to start")
                return
        await asr.close()
        logger.info("prompter speech stream closed")
