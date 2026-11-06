import os
import re
import logging
import asyncio
import datetime

import httpx
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text, func
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import init_db, get_db, engine, Meeting, AppConfig, SessionLocal, Transcript, Insight, Metrics
from lm_studio_client import LMStudioClient
from coach_engine import OpenAICompatClient
import llm_provider
from metrics_engine import MetricsEngine
from post_meeting_synthesis import PostMeetingSynthesis, format_summary
from report_generator import ReportGenerator
import realtime
import prompter

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Second Chair API")

# Renderer is served from the Vite dev server or file:// (origin "null") in packaged builds.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(http://(localhost|127\.0\.0\.1)(:\d+)?|null|file://.*)$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(realtime.router)
app.include_router(prompter.router)

lm_client: LMStudioClient | None = None
metrics_engine: MetricsEngine | None = None

LEGACY_KEYS = ("whisper_model", "whisper_compute_type", "insight_interval", "system_prompt")


def init_default_settings(db: Session):
    defaults = {
        "llm_api_url": "http://127.0.0.1:1234/v1",
        "llm_model": "",
        "llm_thinking": "false",
        "llm_streaming": "true",
        "coach_instructions": "",
        "asr_profile": "auto",
        "asr_backend": "auto",
        "asr_adaptive": "true",
        "filler_words": "um,uh,ah,like,so,actually,basically,literally,you know",
        "custom_jargon": "OKRs,ARR,LTV,CAC,Kubernetes,SaaS,Q1,Q2,Q3,Q4,C-suite",
    }
    for k, v in defaults.items():
        if not db.query(AppConfig).filter(AppConfig.key == k).first():
            db.add(AppConfig(key=k, value=v))
    db.query(AppConfig).filter(AppConfig.key.in_(LEGACY_KEYS)).delete(synchronize_session=False)
    db.commit()


@app.on_event("startup")
async def on_startup():
    global lm_client, metrics_engine
    init_db()
    db = SessionLocal()
    try:
        init_default_settings(db)
        config = {c.key: c.value for c in db.query(AppConfig).all()}
    finally:
        db.close()
    lm_client = LMStudioClient(base_url=config.get("llm_api_url", "http://127.0.0.1:1234/v1"))
    metrics_engine = MetricsEngine()
    try:
        await realtime.warmup()
    except Exception as e:  # noqa: BLE001 - keep the API up; ASR start is retried when a meeting begins
        logger.error("ASR warmup failed (dashboard, reports and settings still work): %s", e)


class SettingsUpdate(BaseModel):
    llm_api_url: str
    llm_model: str = ""
    llm_thinking: str = "false"
    llm_streaming: str = "true"
    coach_instructions: str = ""
    asr_profile: str = "auto"
    asr_backend: str = "auto"
    asr_adaptive: str = "true"
    filler_words: str
    custom_jargon: str


@app.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    config = {c.key: c.value for c in db.query(AppConfig).all()}
    return config

@app.put("/settings")
def update_settings(settings: SettingsUpdate, db: Session = Depends(get_db)):
    updates = settings.model_dump()
    updates["asr_backend"] = realtime.normalize_backend(updates["asr_backend"])
    for k, v in updates.items():
        conf = db.query(AppConfig).filter(AppConfig.key == k).first()
        if conf:
            conf.value = v
        else:
            db.add(AppConfig(key=k, value=v))
    db.commit()
    lm_client.base_url = settings.llm_api_url
    # ASR/coach settings are read per meeting by realtime.MeetingSession.
    return {"status": "success", "message": "Settings updated"}

