"""Leadership features on top of the meeting record.

    Commitments    GET/POST /commitments, PATCH/DELETE /commitments/{id}, GET /commitments/reminders,
                   POST /commitments/sync                        (ledger across meetings, from briefings + live tracker)
    Stakeholders   GET/POST /stakeholders, PUT/DELETE /stakeholders/{id}, POST /stakeholders/{id}/learn, GET /people
    Prep           POST /brief                                   (one-page pre-meeting brief)
    Growth         GET /growth, PUT /meetings/{id}/attribution, GET /growth/say-it-better,
                   POST /growth/say-it-better/rewrite, POST /growth/practice
    Team           GET /team/radar
    Briefings      POST /digest/weekly, POST /narrative/check, GET /generated-docs, DELETE /generated-docs/{id}
    Rehearsal      GET /rehearsals/personas, GET/POST /rehearsals, GET/DELETE /rehearsals/{id},
                   POST /rehearsals/{id}/turn, POST /rehearsals/{id}/finish

Everything deterministic (stats, radar, reminders) works without an LLM. LLM features use the post-meeting
client, so they follow Settings (local server, or the external frontier model when that's on).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import case, func
from sqlalchemy.orm import Session

import leadership_analysis as la
import llm_provider
import realtime
from database import (AppConfig, Commitment, GeneratedDoc, Meeting, MeetingAnalysis, MeetingItem, PracticeItem,
                      Rehearsal, Script, ScriptRun, Stakeholder, Transcript, get_db)
from lm_studio_client import LMStudioClient

logger = logging.getLogger(__name__)
router = APIRouter()
_llm = LMStudioClient()
LLM_LOCK = asyncio.Lock()   # one long LLM job at a time (shared with summaries in main.py)

MAX_TEXT = 4000


# ---------------------------------------------------------------- helpers
def _cfg(db: Session) -> dict:
    return {c.key: c.value for c in db.query(AppConfig).all()}


def _fillers(cfg: dict) -> list[str]:
    return [f.strip() for f in (cfg.get("filler_words") or "").split(",") if f.strip()]


def _jargon(cfg: dict) -> set[str]:
    return {w.strip().lower() for w in (cfg.get("custom_jargon") or "").split(",") if w.strip()}


def _today() -> dt.date:
    return dt.date.today()


def _live_ids() -> set[int]:
    return {s.meeting_id for s in realtime.runtime.sessions}


def _busy_reason() -> str | None:
    """Local LLM + live meeting: keep the GPU for live coaching. An external model doesn't compete."""
    if not realtime.runtime.sessions:
        return None
    try:
        if _llm._external() is not None:
            return None
    except llm_provider.LlmError:
        pass
    return "A meeting is in progress. Try again after it ends so live coaching stays fast."


async def _ask_llm(system: str, user: str, max_tokens: int, temperature: float = 0.3) -> str:
    reason = _busy_reason()
    if reason:
        raise HTTPException(409, reason)
    if LLM_LOCK.locked():
        raise HTTPException(409, "The LLM is busy with another request (e.g. a summary). Try again when it finishes.")
    async with LLM_LOCK:
        out = await _llm.complete(system, user, max_tokens=max_tokens, temperature=temperature)
    if not out.strip():
        raise HTTPException(502, _llm.last_error or "The LLM returned nothing. Check the LLM in Settings.")
    return out.strip()


def _section(summary: str | None, *names: str) -> list[str]:
    """Bullets under the briefing headings whose name contains any of `names`."""
    out, on = [], False
    for line in (summary or "").splitlines():
        h = re.match(r"^\s*\*\*([^*]+)\*\*\s*$", line)
        if h:
            on = any(n in h[1].lower() for n in names)
            continue
        if on and line.strip().startswith("-"):
            out.append(line.strip()[1:].strip().replace("**", ""))
    return out


def _bottom_line(summary: str | None) -> str:
    m = re.search(r"\*\*(?:Bottom line|Core message):\*\*\s*(.+)", summary or "")
    if m:
        return m[1].strip()
    first = next((ln.strip() for ln in (summary or "").splitlines() if ln.strip()), "")
    return first[:300]


def _date(m: Meeting) -> dt.datetime:
    return m.start_time or dt.datetime(1970, 1, 1)


# ---------------------------------------------------------------- per-meeting analysis (cached)
def _signature(db: Session, m: Meeting, cfg: dict) -> str:
    n, last, chars, mine = db.query(
        func.count(Transcript.id), func.max(Transcript.id), func.sum(func.length(Transcript.text)),
        func.sum(case((Transcript.speaker.in_(tuple(la.ME_SPEAKERS)), 1), else_=0)),
    ).filter(Transcript.meeting_id == m.id).one()
    extra = hashlib.sha1(f"{cfg.get('filler_words')}|{cfg.get('custom_jargon')}".encode()).hexdigest()[:8]
    return f"{la.ANALYSIS_VERSION}:{n}:{last}:{chars}:{mine}:{m.attribution or 'auto'}:{extra}"


def meeting_analysis(db: Session, m: Meeting, cfg: dict) -> dict:
    sig = _signature(db, m, cfg)
    row = db.get(MeetingAnalysis, m.id)
    if row and row.signature == sig:
        return json.loads(row.data)
    rows = (db.query(Transcript).filter(Transcript.meeting_id == m.id)
            .order_by(Transcript.timestamp.asc(), Transcript.id.asc()).all())
    lines = [la.Line(t.speaker or "", t.text or "", t.start_ms, t.end_ms, t.timestamp) for t in rows]
    data = la.analyze_meeting(lines, _fillers(cfg), m.attribution, _jargon(cfg))
    if m.id not in _live_ids():
        if row:
            row.signature, row.data = sig, json.dumps(data)
        else:
            db.add(MeetingAnalysis(meeting_id=m.id, signature=sig, data=json.dumps(data)))
        db.commit()
    return data


