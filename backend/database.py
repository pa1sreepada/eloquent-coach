from sqlalchemy import create_engine, event, Column, Integer, String, Float, DateTime, Date, ForeignKey, Text, LargeBinary
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from sqlcipher3 import dbapi2 as sqlcipher
import datetime
import logging
import os

import secure_store

logger = logging.getLogger(__name__)

DB_PATH = os.path.abspath("eloquent_coach.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"
# Older versions also wrote one plaintext .txt per meeting here; they are imported into the DB and removed.
TRANSCRIPTS_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcripts"))

# Encrypted at rest with SQLCipher; the key is read lazily (first connection) from the OS credential store.
engine = create_engine(DATABASE_URL, module=sqlcipher, creator=lambda: secure_store.connect(DB_PATH))


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
    attendees = Column(Text, nullable=True)        # comma-separated names; links meetings to stakeholders
    attribution = Column(String, nullable=True)    # growth: None/auto | verified | mixed | exclude ("Me" lines really mine?)

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


class LegacyTranscriptFile(Base):
    """A transcript file written by older versions, kept inside the encrypted database instead of on disk."""
    __tablename__ = "legacy_transcript_files"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=True, index=True)
    filename = Column(String)
    content = Column(LargeBinary)
    sha256 = Column(String)
    modified_at = Column(DateTime, nullable=True)


class Commitment(Base):
    """A promise made in a meeting (by me or someone else), tracked until it's done."""
    __tablename__ = "commitments"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=True, index=True)
    owner = Column(String, default="Unassigned")
    is_mine = Column(Integer, default=0)
    action = Column(Text)
    due_text = Column(String, nullable=True)       # as stated ("Friday", "next week")
    due_date = Column(Date, nullable=True)         # resolved against the meeting date
    status = Column(String, default="open")        # open | done | dropped
    source = Column(String, default="manual")      # summary | live | manual
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)


class Stakeholder(Base):
    """What a person I meet often cares about and how to persuade them."""
    __tablename__ = "stakeholders"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True)
    role = Column(String, default="")
    relationship_type = Column(String, default="")   # direct report, peer, boss, board, vendor, customer…
    priorities = Column(Text, default="")
    pushback_style = Column(Text, default="")
    persuaders = Column(Text, default="")
    notes = Column(Text, default="")
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)


class MeetingItem(Base):
    """Decisions, commitments and parked topics caught live by the decision tracker."""
    __tablename__ = "meeting_items"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), index=True)
    kind = Column(String)                  # decision | commitment | parked
    text = Column(Text)
    owner = Column(String, nullable=True)  # commitments only; None = nobody owns it yet
    speaker = Column(String, nullable=True)
    t_ms = Column(Integer, nullable=True)


class Rehearsal(Base):
    """A practice conversation against an AI persona, with its scorecard."""
    __tablename__ = "rehearsals"

    id = Column(Integer, primary_key=True, index=True)
    persona = Column(String)
    scenario = Column(Text, default="")
    turns = Column(Text, default="[]")      # JSON [{role: me|coach, text}]
    scores = Column(Text, nullable=True)    # JSON scorecard
    feedback = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)


class GeneratedDoc(Base):
    """LLM-written briefings kept for later: weekly digest, narrative check, pre-meeting brief, stakeholder notes."""
    __tablename__ = "generated_docs"

    id = Column(Integer, primary_key=True, index=True)
    kind = Column(String, index=True)       # digest | narrative | brief
    ref = Column(String, nullable=True)     # e.g. the week, or the brief's subject
    content = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class PracticeItem(Base):
    """A 'say it better' moment the leader has practised."""
    __tablename__ = "practice_items"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, unique=True, index=True)   # hash of meeting + original line
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=True)
    original = Column(Text)
    better = Column(Text, nullable=True)
    practiced_at = Column(DateTime, nullable=True)


class MeetingAnalysis(Base):
    """Cached deterministic per-meeting analysis; recomputed when the transcript changes (signature)."""
    __tablename__ = "meeting_analysis"

    meeting_id = Column(Integer, ForeignKey("meetings.id"), primary_key=True)
    signature = Column(String)
    data = Column(Text)


LEADERSHIP_TABLES = (Commitment, MeetingItem, PracticeItem, MeetingAnalysis)   # rows owned by a meeting


class AppConfig(Base):
    __tablename__ = "app_config"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, unique=True, index=True)
    value = Column(String)


def _db_files() -> tuple[str, ...]:
    return DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"


def import_legacy_files(transcripts_dir: str = TRANSCRIPTS_DIR) -> int:
    """Move legacy plaintext transcript files into the encrypted DB, verify each one, then wipe the file."""
    if not os.path.isdir(transcripts_dir):
        return 0
    names = sorted(n for n in os.listdir(transcripts_dir) if os.path.isfile(os.path.join(transcripts_dir, n)))
    if not names:
        return 0
    db = SessionLocal()
    moved = 0
    try:
        by_name = {os.path.basename(m.transcript_filepath): m for m in
                   db.query(Meeting).filter(Meeting.transcript_filepath.isnot(None)).all()}
        for name in names:
            path = os.path.join(transcripts_dir, name)
            if name == ".DS_Store":
                secure_store.wipe_file(path)
                continue
            with open(path, "rb") as f:
                data = f.read()
            digest = secure_store.sha256(data)
            meeting = by_name.get(name)
            row = db.query(LegacyTranscriptFile).filter(
                LegacyTranscriptFile.filename == name, LegacyTranscriptFile.sha256 == digest).first()
            if not row:   # not already imported by an interrupted earlier run
                row = LegacyTranscriptFile(
                    meeting_id=meeting.id if meeting else None, filename=name, content=data, sha256=digest,
                    modified_at=datetime.datetime.utcfromtimestamp(os.path.getmtime(path)))
                db.add(row)
            if meeting:
                meeting.transcript_filepath = None
            db.commit()
            db.refresh(row)
            if secure_store.sha256(row.content) != digest:
                raise RuntimeError(f"Legacy transcript {name} didn't round-trip through the database.")
            secure_store.wipe_file(path)
            moved += 1
        # Meetings whose file was already gone shouldn't keep pointing at the old folder.
        db.query(Meeting).filter(Meeting.transcript_filepath.isnot(None)).update(
            {Meeting.transcript_filepath: None}, synchronize_session=False)
        db.commit()
    finally:
        db.close()
    try:
        os.rmdir(transcripts_dir)
    except OSError:
        pass   # something other than files is left in it
    logger.info(f"Moved {moved} legacy transcript file(s) into the encrypted database.")
    return moved


def init_db():
    secure_store.encrypt_existing_database(DB_PATH)
    Base.metadata.create_all(bind=engine)
    secure_store.restrict_permissions(*_db_files())
    
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
        for col in ("notes", "followup_email", "attendees", "attribution"):
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

    import_legacy_files()
    secure_store.restrict_permissions(*_db_files())

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