@app.get("/llm/status")
async def llm_status(url: str | None = None, model: str | None = None, test: bool = False,
                     thinking: bool | None = None, db: Session = Depends(get_db)):
    """Which server is at the URL (Ollama / LM Studio / generic), its models, and optionally a real test call.
    Defaults to the saved settings; pass url/model to check values before saving."""
    config = {c.key: c.value for c in db.query(AppConfig).filter(AppConfig.key.in_(("llm_api_url", "llm_model", "llm_thinking")))}
    if thinking is None:
        thinking = llm_provider.parse_bool(config.get("llm_thinking"))
    url = (url if url is not None else config.get("llm_api_url") or "").strip().rstrip("/")
    model = (model if model is not None else config.get("llm_model") or "").strip()
    if not re.match(r"^https?://", url):
        raise HTTPException(400, "API Base URL must start with http:// or https://")
    out = {"url": url, "reachable": False, "provider": None, "provider_name": None, "models": [],
           "model": model or None, "model_source": "configured" if model else "auto", "ok": False, "message": ""}
    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{url}/models", timeout=llm_provider.PROBE_TIMEOUT_S)
        except httpx.HTTPError as err:
            out["message"] = llm_provider.describe_exception(err, url)
            return out
        provider = await llm_provider.detect_provider(client, url)
        models = await llm_provider.list_models(client, url, provider)
    out.update(reachable=True, provider=provider, provider_name=llm_provider.provider_name(provider),
               models=[m.to_json() for m in models])
    if not model:
        out["model"] = llm_provider.pick_model(models)
    if not out["model"] and provider != llm_provider.GENERIC:
        out["message"] = f"{out['provider_name']} is running but has no chat models installed."
        return out
    if model and models and model not in {m.id for m in models}:
        out["message"] = f"Model '{model}' isn't available on {out['provider_name']}."
        return out
    if not test:
        out["ok"] = True
        return out
    probe = OpenAICompatClient(url, model=out["model"], thinking=thinking)
    probe.provider = provider
    try:
        await probe.warmup()
        out.update(ok=True, message=f"{out['model']} answered on {out['provider_name']}.")
    except Exception as err:  # noqa: BLE001
        out["message"] = llm_provider.describe_exception(err, url, provider)
    finally:
        await probe.aclose()
    return out


@app.get("/")
def read_root():
    return {"status": "ok", "message": "Second Chair API is running"}

@app.post("/meetings/")
def start_meeting(mode: str = "General", agenda: str = "", prep_notes: str = "", db: Session = Depends(get_db)):
    now = datetime.datetime.utcnow()
    timestamp_str = now.strftime("%Y-%m-%d %H:%M")

    # Text-only persistence: transcript, cards, metrics and summary live in the DB.
    # No audio and no per-meeting .txt files are written.
    new_meeting = Meeting(title=f"Meeting - {timestamp_str}", start_time=now, mode=mode, agenda=agenda, prep_notes=prep_notes)
    db.add(new_meeting)
    db.commit()
    db.refresh(new_meeting)

    return {"meeting_id": new_meeting.id, "status": "started"}

@app.post("/meetings/{meeting_id}/end")
async def end_meeting(meeting_id: int, db: Session = Depends(get_db)):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if meeting:
        meeting.end_time = datetime.datetime.utcnow()
        db.commit()
        
        # Calculate final meeting metrics
        try:
            metrics_engine.update_metrics(meeting_id)
        except Exception as err:
            logger.warning(f"Error calculating final metrics on meeting end: {err}")
            
        # The executive summary is generated on demand from Reports, so the LLM stays free for the next meeting.
        return {"status": "ended", "meeting_id": meeting_id}
    return {"error": "Meeting not found"}