def _analysed(db: Session, days: int | None = None) -> list[dict]:
    cfg = _cfg(db)
    leader = cfg.get("leader_name", "")
    q = db.query(Meeting)
    if days:
        q = q.filter(Meeting.start_time >= dt.datetime.utcnow() - dt.timedelta(days=days))
    out = []
    for m in q.order_by(Meeting.start_time.asc()).all():
        if m.id in _live_ids():
            continue
        a = meeting_analysis(db, m, cfg)
        if not a["stats"]["me_words"] and not a["other_words"]:
            continue
        out.append({"id": m.id, "title": m.title, "date": _date(m), "mode": m.mode,
                    "category": la.meeting_category(m.mode, m.title),
                    "people": la.people_in(m.title, m.attendees, leader),
                    "attribution": a["attribution"], "confidence": a["confidence"],
                    "override": m.attribution, "stats": a["stats"], "analysis": a, "meeting": m})
    return out


# ---------------------------------------------------------------- commitments
class CommitmentIn(BaseModel):
    action: str = Field(..., min_length=1, max_length=500)
    owner: str = Field("Me", max_length=80)
    due_text: str | None = Field(None, max_length=60)
    due_date: dt.date | None = None
    meeting_id: int | None = None


class CommitmentPatch(BaseModel):
    action: str | None = Field(None, min_length=1, max_length=500)
    owner: str | None = Field(None, max_length=80)
    due_text: str | None = Field(None, max_length=60)
    due_date: dt.date | None = None
    status: str | None = None


def _commitment_json(c: Commitment, titles: dict[int, str], today: dt.date) -> dict:
    overdue = c.status == "open" and c.due_date is not None and c.due_date < today
    return {"id": c.id, "meeting_id": c.meeting_id, "meeting_title": titles.get(c.meeting_id), "owner": c.owner,
            "is_mine": bool(c.is_mine), "action": c.action, "due_text": c.due_text,
            "due_date": c.due_date.isoformat() if c.due_date else None, "status": c.status, "source": c.source,
            "overdue": overdue, "days_overdue": (today - c.due_date).days if overdue else 0,
            "created_at": c.created_at.isoformat() if c.created_at else None}


def _norm(text: str) -> str:
    return " ".join(la._words(text))[:80]


def sync_meeting_commitments(db: Session, m: Meeting, leader: str = "") -> int:
    """Add this meeting's commitments to the ledger (idempotent; dropped items stay dropped)."""
    base = _date(m).date()
    found = [dict(x, source="summary") for x in la.summary_actions(m.summary)]
    if found:   # the briefing's action items supersede the rougher live-tracker ones
        db.query(Commitment).filter(Commitment.meeting_id == m.id, Commitment.source == "live",
                                    Commitment.status == "open").delete(synchronize_session=False)
    else:   # no briefing yet: the live tracker's commitments that had an owner
        items = db.query(MeetingItem).filter(MeetingItem.meeting_id == m.id, MeetingItem.kind == "commitment",
                                             MeetingItem.owner.isnot(None)).all()
        found = [{"owner": i.owner if i.owner != "Participant" else "Unassigned", "action": i.text,
                  "due_text": None, "source": "live"} for i in items]
    have = {_norm(c.action) for c in db.query(Commitment).filter(Commitment.meeting_id == m.id).all()}
    added = 0
    for f in found:
        key = _norm(f["action"])
        if not key or key in have:
            continue
        have.add(key)
        db.add(Commitment(meeting_id=m.id, owner=f["owner"], is_mine=int(la.is_mine(f["owner"], leader)),
                          action=f["action"], due_text=f["due_text"],
                          due_date=la.resolve_due(f["due_text"] or f["action"], base),
                          source=f["source"], created_at=_date(m)))
        added += 1
    db.commit()
    return added


@router.get("/commitments")
def list_commitments(status: str = "open", mine: bool | None = None, db: Session = Depends(get_db)):
    q = db.query(Commitment)
    if status != "all":
        q = q.filter(Commitment.status == status)
    if mine is not None:
        q = q.filter(Commitment.is_mine == int(mine))
    rows = q.all()
    titles = dict(db.query(Meeting.id, Meeting.title).filter(Meeting.id.in_({c.meeting_id for c in rows if c.meeting_id})).all())
    today = _today()
    out = [_commitment_json(c, titles, today) for c in rows]
    out.sort(key=lambda c: (c["status"] != "open", c["due_date"] or "9999", c["created_at"] or ""))
    return out


@router.post("/commitments")
def add_commitment(body: CommitmentIn, db: Session = Depends(get_db)):
    leader = _cfg(db).get("leader_name", "")
    c = Commitment(owner=body.owner.strip() or "Me", action=body.action.strip(), due_text=body.due_text,
                   due_date=body.due_date or la.resolve_due(body.due_text, _today()), meeting_id=body.meeting_id,
                   is_mine=int(la.is_mine(body.owner, leader)), source="manual")
    db.add(c)
    db.commit()
    return _commitment_json(c, {}, _today())


@router.patch("/commitments/{cid}")
def update_commitment(cid: int, body: CommitmentPatch, db: Session = Depends(get_db)):
    c = db.get(Commitment, cid)
    if not c:
        raise HTTPException(404, "Commitment not found")
    if body.status is not None:
        if body.status not in ("open", "done", "dropped"):
            raise HTTPException(400, "Status must be open, done or dropped.")
        c.status = body.status
        c.completed_at = dt.datetime.utcnow() if body.status == "done" else None
    if body.action is not None:
        c.action = body.action.strip()
    if body.owner is not None:
        c.owner = body.owner.strip() or "Unassigned"
        c.is_mine = int(la.is_mine(c.owner, _cfg(db).get("leader_name", "")))
    if body.due_text is not None:
        c.due_text = body.due_text.strip() or None
        c.due_date = la.resolve_due(c.due_text, _today())
    if "due_date" in body.model_fields_set:
        c.due_date = body.due_date
    db.commit()
    return _commitment_json(c, {}, _today())


