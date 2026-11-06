from sqlalchemy import create_engine, event, Column, Integer, String, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
import datetime
import os

DATABASE_URL = "sqlite:///./eloquent_coach.db"

engine = create_engine(
    DATABASE_URL, connect_args={"check_same_thread": False}
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    # WAL lets the HUD/report readers run while the live pipeline writes.
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA secure_delete=ON")   # overwrite deleted meeting data instead of leaving it in free pages
    cur.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class Meeting(Base):
    __tablename__ = "meetings"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, default="Untitled Meeting")
    start_time = Column(DateTime, default=datetime.datetime.utcnow)
    end_time = Column(DateTime, nullable=True)
    summary = Column(Text, nullable=True)
    quality_score = Column(Float, nullable=True)
    transcript_filepath = Column(String, nullable=True)
    mode = Column(String, default="General")
    agenda = Column(Text, nullable=True)
    prep_notes = Column(Text, nullable=True)
    lps_score = Column(Float, nullable=True)
    strategic_alternatives = Column(Text, nullable=True) # Stored as JSON string
    notes = Column(Text, nullable=True)            # typed by the leader during/after the meeting
    followup_email = Column(Text, nullable=True)   # drafted on demand from the summary

    transcripts = relationship("Transcript", back_populates="meeting")
    insights = relationship("Insight", back_populates="meeting")
    metrics = relationship("Metrics", back_populates="meeting")


class Transcript(Base):
    __tablename__ = "transcripts"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"))
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)
    text = Column(Text)
    speaker = Column(String, default="User")
    start_ms = Column(Integer, nullable=True)      # audio time from meeting start
    end_ms = Column(Integer, nullable=True)
    utterance_id = Column(String, nullable=True)

    meeting = relationship("Meeting", back_populates="transcripts")


class Insight(Base):
    __tablename__ = "insights"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"))
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)
    insight_type = Column(String) # e.g. "risk", "question", "structure"
    text = Column(Text)
    strategic_rationale = Column(Text, nullable=True)

    meeting = relationship("Meeting", back_populates="insights")


class Metrics(Base):
    __tablename__ = "metrics"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"))
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)
    talk_time = Column(Float, default=0.0)
    listen_time = Column(Float, default=0.0)
    interruptions = Column(Integer, default=0)
    filler_count = Column(Integer, default=0)
    pacing = Column(Float, nullable=True) # words per minute
    confidence_score = Column(Float, nullable=True)
    wait_time_avg = Column(Float, default=0.0)
    question_ratio = Column(Float, default=0.0)
    we_i_ratio = Column(Float, default=0.0)
    future_focus_pct = Column(Float, default=0.0)

    meeting = relationship("Meeting", back_populates="metrics")


class Script(Base):
    """Teleprompter script (plain text with light markup; see app/src/prompter/script.ts)."""
    __tablename__ = "scripts"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, default="Untitled script")
    content = Column(Text, default="")
    target_wpm = Column(Integer, default=150)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

    runs = relationship("ScriptRun", back_populates="script", cascade="all, delete-orphan",
                        order_by="ScriptRun.started_at")


class ScriptRun(Base):
    """One read-through of a script with the teleprompter (rehearsal or live)."""
    __tablename__ = "script_runs"

    id = Column(Integer, primary_key=True, index=True)
    script_id = Column(Integer, ForeignKey("scripts.id"), index=True)
    started_at = Column(DateTime, default=datetime.datetime.utcnow)
    duration_s = Column(Integer, default=0)
    avg_wpm = Column(Integer, nullable=True)
    coverage_pct = Column(Integer, default=0)
    adlib_s = Column(Integer, default=0)
    fillers = Column(Integer, default=0)
    finished = Column(Integer, default=0)
    details = Column(Text, nullable=True)    # full report as JSON (sections, skipped sentences, …)

    script = relationship("Script", back_populates="runs")


class AppConfig(Base):
    __tablename__ = "app_config"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, unique=True, index=True)
    value = Column(String)


def init_db():
    Base.metadata.create_all(bind=engine)
    
    # Simple migration logic for existing databases
    from sqlalchemy import inspect, text
    inspector = inspect(engine)
    
    with engine.connect() as conn:
        # Check Meeting table
        columns = [c['name'] for c in inspector.get_columns("meetings")]
        if "mode" not in columns:
            conn.execute(text("ALTER TABLE meetings ADD COLUMN mode TEXT DEFAULT 'General'"))
        if "agenda" not in columns:
            conn.execute(text("ALTER TABLE meetings ADD COLUMN agenda TEXT"))
        if "prep_notes" not in columns:
            conn.execute(text("ALTER TABLE meetings ADD COLUMN prep_notes TEXT"))
        if "lps_score" not in columns:
            conn.execute(text("ALTER TABLE meetings ADD COLUMN lps_score FLOAT"))
        if "strategic_alternatives" not in columns:
            conn.execute(text("ALTER TABLE meetings ADD COLUMN strategic_alternatives TEXT"))
        for col in ("notes", "followup_email"):
            if col not in columns:
                conn.execute(text(f"ALTER TABLE meetings ADD COLUMN {col} TEXT"))
            
        columns = [c['name'] for c in inspector.get_columns("transcripts")]
        for col, ddl in (("start_ms", "INTEGER"), ("end_ms", "INTEGER"), ("utterance_id", "TEXT")):
            if col not in columns:
                conn.execute(text(f"ALTER TABLE transcripts ADD COLUMN {col} {ddl}"))

        # Check Insight table
        columns = [c['name'] for c in inspector.get_columns("insights")]
        if "strategic_rationale" not in columns:
            conn.execute(text("ALTER TABLE insights ADD COLUMN strategic_rationale TEXT"))
            
        # Check Metrics table
        columns = [c['name'] for c in inspector.get_columns("metrics")]
        if "confidence_score" not in columns:
            conn.execute(text("ALTER TABLE metrics ADD COLUMN confidence_score FLOAT"))
        if "wait_time_avg" not in columns:
            conn.execute(text("ALTER TABLE metrics ADD COLUMN wait_time_avg FLOAT DEFAULT 0.0"))
        if "question_ratio" not in columns:
            conn.execute(text("ALTER TABLE metrics ADD COLUMN question_ratio FLOAT DEFAULT 0.0"))
        if "we_i_ratio" not in columns:
            conn.execute(text("ALTER TABLE metrics ADD COLUMN we_i_ratio FLOAT DEFAULT 0.0"))
        if "future_focus_pct" not in columns:
            conn.execute(text("ALTER TABLE metrics ADD COLUMN future_focus_pct FLOAT DEFAULT 0.0"))
            
        conn.commit()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