@app.get("/dashboard/stats")
def get_dashboard_stats(db: Session = Depends(get_db)):
    """Real aggregates only (no placeholder numbers); each value is None until there is data."""
    meetings = db.query(Meeting).filter(Meeting.end_time.isnot(None)).all()
    week_ago = datetime.datetime.utcnow() - datetime.timedelta(days=7)
    minutes = sum((m.end_time - m.start_time).total_seconds() / 60 for m in meetings if m.start_time)
    rows = [m.metrics[-1] for m in meetings if m.metrics]

    def avg(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    return {
        "sessions": len(meetings),
        "sessions_this_week": sum(1 for m in meetings if m.start_time and m.start_time >= week_ago),
        "hours": round(minutes / 60, 1),
        "avg_score": avg([m.lps_score for m in meetings]),
        "talk_share_pct": avg([100 * r.talk_time / (r.talk_time + r.listen_time)
                               for r in rows if (r.talk_time or 0) + (r.listen_time or 0) > 0]),
        "question_pct": avg([100 * r.question_ratio for r in rows if r.question_ratio is not None]),
        "fillers_per_session": avg([r.filler_count for r in rows]),
    }

@app.get("/meetings")
def get_meetings(db: Session = Depends(get_db)):
    meetings = db.query(Meeting).order_by(Meeting.start_time.desc()).all()
    # Compute simple average score for frontend
    results = []
    for m in meetings:
        metrics = m.metrics
        avg_score = 0
        if metrics:
            # mock score based on talk time and pacing, just for display
            avg_score = 8.5
        
        results.append({
            "id": m.id,
            "title": m.title,
            "start_time": m.start_time.isoformat() if m.start_time else None,
            "end_time": m.end_time.isoformat() if m.end_time else None,
            "summary": m.summary,
            "mode": m.mode,
            "score": avg_score
        })
    return results

@app.get("/meetings/{meeting_id}")
def get_meeting_details(meeting_id: int, db: Session = Depends(get_db)):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return {"error": "Meeting not found"}
        
    transcripts = [_transcript_json(t) for t in sorted(
        meeting.transcripts, key=lambda t: (t.timestamp or datetime.datetime.min, t.id))]
    metrics = [{
        "talk_time": m.talk_time, 
        "pacing": m.pacing, 
        "interruptions": m.interruptions,
        "confidence_score": m.confidence_score,
        "wait_time_avg": m.wait_time_avg,
        "question_ratio": m.question_ratio,
        "we_i_ratio": m.we_i_ratio,
        "future_focus_pct": m.future_focus_pct
    } for m in meeting.metrics]
    
    return {
        "id": meeting.id,
        "title": meeting.title,
        "mode": meeting.mode,
        "agenda": meeting.agenda,
        "prep_notes": meeting.prep_notes,
        "start_time": meeting.start_time.isoformat() if meeting.start_time else None,
        "end_time": meeting.end_time.isoformat() if meeting.end_time else None,
        "summary": format_summary(meeting.summary) if meeting.summary else meeting.summary,
        "transcript_filepath": meeting.transcript_filepath,
        "lps_score": meeting.lps_score,
        "strategic_alternatives": meeting.strategic_alternatives,
        "notes": meeting.notes,
        "followup_email": meeting.followup_email,
        "transcripts": transcripts,
        "insights": _insights(meeting),
        "metrics": metrics
    }


def _insights(meeting: Meeting) -> list[dict]:
    """Live coaching cards shown during the meeting, oldest first."""
    rows = sorted(meeting.insights, key=lambda i: i.timestamp or datetime.datetime.min)
    return [{"id": i.id, "kind": i.insight_type, "headline": i.text, "body": i.strategic_rationale,
             "timestamp": i.timestamp.isoformat() if i.timestamp else None} for i in rows]

@app.get("/meetings/{meeting_id}/export")
def export_meeting_summary(meeting_id: int, db: Session = Depends(get_db)):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return {"error": "Meeting not found"}
        
    export_content = f"# Executive Briefing: {meeting.title}\n"
    export_content += f"**Date**: {meeting.start_time.strftime('%Y-%m-%d %H:%M') if meeting.start_time else 'N/A'}\n"
    export_content += f"**Persona Mode**: {meeting.mode}\n"
    if meeting.agenda:
        export_content += f"**Agenda & Objectives**: {meeting.agenda}\n"
    if meeting.lps_score:
        export_content += f"**Leadership Proficiency Score**: {meeting.lps_score}/10\n"
    export_content += "\n---\n\n"
    
    export_content += "## Executive Briefing & Synthesis\n"
    export_content += f"{format_summary(meeting.summary) if meeting.summary else 'No summary generated.'}\n\n"
    
    if meeting.strategic_alternatives:
        export_content += "## Strategic Executive Rerouting & Pivots\n"
        export_content += f"{meeting.strategic_alternatives}\n\n"
        
    if (meeting.notes or "").strip():
        export_content += "## My Notes\n" + meeting.notes.strip() + "\n\n"

    if meeting.followup_email:
        export_content += "## Follow-up Email\n```\n" + meeting.followup_email + "\n```\n\n"

    cards = _insights(meeting)
    if cards:
        export_content += "## Live Coaching (questions & pivots suggested during the meeting)\n"
        for c in cards:
            time_str = c["timestamp"][11:19] if c["timestamp"] else ""
            body = f" — {c['body']}" if c["body"] else ""
            export_content += f"- [{time_str}] **{(c['kind'] or '').upper()}**: {c['headline']}{body}\n"
        export_content += "\n"

    export_content += "## Transcript\n"
    for t in meeting.transcripts:
        time_str = t.timestamp.strftime("%H:%M:%S") if t.timestamp else ""
        export_content += f"[{time_str}] **{t.speaker}**: {t.text}\n"
        
    return {"meeting_id": meeting_id, "title": meeting.title, "export_markdown": export_content}

TRANSCRIPTS_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcripts"))


@app.delete("/meetings/{meeting_id}")
def delete_meeting(meeting_id: int, db: Session = Depends(get_db)):
    """Permanently delete a meeting: transcript, coaching cards, metrics, summary and any legacy transcript file."""
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        raise HTTPException(404, "Meeting not found")
    if any(s.meeting_id == meeting_id for s in realtime.runtime.sessions):
        raise HTTPException(409, "This meeting is still live. End it before deleting.")
    path = meeting.transcript_filepath
    for model in (Transcript, Insight, Metrics):
        db.query(model).filter(model.meeting_id == meeting_id).delete(synchronize_session=False)
    db.delete(meeting)
    db.commit()
    db.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))   # don't leave deleted pages in the WAL file
    # Only remove files inside the app's transcripts folder.
    if path and os.path.realpath(path).startswith(TRANSCRIPTS_DIR + os.sep) and os.path.isfile(path):
        os.remove(path)
    return {"status": "deleted", "meeting_id": meeting_id}