@router.delete("/commitments/{cid}")
def delete_commitment(cid: int, db: Session = Depends(get_db)):
    db.query(Commitment).filter(Commitment.id == cid).delete()
    db.commit()
    return {"status": "deleted"}


@router.post("/commitments/sync")
def sync_commitments(db: Session = Depends(get_db)):
    leader = _cfg(db).get("leader_name", "")
    added = sum(sync_meeting_commitments(db, m, leader) for m in db.query(Meeting).all() if m.id not in _live_ids())
    return {"added": added}


@router.get("/commitments/reminders")
def reminders(db: Session = Depends(get_db)):
    today = _today()
    rows = db.query(Commitment).filter(Commitment.status == "open").all()
    titles = dict(db.query(Meeting.id, Meeting.title).all())
    js = [_commitment_json(c, titles, today) for c in rows]
    soon = today + dt.timedelta(days=3)
    return {
        "overdue": [c for c in js if c["is_mine"] and c["overdue"]],
        "due_soon": [c for c in js if c["is_mine"] and not c["overdue"] and c["due_date"] and c["due_date"] <= soon.isoformat()],
        "slipping": [c for c in js if not c["is_mine"] and c["overdue"] and c["owner"] != "Unassigned"],
        "unowned": [c for c in js if c["owner"] == "Unassigned"][:10],
    }


# ---------------------------------------------------------------- stakeholders
class StakeholderIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    role: str = Field("", max_length=120)
    relationship_type: str = Field("", max_length=60)
    priorities: str = Field("", max_length=MAX_TEXT)
    pushback_style: str = Field("", max_length=MAX_TEXT)
    persuaders: str = Field("", max_length=MAX_TEXT)
    notes: str = Field("", max_length=MAX_TEXT)


def _matches(person: str, names: list[str]) -> bool:
    p = person.lower().strip()
    first = p.split()[0] if p else ""
    return any(n.lower() == p or (n.lower().split()[0] == first and (" " not in p or " " not in n)) for n in names)


def _meetings_with(analysed: list[dict], person: str) -> list[dict]:
    return [m for m in analysed if _matches(person, m["people"])]


def _stakeholder_json(s: Stakeholder, analysed: list[dict], open_items: list[Commitment]) -> dict:
    mine = _meetings_with(analysed, s.name)
    theirs = [c for c in open_items if _matches(s.name, [c.owner or ""])]
    return {"id": s.id, "name": s.name, "role": s.role, "relationship_type": s.relationship_type,
            "priorities": s.priorities, "pushback_style": s.pushback_style, "persuaders": s.persuaders,
            "notes": s.notes, "meetings": len(mine),
            "last_met": mine[-1]["date"].date().isoformat() if mine else None,
            "their_open_commitments": len(theirs),
            "recent_concerns": list(dict.fromkeys(t for m in mine[-5:] for t in m["analysis"]["concerns"][:3]))[:6]}


@router.get("/people")
def people(db: Session = Depends(get_db)):
    leader = _cfg(db).get("leader_name", "")
    names: dict[str, int] = {}
    for title, att in db.query(Meeting.title, Meeting.attendees).all():
        for n in la.people_in(title, att, leader):
            names[n] = names.get(n, 0) + 1
    for (n,) in db.query(Stakeholder.name).all():
        names.setdefault(n, 0)
    return [{"name": n, "meetings": c} for n, c in sorted(names.items(), key=lambda x: (-x[1], x[0]))]


@router.get("/stakeholders")
def list_stakeholders(db: Session = Depends(get_db)):
    analysed = _analysed(db, days=365)
    open_items = db.query(Commitment).filter(Commitment.status == "open").all()
    rows = db.query(Stakeholder).order_by(Stakeholder.name).all()
    known = {s.name.lower() for s in rows}
    suggested = sorted({p for m in analysed for p in m["people"] if p.lower() not in known})
    return {"stakeholders": [_stakeholder_json(s, analysed, open_items) for s in rows], "suggested": suggested[:20]}


def _get_stakeholder(db: Session, sid: int) -> Stakeholder:
    s = db.get(Stakeholder, sid)
    if not s:
        raise HTTPException(404, "Stakeholder not found")
    return s


@router.post("/stakeholders")
def add_stakeholder(body: StakeholderIn, db: Session = Depends(get_db)):
    if db.query(Stakeholder).filter(func.lower(Stakeholder.name) == body.name.strip().lower()).first():
        raise HTTPException(409, f"{body.name.strip()} is already on your stakeholder map.")
    s = Stakeholder(**{**body.model_dump(), "name": body.name.strip()})
    db.add(s)
    db.commit()
    return {"id": s.id}


@router.put("/stakeholders/{sid}")
def update_stakeholder(sid: int, body: StakeholderIn, db: Session = Depends(get_db)):
    s = _get_stakeholder(db, sid)
    for k, v in body.model_dump().items():
        setattr(s, k, v.strip() if isinstance(v, str) else v)
    s.updated_at = dt.datetime.utcnow()
    db.commit()
    return {"id": s.id}


@router.delete("/stakeholders/{sid}")
def delete_stakeholder(sid: int, db: Session = Depends(get_db)):
    db.delete(_get_stakeholder(db, sid))
    db.commit()
    return {"status": "deleted"}


LEARN_PROMPT = """You maintain a leader's private stakeholder map. From the meeting briefings below (meetings this person attended), infer what this person cares about and how to work with them. Use only evidence in the input; if something isn't supported, write "Unknown".
Reply in exactly this format, each field at most 2 short sentences:
PRIORITIES: <what they care about / are measured on>
PUSHBACK: <how and when they push back>
PERSUADERS: <what evidence or framing moves them>
NOTES: <one practical tip for the leader's next meeting with them>"""


