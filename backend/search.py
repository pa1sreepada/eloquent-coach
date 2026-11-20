"""Global search across meetings (title, attendees, summary, notes, agenda), transcripts, commitments,
stakeholders and teleprompter scripts. Plain LIKE matching (every word must appear), which is fast enough
for a personal history and works inside the encrypted database without an extra index."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from database import Commitment, Meeting, Script, Stakeholder, Transcript, get_db

router = APIRouter()

MAX_TERMS = 6


def terms(q: str) -> list[str]:
    return [t for t in re.findall(r'"[^"]+"|\S+', q.strip().lower()) if len(t.strip('"')) >= 2][:MAX_TERMS]


def _like(col, term: str):
    t = term.strip('"').replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return col.ilike(f"%{t}%", escape="\\")


def _all(cols, ts):
    """Every term matches at least one of the columns."""
    return and_(*[or_(*[_like(c, t) for c in cols]) for t in ts])


def snippet(text: str, ts: list[str], width: int = 160) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    low = text.lower()
    pos = min((p for p in (low.find(t.strip('"')) for t in ts) if p >= 0), default=0)
    start = max(0, pos - width // 3)
    out = text[start:start + width]
    return ("…" if start else "") + out + ("…" if start + width < len(text) else "")


def _when(m: Meeting | None) -> str | None:
    return m.start_time.isoformat() if m and m.start_time else None


@router.get("/search")
def search(q: str = "", limit: int = 8, db: Session = Depends(get_db)):
    if len(q) > 200:
        raise HTTPException(400, "Search is limited to 200 characters.")
    ts = terms(q)
    if not ts:
        return {"q": q, "meetings": [], "transcripts": [], "commitments": [], "people": [], "scripts": []}
    limit = max(1, min(limit, 25))

    fields = (Meeting.title, Meeting.attendees, Meeting.summary, Meeting.notes, Meeting.agenda)
    meetings = []
    for m in db.query(Meeting).filter(_all(fields, ts)).order_by(Meeting.start_time.desc()).limit(limit):
        where = next((name for name, v in (("title", m.title), ("attendees", m.attendees), ("summary", m.summary),
                                           ("notes", m.notes), ("agenda", m.agenda))
                      if v and any(t.strip('"') in v.lower() for t in ts)), "summary")
        meetings.append({"id": m.id, "title": m.title, "when": _when(m), "mode": m.mode, "field": where,
                         "snippet": snippet(getattr(m, where) or "", ts)})

    # Transcript lines: the best line per meeting, newest meetings first.
    rows = (db.query(Transcript, Meeting).join(Meeting, Meeting.id == Transcript.meeting_id)
            .filter(_all((Transcript.text,), ts)).order_by(Meeting.start_time.desc(), Transcript.id).limit(400).all())
    per: dict[int, dict] = {}
    for t, m in rows:
        hit = per.setdefault(m.id, {"meeting_id": m.id, "title": m.title, "when": _when(m), "count": 0,
                                     "speaker": t.speaker, "snippet": snippet(t.text, ts), "start_ms": t.start_ms})
        hit["count"] += 1
    transcripts = list(per.values())[:limit]

    commitments = [{"id": c.id, "owner": c.owner, "action": c.action, "status": c.status,
                    "due": c.due_date.isoformat() if c.due_date else c.due_text, "meeting_id": c.meeting_id}
                   for c in db.query(Commitment).filter(_all((Commitment.action, Commitment.owner), ts))
                   .order_by(Commitment.status != "open", Commitment.created_at.desc()).limit(limit)]
    people = [{"id": s.id, "name": s.name, "role": s.role}
              for s in db.query(Stakeholder).filter(_all((Stakeholder.name, Stakeholder.role), ts)).limit(limit)]
    scripts = [{"id": s.id, "title": s.title, "snippet": snippet(s.content, ts)}
               for s in db.query(Script).filter(_all((Script.title, Script.content), ts)).limit(limit)]
    return {"q": q, "meetings": meetings, "transcripts": transcripts, "commitments": commitments,
            "people": people, "scripts": scripts}