MAX_TITLE_CHARS = 120
MAX_MODE_CHARS = 80


class MeetingUpdate(BaseModel):
    title: str | None = None
    mode: str | None = None   # meeting type; decides the summary sections next time it's generated


def _title_filename(title: str) -> str:
    """Filesystem-safe version of a meeting title (macOS/Windows reserved characters removed)."""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", title)
    return re.sub(r"\s+", " ", name).strip(" .") or "Meeting"


@app.patch("/meetings/{meeting_id}")
def update_meeting(meeting_id: int, body: MeetingUpdate, db: Session = Depends(get_db)):
    """Rename a meeting and/or change its type. Everything else links by id; a legacy transcript file is
    renamed to match the title."""
    if body.title is None and body.mode is None:
        raise HTTPException(400, "Nothing to update.")
    title = mode = None
    if body.title is not None:
        title = re.sub(r"\s+", " ", body.title).strip()
        if not title:
            raise HTTPException(400, "Title can't be empty.")
        if len(title) > MAX_TITLE_CHARS:
            raise HTTPException(400, f"Title must be {MAX_TITLE_CHARS} characters or fewer.")
    if body.mode is not None:
        mode = re.sub(r"\s+", " ", body.mode).strip()
        if not mode or len(mode) > MAX_MODE_CHARS:
            raise HTTPException(400, f"Meeting type must be 1-{MAX_MODE_CHARS} characters.")
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        raise HTTPException(404, "Meeting not found")
    if mode is not None:
        meeting.mode = mode
    if title is None:
        db.commit()
        return {"status": "updated", "meeting_id": meeting_id, "title": meeting.title, "mode": meeting.mode}

    path = meeting.transcript_filepath
    if path and os.path.realpath(path).startswith(TRANSCRIPTS_DIR + os.sep) and os.path.isfile(path):
        ext = os.path.splitext(path)[1] or ".txt"
        target = os.path.join(TRANSCRIPTS_DIR, _title_filename(title) + ext)
        if os.path.realpath(target) != os.path.realpath(path):
            if os.path.exists(target):
                target = os.path.join(TRANSCRIPTS_DIR, f"{_title_filename(title)} ({meeting_id}){ext}")
            try:
                os.rename(path, target)
                meeting.transcript_filepath = target
            except OSError as err:
                logger.warning(f"Could not rename transcript file for meeting {meeting_id}: {err}")

    meeting.title = title
    db.commit()
    return {"status": "updated", "meeting_id": meeting_id, "title": title, "mode": meeting.mode}