@router.post("/stakeholders/{sid}/learn")
async def learn_stakeholder(sid: int, db: Session = Depends(get_db)):
    s = _get_stakeholder(db, sid)
    mine = _meetings_with(_analysed(db, days=365), s.name)[-8:]
    if not mine:
        raise HTTPException(400, f"No meetings with {s.name} yet. Add them as an attendee on a meeting first.")
    parts = [f"PERSON: {s.name}" + (f" ({s.role})" if s.role else "")]
    for m in mine:
        meeting = m["meeting"]
        parts.append(f"## {m['date']:%Y-%m-%d} · {meeting.title} · {meeting.mode}\n"
                     f"{(meeting.summary or '')[:1500]}\nConcerns raised: {', '.join(m['analysis']['concerns'][:5]) or 'none'}")
    raw = await _ask_llm(LEARN_PROMPT, "\n\n".join(parts)[:24000], max_tokens=400)
    get = lambda k: (re.search(rf"^{k}:\s*(.+)$", raw, re.M | re.I) or [None, ""])[1].strip()   # noqa: E731
    return {"priorities": get("PRIORITIES"), "pushback_style": get("PUSHBACK"),
            "persuaders": get("PERSUADERS"), "notes": get("NOTES"), "meetings_used": len(mine)}


# ---------------------------------------------------------------- pre-meeting brief
class BriefIn(BaseModel):
    title: str = Field("", max_length=200)
    mode: str = Field("General Executive", max_length=80)
    attendees: str = Field("", max_length=1000)
    agenda: str = Field("", max_length=MAX_TEXT)
    use_llm: bool = True


BRIEF_PROMPT = """You write a one-page pre-meeting brief for a senior leader walking into a meeting in two minutes. Use only the context provided. Never invent facts, numbers, owners or history.
Format (plain text, short bullets, under 250 words total):
WALK IN KNOWING
- the 3 most important things to remember from previous meetings with these people
OPEN LOOPS
- commitments still open (who owes what, overdue first) and unresolved questions
PEOPLE
- for each attendee with a profile or signals: what they care about and how to land your point with them
YOUR GAME PLAN
- the outcome to drive, the one question to ask, and the objection to pre-empt
If the context is thin, say so in one bullet and keep the brief short."""


def build_brief_context(db: Session, body: BriefIn) -> tuple[str, list[int]]:
    cfg = _cfg(db)
    leader = cfg.get("leader_name", "")
    attendees = [n for n in la.parse_attendees(body.attendees) if not la.is_mine(n, leader)]
    analysed = _analysed(db, days=180)
    related = [m for m in analysed if any(_matches(p, m["people"]) for p in attendees)] if attendees else []
    if not related:
        cat = la.meeting_category(body.mode, body.title)
        related = [m for m in analysed if m["category"] == cat and m["meeting"].summary]
    related = related[-6:]
    out = [f"UPCOMING: {body.title or 'Meeting'} · {body.mode}" + (f"\nGOAL: {body.agenda}" if body.agenda else ""),
           "ATTENDEES: " + (", ".join(attendees) or "not specified")]
    for m in reversed(related):
        meeting = m["meeting"]
        bits = [f"## {m['date']:%Y-%m-%d} · {meeting.title} ({meeting.mode})"]
        if meeting.summary:
            bits.append("Bottom line: " + _bottom_line(meeting.summary))
            for label, keys in (("Decisions", ("decision",)), ("Open questions", ("open question",)),
                                ("Risks", ("risk", "concern"))):
                items = _section(meeting.summary, *keys)[:4]
                if items:
                    bits.append(f"{label}: " + "; ".join(items))
        if m["analysis"]["concerns"]:
            bits.append("Concerns voiced: " + ", ".join(m["analysis"]["concerns"][:5]))
        if (meeting.notes or "").strip():
            bits.append("My notes: " + meeting.notes.strip()[:500])
        out.append("\n".join(bits))
    ids = [m["id"] for m in related]
    today = _today()
    open_items = [c for c in db.query(Commitment).filter(Commitment.status == "open").all()
                  if c.meeting_id in ids or any(_matches(p, [c.owner or ""]) for p in attendees)]
    if open_items:
        open_items.sort(key=lambda c: c.due_date or dt.date.max)
        out.append("OPEN COMMITMENTS:\n" + "\n".join(
            f"- {c.owner}: {c.action}" + (f" (due {c.due_date}{', OVERDUE' if c.due_date < today else ''})" if c.due_date else "")
            for c in open_items[:12]))
    profiles = [s for s in db.query(Stakeholder).all() if any(_matches(s.name, [p]) for p in attendees)]
    for s in profiles:
        out.append(f"PROFILE {s.name}" + (f" ({s.role})" if s.role else "") + ":\n" + "\n".join(
            f"{k}: {v}" for k, v in (("Priorities", s.priorities), ("Pushback", s.pushback_style),
                                     ("Persuaders", s.persuaders), ("Notes", s.notes)) if v))
    radar = [r for r in la.team_radar([m for m in analysed if m["people"]], today) if r["person"] in attendees and r["flags"]]
    for r in radar:
        out.append(f"SIGNALS {r['person']}: " + "; ".join(r["flags"]))
    return "\n\n".join(out), ids


@router.post("/brief")
async def pre_meeting_brief(body: BriefIn, db: Session = Depends(get_db)):
    context, ids = build_brief_context(db, body)
    brief, error = context, None
    if body.use_llm:
        try:
            brief = await _ask_llm(BRIEF_PROMPT, context[:30000], max_tokens=700)
        except HTTPException as err:
            error = err.detail
    db.add(GeneratedDoc(kind="brief", ref=(body.title or body.mode)[:200], content=brief))
    db.commit()
    return {"brief": brief, "context": context, "meeting_ids": ids, "llm_error": error}


# ---------------------------------------------------------------- growth
class AttributionIn(BaseModel):
    attribution: str


