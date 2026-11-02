import os
import logging
import asyncio
import datetime

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import init_db, get_db, Meeting, AppConfig, SessionLocal
from lm_studio_client import LMStudioClient
from metrics_engine import MetricsEngine
from post_meeting_synthesis import PostMeetingSynthesis
from report_generator import ReportGenerator
import realtime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Eloquent Coach API")

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

LEGACY_KEYS = ("whisper_model", "whisper_compute_type", "insight_interval")


def init_default_settings(db: Session):
    defaults = {
        "llm_api_url": "http://127.0.0.1:1234/v1",
        "llm_model": "",
        "system_prompt": "You are a strategic leadership coach monitoring an executive meeting.\nProvide ONE high-impact Leading Question or Strategic Pivot for the leader.\nFocus on asking powerful Socratic questions that surface alignment, uncover unstated risks, or drive ownership.\nCategorize as: 'question' (Leading Question), 'structure' (Strategic Pivot), 'risk' (Blindspot/Risk Alert), or 'praise' (High-Leverage Statement).\nFormat: CATEGORY | Your strategic question or pivot here.\nKeep under 20 words. Reply 'NONE' if no strategic input is needed.",
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
    await realtime.warmup()


class SettingsUpdate(BaseModel):
    llm_api_url: str
    llm_model: str = ""
    system_prompt: str
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
    return {"status": "ok", "message": "Eloquent Coach API is running"}

@app.post("/meetings/")
def start_meeting(mode: str = "General", agenda: str = "", prep_notes: str = "", db: Session = Depends(get_db)):
    now = datetime.datetime.utcnow()
    timestamp_str = now.strftime("%Y-%m-%d %H:%M")
    
    transcripts_dir = os.path.join(os.path.dirname(__file__), "transcripts")
    if not os.path.exists(transcripts_dir):
        os.makedirs(transcripts_dir)
        
    filename = f"Meeting_{now.strftime('%Y-%m-%d_%H-%M-%S')}.txt"
    filepath = os.path.join(transcripts_dir, filename)
    
    new_meeting = Meeting(title=f"Meeting - {timestamp_str}", start_time=now, transcript_filepath=filepath, mode=mode, agenda=agenda, prep_notes=prep_notes)
    db.add(new_meeting)
    db.commit()
    db.refresh(new_meeting)
    
    with open(filepath, "w") as f:
        f.write(f"--- {new_meeting.title} ---\n")
        f.write(f"Start Time: {now.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"Mode: {mode}\n")
        if agenda:
            f.write(f"Agenda / Objectives: {agenda}\n")
        if prep_notes:
            f.write(f"Prep Notes & References: {prep_notes}\n")
        f.write("\n")
        
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
            
        # Asynchronously trigger executive synthesis so content is ready immediately
        try:
            synthesizer = PostMeetingSynthesis(lm_client)
            asyncio.create_task(synthesizer.generate_summary(meeting_id))
        except Exception as synth_err:
            logger.warning(f"Error triggering auto-synthesis on meeting end: {synth_err}")
            
        return {"status": "ended", "meeting_id": meeting_id}
    return {"error": "Meeting not found"}

@app.get("/dashboard/stats")
def get_dashboard_stats(db: Session = Depends(get_db)):
    meetings = db.query(Meeting).all()
    if not meetings:
        return {
            "avg_score": 0,
            "talk_time_pct": 0,
            "action_items": 0,
            "recent_meetings": []
        }
    
    total_score = 0
    total_confidence = 0
    total_talk_time = 0
    total_listen_time = 0
    
    for m in meetings:
        total_score += (m.lps_score or 8.5)
        
        for metric in m.metrics:
            total_talk_time += metric.talk_time
            total_listen_time += metric.listen_time
            total_confidence += (metric.confidence_score or 8.0)
            
    total_time = total_talk_time + total_listen_time
    count = len(meetings)
    talk_time_pct = (total_talk_time / total_time * 100) if total_time > 0 else 0
    avg_score = round(total_score / count, 1)
    avg_confidence = round(total_confidence / count, 1) if count > 0 else 0
    
    recent = db.query(Meeting).order_by(Meeting.start_time.desc()).limit(3).all()
    recent_list = []
    for m in recent:
        recent_list.append({
            "id": m.id,
            "title": m.title,
            "date": m.start_time.strftime("%b %d, %Y") if m.start_time else "Unknown",
            "score": 8.5,
            "duration": "20m" # Mock for now
        })

    return {
        "avg_score": avg_score,
        "talk_time_pct": round(talk_time_pct, 1),
        "confidence_score": avg_confidence,
        "recent_meetings": recent_list
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
        "metrics": metrics
    }

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
        
    export_content += "## Raw Transcript\n"
    for t in meeting.transcripts:
        time_str = t.timestamp.strftime("%H:%M:%S") if t.timestamp else ""
        export_content += f"[{time_str}] **{t.speaker}**: {t.text}\n"
        
    return {"meeting_id": meeting_id, "title": meeting.title, "export_markdown": export_content}

@app.post("/meetings/{meeting_id}/open-folder")
def open_meeting_folder(meeting_id: int, db: Session = Depends(get_db)):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if meeting and meeting.transcript_filepath and os.path.exists(meeting.transcript_filepath):
        import subprocess
        # Reveal in Finder on macOS
        subprocess.run(["open", "-R", meeting.transcript_filepath])
        return {"status": "opened"}
    return {"error": "File not found"}

@app.post("/meetings/{meeting_id}/synthesize")
async def synthesize_meeting(meeting_id: int):
    global lm_client
    synthesizer = PostMeetingSynthesis(lm_client)
    summary = await synthesizer.generate_summary(meeting_id)
    return {"status": "success", "summary": summary}

@app.get("/reports/daily/{date_str}")
def get_daily_report(date_str: str):
    generator = ReportGenerator()
    return generator.generate_daily_report(date_str)