SPEAKERS = ("Me", "Participant")
MAX_TRANSCRIPT_LINE_CHARS = 20000


class TranscriptEdit(BaseModel):
    text: str
    speaker: str | None = None


class TranscriptDelete(BaseModel):
    ids: list[int]


def _transcript_json(t: Transcript) -> dict:
    return {"id": t.id, "speaker": t.speaker, "text": t.text,
            "timestamp": t.timestamp.isoformat() if t.timestamp else None}


@app.patch("/meetings/{meeting_id}/transcripts/{transcript_id}")
def edit_transcript_line(meeting_id: int, transcript_id: int, body: TranscriptEdit, db: Session = Depends(get_db)):
    """Correct one transcript line (text and/or who said it). Regenerate the summary to include the change."""
    text_ = body.text.strip()
    if not text_:
        raise HTTPException(400, "Text can't be empty. Delete the line instead.")
    if len(text_) > MAX_TRANSCRIPT_LINE_CHARS:
        raise HTTPException(400, f"A line must be {MAX_TRANSCRIPT_LINE_CHARS} characters or fewer.")
    if body.speaker is not None and body.speaker not in SPEAKERS:
        raise HTTPException(400, f"Speaker must be one of: {', '.join(SPEAKERS)}.")
    row = db.query(Transcript).filter(Transcript.id == transcript_id, Transcript.meeting_id == meeting_id).first()
    if not row:
        raise HTTPException(404, "Transcript line not found")
    row.text = text_
    if body.speaker is not None:
        row.speaker = body.speaker
    db.commit()
    return _transcript_json(row)


@app.post("/meetings/{meeting_id}/transcripts/delete")
def delete_transcript_lines(meeting_id: int, body: TranscriptDelete, db: Session = Depends(get_db)):
    """Permanently remove transcript lines (one or many) from a meeting."""
    if not body.ids:
        raise HTTPException(400, "No lines selected.")
    if not db.query(Meeting.id).filter(Meeting.id == meeting_id).first():
        raise HTTPException(404, "Meeting not found")
    deleted = (db.query(Transcript)
               .filter(Transcript.meeting_id == meeting_id, Transcript.id.in_(body.ids))
               .delete(synchronize_session=False))
    db.commit()
    return {"status": "deleted", "deleted": deleted}


STORAGE_TABLES = {"meetings": Meeting, "transcripts": Transcript, "insights": Insight, "metrics": Metrics, "app_config": AppConfig}


def _db_path() -> str:
    return os.path.realpath(engine.url.database)


def _file_size(path: str) -> int:
    return os.path.getsize(path) if os.path.isfile(path) else 0