@router.put("/meetings/{meeting_id}/attribution")
def set_attribution(meeting_id: int, body: AttributionIn, db: Session = Depends(get_db)):
    if body.attribution not in ("auto", "verified", "mixed", "exclude"):
        raise HTTPException(400, "Attribution must be auto, verified, mixed or exclude.")
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    m.attribution = None if body.attribution == "auto" else body.attribution
    db.commit()
    return {"meeting_id": meeting_id, "attribution": m.attribution or "auto"}


def _practice(db: Session, fillers: list[str]) -> dict:
    """Speech that is certainly yours: rehearsal answers and teleprompter runs."""
    sessions = []
    for r in db.query(Rehearsal).filter(Rehearsal.scores.isnot(None)).order_by(Rehearsal.created_at.asc()).all():
        s = json.loads(r.scores)
        sessions.append({"kind": "rehearsal", "date": r.created_at.date().isoformat(), "title": r.persona,
                         "stats": s.get("stats", {}), "scores": s.get("scores", {})})
    for run in db.query(ScriptRun).order_by(ScriptRun.started_at.asc()).all():
        words = (run.avg_wpm or 0) * (run.duration_s or 0) / 60
        sessions.append({"kind": "teleprompter", "date": run.started_at.date().isoformat(),
                         "title": run.script.title if run.script else "Script",
                         "stats": {"wpm": run.avg_wpm, "filler_rate": round(100 * run.fillers / words, 2) if words >= 50 else None,
                                   "coverage_pct": run.coverage_pct}})
    sessions.sort(key=lambda s: s["date"])
    return {"sessions": sessions[-40:], "count": len(sessions)}


@router.get("/growth")
def growth(include_mixed: bool = False, days: int = 365, db: Session = Depends(get_db)):
    analysed = _analysed(db, days=days)
    report = la.growth_report(analysed, include_mixed=include_mixed)
    report["meetings"] = [{"id": m["id"], "title": m["title"], "date": m["date"].isoformat(),
                           "category": m["category"], "category_label": la.CATEGORY_LABELS.get(m["category"]),
                           "attribution": m["attribution"], "override": m["override"] or "auto",
                           "confidence": m["confidence"], "me_words": m["stats"]["me_words"]}
                          for m in reversed(analysed)]
    report["practice"] = _practice(db, _fillers(_cfg(db)))
    return report


def _practice_key(meeting_id: int | None, original: str) -> str:
    return hashlib.sha1(f"{meeting_id}|{original.strip()}".encode()).hexdigest()[:16]


@router.get("/growth/say-it-better")
def say_it_better(days: int = 7, db: Session = Depends(get_db)):
    """Your three weakest moments recently, each with a stronger executive version to practise."""
    items: list[dict] = []
    for window in (days, 30, 90):
        analysed = [m for m in _analysed(db, days=window) if m["category"] != "learning" and m["attribution"] != "exclude"]
        cands = []
        for m in analysed:
            trust = 1 if m["attribution"] == "verified" else 0
            for r in la.parse_reroutes(m["meeting"].strategic_alternatives):
                cands.append({**r, "meeting_id": m["id"], "meeting_title": m["title"], "date": m["date"].date().isoformat(),
                              "attribution": m["attribution"], "rank": (trust, 2, m["date"])})
            for w in m["analysis"]["weakest"]:
                cands.append({"original": w["text"], "better": None, "why": f"{w['score']} hedges/fillers/preamble markers",
                              "meeting_id": m["id"], "meeting_title": m["title"], "date": m["date"].date().isoformat(),
                              "attribution": m["attribution"], "rank": (trust, 1 + min(w["score"], 9) / 10, m["date"])})
        if len(cands) >= 3 or window == 90:
            cands.sort(key=lambda c: c["rank"], reverse=True)
            seen, items = set(), []
            for c in cands:
                k = _practice_key(c["meeting_id"], c["original"])
                if k in seen:
                    continue
                seen.add(k)
                p = db.query(PracticeItem).filter(PracticeItem.key == k).first()
                if p and p.practiced_at and len(cands) > 6:
                    continue   # already practised: show something new
                c.pop("rank")
                items.append({**c, "key": k, "better": (p.better if p and p.better else c["better"]),
                              "practiced": bool(p and p.practiced_at)})
                if len(items) == 3:
                    break
            break
    return {"items": items}


class RewriteIn(BaseModel):
    original: str = Field(..., min_length=1, max_length=2000)
    meeting_id: int | None = None


REWRITE_PROMPT = """Rewrite what a senior leader said in a meeting so it sounds like a confident, authentic executive: bottom line first, specific, no hedges or filler, warm but direct, natural spoken English (not corporate jargon), at most 2 sentences. Keep the meaning and any facts; never add new facts or numbers.
Reply with exactly:
BETTER: <the rewrite>
WHY: <what changed, max 15 words>"""


@router.post("/growth/say-it-better/rewrite")
async def rewrite_line(body: RewriteIn, db: Session = Depends(get_db)):
    raw = await _ask_llm(REWRITE_PROMPT, body.original, max_tokens=200, temperature=0.4)
    better = (re.search(r"BETTER:\s*(.+)", raw) or [None, raw.splitlines()[0]])[1].strip().strip('"“”')
    why = (re.search(r"WHY:\s*(.+)", raw) or [None, ""])[1].strip()
    key = _practice_key(body.meeting_id, body.original)
    p = db.query(PracticeItem).filter(PracticeItem.key == key).first()
    if not p:
        p = PracticeItem(key=key, meeting_id=body.meeting_id, original=body.original)
        db.add(p)
    p.better = better
    db.commit()
    return {"key": key, "better": better, "why": why}


class PracticeIn(BaseModel):
    original: str = Field(..., min_length=1, max_length=2000)
    better: str | None = Field(None, max_length=2000)
    meeting_id: int | None = None
    practiced: bool = True


@router.post("/growth/practice")
def mark_practiced(body: PracticeIn, db: Session = Depends(get_db)):
    key = _practice_key(body.meeting_id, body.original)
    p = db.query(PracticeItem).filter(PracticeItem.key == key).first()
    if not p:
        p = PracticeItem(key=key, meeting_id=body.meeting_id, original=body.original)
        db.add(p)
    if body.better:
        p.better = body.better
    p.practiced_at = dt.datetime.utcnow() if body.practiced else None
    db.commit()
    return {"key": key, "practiced": body.practiced}


