import os
import logging
import asyncio
import datetime

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import init_db, get_db, Meeting, AppConfig, SessionLocal, Transcript, Insight, Metrics
from lm_studio_client import LMStudioClient
from metrics_engine import MetricsEngine
from post_meeting_synthesis import PostMeetingSynthesis
from report_generator import ReportGenerator
import realtime

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

lm_client: LMStudioClient | None = None
metrics_engine: MetricsEngine | None = None

LEGACY_KEYS = ("whisper_model", "whisper_compute_type", "insight_interval", "system_prompt")


def init_default_settings(db: Session):
    defaults = {
        "llm_api_url": "http://127.0.0.1:1234/v1",
        "llm_model": "",
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
        
    transcripts = [{"id": t.id, "speaker": t.speaker, "text": t.text, "timestamp": t.timestamp.isoformat()} for t in meeting.transcripts]
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
        "summary": meeting.summary,
        "transcript_filepath": meeting.transcript_filepath,
        "lps_score": meeting.lps_score,
        "strategic_alternatives": meeting.strategic_alternatives,
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
    export_content += f"{meeting.summary or 'No summary generated.'}\n\n"
    
    if meeting.strategic_alternatives:
        export_content += "## Strategic Executive Rerouting & Pivots\n"
        export_content += f"{meeting.strategic_alternatives}\n\n"
        
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