@app.get("/storage")
def get_storage(db: Session = Depends(get_db)):
    """Read-only overview of where data lives and how much space it uses."""
    path = _db_path()
    try:
        table_bytes = dict(db.execute(text("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name")).all())
    except Exception:  # noqa: BLE001 - dbstat isn't compiled into every SQLite build
        table_bytes = {}
    tables = [
        {"name": name, "rows": db.query(func.count(model.id)).scalar(), "bytes": table_bytes.get(name)}
        for name, model in STORAGE_TABLES.items()
    ]
    page_size = db.execute(text("PRAGMA page_size")).scalar() or 0
    free_pages = db.execute(text("PRAGMA freelist_count")).scalar() or 0
    legacy_files = [f for f in os.listdir(TRANSCRIPTS_DIR) if os.path.isfile(os.path.join(TRANSCRIPTS_DIR, f))] \
        if os.path.isdir(TRANSCRIPTS_DIR) else []
    oldest, newest = db.query(func.min(Meeting.start_time), func.max(Meeting.start_time)).one()
    return {
        "db_path": path,
        "db_bytes": _file_size(path),
        "wal_bytes": _file_size(path + "-wal"),
        "free_bytes": page_size * free_pages,
        "sqlite_version": db.execute(text("SELECT sqlite_version()")).scalar(),
        "journal_mode": db.execute(text("PRAGMA journal_mode")).scalar(),
        "tables": tables,
        "oldest_meeting": oldest.isoformat() if oldest else None,
        "newest_meeting": newest.isoformat() if newest else None,
        "legacy_transcripts_dir": TRANSCRIPTS_DIR if legacy_files else None,
        "legacy_transcripts_files": len(legacy_files),
        "legacy_transcripts_bytes": sum(_file_size(os.path.join(TRANSCRIPTS_DIR, f)) for f in legacy_files),
    }


@app.post("/storage/reveal")
def reveal_storage():
    import subprocess
    path = _db_path()
    if not os.path.isfile(path):
        raise HTTPException(404, "Database file not found")
    subprocess.run(["open", "-R", path])
    return {"status": "opened"}


@app.post("/meetings/{meeting_id}/open-folder")
def open_meeting_folder(meeting_id: int, db: Session = Depends(get_db)):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if meeting and meeting.transcript_filepath and os.path.exists(meeting.transcript_filepath):
        import subprocess
        # Reveal in Finder on macOS
        subprocess.run(["open", "-R", meeting.transcript_filepath])
        return {"status": "opened"}
    return {"error": "File not found"}

_synthesis_lock = asyncio.Lock()


class NotesUpdate(BaseModel):
    notes: str


@app.put("/meetings/{meeting_id}/notes")
def update_notes(meeting_id: int, body: NotesUpdate, db: Session = Depends(get_db)):
    """Autosaved from the Live view and Meeting History. During a live meeting the notes also steer coaching."""
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        raise HTTPException(404, "Meeting not found")
    meeting.notes = body.notes[:20000]
    db.commit()
    session = realtime.live_session(meeting_id)
    if session is not None:
        session.coach.notes = meeting.notes
    return {"status": "saved"}


@app.post("/meetings/{meeting_id}/followup")
async def draft_followup(meeting_id: int):
    if realtime.runtime.sessions:
        return {"status": "error", "error": "A meeting is in progress. Draft the follow-up after it ends so live coaching stays fast."}
    if _synthesis_lock.locked():
        return {"status": "error", "error": "The local LLM is busy with another summary. Try again when it finishes."}
    async with _synthesis_lock:
        email, error = await PostMeetingSynthesis(lm_client).generate_followup(meeting_id)
    return {"status": "success", "email": email} if email else {"status": "error", "error": error}


@app.post("/meetings/{meeting_id}/synthesize")
async def synthesize_meeting(meeting_id: int):
    if realtime.runtime.sessions:
        return {"status": "error", "error": "A meeting is in progress. Generate the summary after it ends so live coaching stays fast."}
    if _synthesis_lock.locked():
        return {"status": "error", "error": "Another executive summary is being generated. Try again when it finishes."}
    async with _synthesis_lock:
        summary = await PostMeetingSynthesis(lm_client).generate_summary(meeting_id)
    return {"status": "success", "summary": summary}

@app.get("/reports/daily/{date_str}")
def get_daily_report(date_str: str):
    generator = ReportGenerator()
    return generator.generate_daily_report(date_str)