# ---------------------------------------------------------------- team radar
@router.get("/team/radar")
def radar(days: int = 120, db: Session = Depends(get_db)):
    analysed = [m for m in _analysed(db, days=days) if m["category"] != "learning"]
    with_people = [m for m in analysed if m["people"]]
    today = _today()
    return {"people": la.team_radar(with_people, today), "rising_concerns": la.team_concerns(analysed, today),
            "coverage": {"meetings": len(analysed), "with_attendees": len(with_people)}}


# ---------------------------------------------------------------- weekly digest & narrative check
class DigestIn(BaseModel):
    days: int = Field(7, ge=1, le=31)


DIGEST_PROMPT = """You are the chief of staff writing a senior leader's weekly executive digest from their own meeting records. It must be forwardable: crisp, factual, no fluff. Use only the input; never invent facts, names, numbers or dates.
Format (plain text, Markdown headings with ##, short bullets, under 400 words):
## Week in one line
## Themes
## Decisions made
## Risks & watch items
## Pending decisions & open loops (owner, due; overdue first)
## Team pulse
## My communication this week (one strength, one focus, from the stats; skip if no stats)
Leave out any section with no content."""


@router.post("/digest/weekly")
async def weekly_digest(body: DigestIn, db: Session = Depends(get_db)):
    today = _today()
    analysed = [m for m in _analysed(db, days=body.days) if m["category"] != "learning"]
    if not analysed:
        raise HTTPException(400, f"No meetings in the last {body.days} days.")
    parts = [f"PERIOD: {today - dt.timedelta(days=body.days)} to {today}", f"MEETINGS: {len(analysed)}"]
    for m in analysed:
        meeting = m["meeting"]
        bits = [f"## {m['date']:%a %Y-%m-%d} · {meeting.title} ({meeting.mode})"]
        if meeting.summary:
            bits.append("Bottom line: " + _bottom_line(meeting.summary))
            for label, keys in (("Decisions", ("decision",)), ("Risks", ("risk", "concern")), ("Open questions", ("open question",))):
                items = _section(meeting.summary, *keys)[:4]
                if items:
                    bits.append(f"{label}: " + "; ".join(items))
        else:
            live = db.query(MeetingItem).filter(MeetingItem.meeting_id == m["id"]).limit(8).all()
            if live:
                bits.append("Tracked live: " + "; ".join(f"{i.kind}: {i.text}" for i in live))
        if m["analysis"]["concerns"]:
            bits.append("Concerns voiced: " + ", ".join(m["analysis"]["concerns"][:5]))
        parts.append("\n".join(bits))
    rem = reminders(db)
    open_items = [c for c in list_commitments("open", None, db)][:25]
    if open_items:
        parts.append("OPEN COMMITMENTS:\n" + "\n".join(
            f"- {c['owner']}: {c['action']}" + (f" (due {c['due_date']}{', OVERDUE' if c['overdue'] else ''})" if c['due_date'] else "")
            for c in open_items))
    done = db.query(Commitment).filter(Commitment.completed_at >= dt.datetime.utcnow() - dt.timedelta(days=body.days)).count()
    parts.append(f"COMMITMENTS CLOSED THIS PERIOD: {done}; MY OVERDUE: {len(rem['overdue'])}; OTHERS SLIPPING: {len(rem['slipping'])}")
    radar_people = la.team_radar([m for m in _analysed(db, days=120) if m["people"]], today)
    flags = [f"{r['person']}: {'; '.join(r['flags'])}" for r in radar_people if r["flags"]][:8]
    rising = la.team_concerns([m for m in _analysed(db, days=60)], today, days=body.days)
    if flags or rising:
        parts.append("TEAM SIGNALS:\n" + "\n".join(f"- {f}" for f in flags)
                     + ("\nRising concern topics: " + ", ".join(r["term"] for r in rising) if rising else ""))
    g = la.growth_report(analysed, include_mixed=True)
    if g["focus"]:
        parts.append("COMMUNICATION FOCUS (vs. targets): " + "; ".join(
            f"{f['label']}: {f['recent']} (target {f['target']})" for f in g["focus"]))
    content = await _ask_llm(DIGEST_PROMPT, "\n\n".join(parts)[:40000], max_tokens=1100)
    doc = GeneratedDoc(kind="digest", ref=f"{today - dt.timedelta(days=body.days)}..{today}", content=content)
    db.add(doc)
    db.commit()
    return {"id": doc.id, "content": content, "ref": doc.ref, "created_at": doc.created_at.isoformat()}


class NarrativeIn(BaseModel):
    days: int = Field(30, ge=7, le=180)
    topics: str = Field("", max_length=500)


DEFAULT_TOPICS = ["strategy", "priority", "priorities", "roadmap", "headcount", "hiring", "budget", "reorg",
                  "layoff", "layoffs", "okr", "okrs", "goal", "goals", "timeline", "vision", "investment", "cost", "costs"]

NARRATIVE_PROMPT = """You check a senior leader's message consistency across audiences. Below are things the leader ("Me") said about key topics in different meetings, grouped by meeting and audience. Some lines may have been picked up from other people in the room; ignore lines that clearly aren't the leader's position.
Find where the leader's message on the same topic differs between audiences: different numbers, dates, priorities, commitments, tone (e.g. confident with execs, uncertain with the team), or promises that conflict.
Reply in plain text with Markdown:
## Consistent messages
- topic: the line held everywhere (max 3)
## Drift to fix
- **Topic** — what was said to whom (quote briefly, with meeting date) vs what was said elsewhere; why it matters; the one line to align on
## Suggested core narrative
3 bullets the leader can repeat to every audience.
Only report drift that is supported by quotes in the input. If there is none, say so."""


@router.post("/narrative/check")
async def narrative_check(body: NarrativeIn, db: Session = Depends(get_db)):
    cfg = _cfg(db)
    topics = [t.strip().lower() for t in re.split(r"[,;\n]+", body.topics) if t.strip()] or DEFAULT_TOPICS + sorted(_jargon(cfg))
    rx = re.compile(r"\b(" + "|".join(re.escape(t) for t in topics) + r")\b", re.I)
    analysed = [m for m in _analysed(db, days=body.days) if m["category"] != "learning" and m["attribution"] != "exclude"]
    blocks, total = [], 0
    for m in analysed:
        lines = [t.text.strip() for t in db.query(Transcript).filter(
            Transcript.meeting_id == m["id"], Transcript.speaker.in_(tuple(la.ME_SPEAKERS))).order_by(Transcript.id).all()
            if rx.search(t.text or "") and len((t.text or "").split()) >= 8]
        if not lines:
            continue
        audience = la.CATEGORY_LABELS.get(m["category"], m["category"]) + (f"; with {', '.join(m['people'])}" if m["people"] else "")
        block = f"## {m['date']:%Y-%m-%d} · {m['title']} · audience: {audience}\n" + "\n".join(f"- \"{ln[:300]}\"" for ln in lines[:12])
        blocks.append(block)
        total += len(block)
        if total > 36000:
            break
    if len(blocks) < 2:
        raise HTTPException(400, f"Need at least two meetings in the last {body.days} days where you spoke about these topics.")
    content = await _ask_llm(NARRATIVE_PROMPT, f"TOPICS: {', '.join(topics[:30])}\n\n" + "\n\n".join(blocks), max_tokens=1100)
    doc = GeneratedDoc(kind="narrative", ref=f"last {body.days} days", content=content)
    db.add(doc)
    db.commit()
    return {"id": doc.id, "content": content, "ref": doc.ref, "created_at": doc.created_at.isoformat(), "meetings": len(blocks)}


@router.get("/generated-docs")
def list_docs(kind: str, limit: int = 10, db: Session = Depends(get_db)):
    rows = db.query(GeneratedDoc).filter(GeneratedDoc.kind == kind).order_by(GeneratedDoc.created_at.desc()).limit(min(limit, 50)).all()
    return [{"id": d.id, "kind": d.kind, "ref": d.ref, "content": d.content, "created_at": d.created_at.isoformat()} for d in rows]


@router.delete("/generated-docs/{doc_id}")
def delete_doc(doc_id: int, db: Session = Depends(get_db)):
    db.query(GeneratedDoc).filter(GeneratedDoc.id == doc_id).delete()
    db.commit()
    return {"status": "deleted"}


# ---------------------------------------------------------------- rehearsal (role-play)
PERSONAS: dict[str, tuple[str, str]] = {
    "skeptical_cfo": ("Skeptical CFO", "a skeptical CFO. You probe ROI, cost, payback period and downside risk, and you ask for numbers when answers are vague."),
    "board_member": ("Board member", "an experienced independent board member. You ask about strategy, competition, why now, key risks and what would prove the plan wrong."),
    "ceo": ("Time-poor CEO", "the CEO, with five minutes. You want the bottom line first and cut off rambling: 'What do you need from me?'"),
    "upset_report": ("Upset direct report", "a capable direct report who feels overlooked for a promotion. You are emotional and want to be heard; you escalate if dismissed and calm down if genuinely acknowledged."),
    "peer_conflict": ("Peer who disagrees", "a peer leader who disagrees with the plan because it costs your team headcount. You defend your turf but can be won over by a shared goal."),
    "customer_exec": ("Demanding customer exec", "a demanding customer executive after a service incident. You want accountability, a concrete fix and a date, not excuses."),
    "vendor": ("Vendor pushing a renewal", "a vendor account executive pushing a renewal with a price increase. You use urgency and anchoring; you concede only for commitments."),
    "all_hands": ("All-hands audience Q&A", "employees at an all-hands Q&A. You ask the hard questions people whisper about: job security, strategy changes, workload and culture. Change who is asking each time."),
}

PERSONA_RULES = """You are role-playing {who} in a practice conversation with a senior leader who is rehearsing to become a more confident, authentic executive communicator.
Rules:
- Stay in character. Never coach, never break character, never mention you are an AI. No stage directions.
- Speak like a real person in a meeting: 1-3 sentences, one question or challenge at a time.
- React to the quality of the last answer: if it was vague, hedged or evasive, press harder on that point; if it was clear, answer-first and specific, acknowledge it briefly and move to the next hard question.
- Stay realistic and tough but fair.
SCENARIO: {scenario}"""

SCORECARD_PROMPT = """You are an executive communication coach reviewing a practice conversation. "ME" is the leader; "THEM" is the role-play partner. Judge only ME.
Reply in exactly this format:
SCORES: clarity=<1-10>, confidence=<1-10>, listening=<1-10>, persuasion=<1-10>, presence=<1-10>
STRENGTHS:
- <specific, quote a short phrase>
- <specific>
FIXES:
- <what to change> → try: "<a better line ME could have said, natural spoken English>"
- <what to change> → try: "<better line>"
- <what to change> → try: "<better line>"
NEXT DRILL: <one exercise for the next rehearsal, one sentence>
Clarity = answer first and structured; confidence = no hedging, owns a position; listening = acknowledges and builds on what THEM said; persuasion = evidence and framing; presence = calm, concise, authentic."""


class RehearsalIn(BaseModel):
    persona: str = Field(..., max_length=40)
    scenario: str = Field("", max_length=2000)
    custom_persona: str = Field("", max_length=500)


class TurnIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


def _persona(r: Rehearsal) -> str:
    if r.persona in PERSONAS:
        return PERSONAS[r.persona][1]
    return r.persona   # custom description


def _rehearsal_json(r: Rehearsal) -> dict:
    label = PERSONAS[r.persona][0] if r.persona in PERSONAS else r.persona[:60]
    return {"id": r.id, "persona": r.persona, "persona_label": label, "scenario": r.scenario, "turns": json.loads(r.turns or "[]"),
            "scores": json.loads(r.scores) if r.scores else None, "feedback": r.feedback,
            "created_at": r.created_at.isoformat() if r.created_at else None}


def _conversation(turns: list[dict]) -> str:
    return "\n".join(f"{'ME' if t['role'] == 'me' else 'THEM'}: {t['text']}" for t in turns)


def _turn_feedback(text: str, previous: str | None, fillers: list[str]) -> dict:
    lines = ([la.Line("Participant", previous)] if previous else []) + [la.Line("Me", text)]
    s = la.analyze_meeting(lines, fillers, override="verified")["stats"]
    first = (la._sentences(text) or [text])[0]
    tips = []
    if s["hedge_rate"] and s["hedge_rate"] > 3:
        tips.append("Drop the hedges and own the position.")
    if s["filler_rate"] and s["filler_rate"] > 4:
        tips.append("Pause instead of filler words.")
    if len(la._words(first)) > 25 or la.PREAMBLE.match(first):
        tips.append("Lead with the answer in the first sentence.")
    if s["me_words"] > 160:
        tips.append("Tighter: land it in under 60 seconds.")
    return {"words": s["me_words"], "hedge_rate": s["hedge_rate"], "filler_rate": s["filler_rate"],
            "answer_first": not (len(la._words(first)) > 25 or la.PREAMBLE.match(first) or la._HEDGE_RE.search(first.lower())),
            "tips": tips}


def _get_rehearsal(db: Session, rid: int) -> Rehearsal:
    r = db.get(Rehearsal, rid)
    if not r:
        raise HTTPException(404, "Rehearsal not found")
    return r


@router.get("/rehearsals/personas")
def personas():
    return [{"id": k, "label": v[0], "description": v[1]} for k, v in PERSONAS.items()]


@router.get("/rehearsals")
def list_rehearsals(db: Session = Depends(get_db)):
    rows = db.query(Rehearsal).order_by(Rehearsal.created_at.desc()).limit(50).all()
    return [{k: v for k, v in _rehearsal_json(r).items() if k != "turns"} | {"turns": len(json.loads(r.turns or "[]"))} for r in rows]


@router.get("/rehearsals/{rid}")
def get_rehearsal(rid: int, db: Session = Depends(get_db)):
    return _rehearsal_json(_get_rehearsal(db, rid))


@router.delete("/rehearsals/{rid}")
def delete_rehearsal(rid: int, db: Session = Depends(get_db)):
    db.delete(_get_rehearsal(db, rid))
    db.commit()
    return {"status": "deleted"}


@router.post("/rehearsals")
async def start_rehearsal(body: RehearsalIn, db: Session = Depends(get_db)):
    persona = body.persona if body.persona in PERSONAS else body.custom_persona.strip()
    if not persona:
        raise HTTPException(400, "Pick a persona or describe one.")
    scenario = body.scenario.strip() or "A routine but high-stakes conversation about the leader's current top priority."
    system = PERSONA_RULES.format(who=PERSONAS[persona][1] if persona in PERSONAS else persona, scenario=scenario)
    opening = await _ask_llm(system, "Open the conversation with your first question or challenge.", max_tokens=160, temperature=0.8)
    r = Rehearsal(persona=persona, scenario=scenario, turns=json.dumps([{"role": "them", "text": opening}]))
    db.add(r)
    db.commit()
    return _rehearsal_json(r)


@router.post("/rehearsals/{rid}/turn")
async def rehearsal_turn(rid: int, body: TurnIn, db: Session = Depends(get_db)):
    r = _get_rehearsal(db, rid)
    turns = json.loads(r.turns or "[]")
    if len(turns) >= 40:
        raise HTTPException(400, "This rehearsal is long enough. Finish it to get your scorecard.")
    previous = next((t["text"] for t in reversed(turns) if t["role"] == "them"), None)
    feedback = _turn_feedback(body.text, previous, _fillers(_cfg(db)))
    turns.append({"role": "me", "text": body.text.strip(), "feedback": feedback})
    system = PERSONA_RULES.format(who=_persona(r), scenario=r.scenario)
    reply = await _ask_llm(system, _conversation(turns[-16:]) + "\n\nReply as THEM, in character.", max_tokens=160, temperature=0.8)
    reply = re.sub(r"^\s*THEM:\s*", "", reply)
    turns.append({"role": "them", "text": reply})
    r.turns, r.updated_at = json.dumps(turns), dt.datetime.utcnow()
    db.commit()
    return {"reply": reply, "feedback": feedback}


@router.post("/rehearsals/{rid}/finish")
async def finish_rehearsal(rid: int, db: Session = Depends(get_db)):
    r = _get_rehearsal(db, rid)
    turns = json.loads(r.turns or "[]")
    if not any(t["role"] == "me" for t in turns):
        raise HTTPException(400, "Answer at least once before finishing.")
    lines = [la.Line("Me" if t["role"] == "me" else "Participant", t["text"]) for t in turns]
    stats = la.analyze_meeting(lines, _fillers(_cfg(db)), override="verified")["stats"]
    raw = await _ask_llm(SCORECARD_PROMPT, f"SCENARIO: {r.scenario}\n\n{_conversation(turns)}"[:30000], max_tokens=700)
    scores = {}
    m = re.search(r"SCORES:\s*(.+)", raw)
    if m:
        for k, v in re.findall(r"(\w+)\s*=\s*(\d+(?:\.\d+)?)", m[1]):
            scores[k.lower()] = min(10.0, float(v))
    r.scores = json.dumps({"stats": stats, "scores": scores})
    r.feedback = re.sub(r"^\s*SCORES:.*\n?", "", raw, count=1, flags=re.M).strip()
    r.updated_at = dt.datetime.utcnow()
    db.commit()
    return _rehearsal_json(r)
