"""Calendar: today's meetings from a published ICS feed (Outlook, Google Calendar, iCloud).

The feed URL works like a password (anyone with it can read your calendar), so it is kept in the OS
credential store, never in the database or returned to the UI. Events are fetched on demand, parsed in
memory and cached for a few minutes; nothing from the calendar is written to disk.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import secure_store
from database import AppConfig, get_db

logger = logging.getLogger(__name__)
router = APIRouter()

SECRET = "calendar_ics_url"
CACHE_S = 300
MAX_BYTES = 15 * 2**20
_cache: dict = {"at": 0.0, "ics": None, "error": None, "synced_at": None}

JOIN_RE = re.compile(r"https://[^\s<>\"']*(?:zoom\.us/j|teams\.microsoft\.com/l/meetup-join|teams\.live\.com/meet|"
                     r"meet\.google\.com|webex\.com/(?:meet|join)|chime\.aws)[^\s<>\"']*", re.I)


def normalize_url(url: str) -> str:
    url = url.strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.netloc:
        raise ValueError("Use the calendar's secret https:// (or webcal://) ICS address.")
    if len(url) > 2048 or any(c in url for c in "\r\n "):
        raise ValueError("That doesn't look like a calendar address.")
    return url


def connected() -> bool:
    return bool(secure_store.get_secret(SECRET))


async def _fetch(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True, max_redirects=5) as client:
        async with client.stream("GET", url, headers={"Accept": "text/calendar"}) as res:
            if str(res.url).split(":", 1)[0] != "https":
                raise ValueError("The calendar redirected to a non-https address.")
            if res.status_code >= 400:
                raise ValueError(f"The calendar server answered HTTP {res.status_code}. Check the address is still published.")
            body = b""
            async for chunk in res.aiter_bytes():
                body += chunk
                if len(body) > MAX_BYTES:
                    raise ValueError("The calendar feed is too large (over 15 MB).")
    if b"BEGIN:VCALENDAR" not in body[:4096]:
        raise ValueError("That address didn't return a calendar (ICS) file.")
    return body


async def _calendar(force: bool = False):
    import icalendar
    url = secure_store.get_secret(SECRET)
    if not url:
        return None
    if not force and _cache["ics"] is not None and time.time() - _cache["at"] < CACHE_S:
        return _cache["ics"]
    try:
        body = await _fetch(url)
        _cache.update(ics=icalendar.Calendar.from_ical(body), at=time.time(), error=None,
                      synced_at=dt.datetime.now().astimezone().isoformat(timespec="seconds"))
    except (httpx.HTTPError, ValueError) as err:
        msg = str(err) if isinstance(err, ValueError) else f"Couldn't reach the calendar ({type(err).__name__})."
        _cache.update(error=msg, at=time.time())
        logger.warning("calendar sync failed: %s", msg)
        if _cache["ics"] is None:
            raise HTTPException(502, msg)
    return _cache["ics"]


def _name(addr) -> str:
    cn = str(addr.params.get("CN", "")).strip().strip('"') if hasattr(addr, "params") else ""
    if cn and "@" not in cn:
        return cn
    email = str(addr).split(":", 1)[-1]
    local = email.split("@")[0]
    return " ".join(p.capitalize() for p in re.split(r"[._-]+", local) if p) or email


def _local(v) -> tuple[dt.datetime, bool]:
    if isinstance(v, dt.datetime):
        return (v if v.tzinfo else v.replace(tzinfo=dt.datetime.now().astimezone().tzinfo)).astimezone(), False
    return dt.datetime.combine(v, dt.time()).astimezone(), True


def events_on(cal, day: dt.date, leader: str = "") -> list[dict]:
    import recurring_ical_events
    start = dt.datetime.combine(day, dt.time()).astimezone()
    out = []
    for ev in recurring_ical_events.of(cal).between(start, start + dt.timedelta(days=1)):
        cancelled = str(ev.get("STATUS", "")).upper() == "CANCELLED"
        free_hold = str(ev.get("TRANSP", "")).upper() == "TRANSPARENT" and not ev.get("ATTENDEE")
        if cancelled or free_hold:
            continue
        s, all_day = _local(ev.decoded("DTSTART"))
        e = _local(ev.decoded("DTEND"))[0] if ev.get("DTEND") else s + (ev.decoded("DURATION") if ev.get("DURATION") else dt.timedelta(hours=1))
        attendees = ev.get("ATTENDEE") or []
        if not isinstance(attendees, list):
            attendees = [attendees]
        names, seen = [], set()
        me = leader.strip().lower()
        for a in attendees + ([ev["ORGANIZER"]] if ev.get("ORGANIZER") else []):
            n = _name(a)
            if n.lower() in seen or (me and (n.lower() == me or n.lower().split()[0] == me.split()[0])):
                continue
            seen.add(n.lower())
            names.append(n)
        desc = str(ev.get("DESCRIPTION", "") or "")
        loc = str(ev.get("LOCATION", "") or "")
        join = JOIN_RE.search(f"{loc}\n{desc}\n{ev.get('URL', '')}")
        out.append({
            "uid": str(ev.get("UID", "")) + "@" + s.isoformat(),
            "title": str(ev.get("SUMMARY", "") or "(no title)").strip()[:200],
            "start": s.isoformat(), "end": e.isoformat(), "all_day": all_day,
            "attendees": names[:30], "location": loc[:200],
            "agenda": re.sub(r"\n{3,}", "\n\n", desc).strip()[:1500],
            "join_url": join.group(0) if join else None,
        })
    return sorted(out, key=lambda x: (not x["all_day"], x["start"]))


class SourceIn(BaseModel):
    url: str = Field(..., min_length=10, max_length=2048)


@router.get("/calendar/status")
def status():
    return {"connected": connected(), "synced_at": _cache["synced_at"], "error": _cache["error"]}


@router.put("/calendar/source")
async def set_source(body: SourceIn):
    try:
        url = normalize_url(body.url)
        import icalendar
        icalendar.Calendar.from_ical(await _fetch(url))
    except ValueError as err:
        raise HTTPException(400, str(err))
    except httpx.HTTPError as err:
        raise HTTPException(400, f"Couldn't reach that address ({type(err).__name__}).")
    secure_store.set_secret(SECRET, url)
    _cache.update(at=0.0, ics=None, error=None, synced_at=None)
    return status()


@router.delete("/calendar/source")
def clear_source():
    secure_store.set_secret(SECRET, None)
    _cache.update(at=0.0, ics=None, error=None, synced_at=None)
    return status()


@router.get("/calendar/events")
async def events(date: str | None = None, refresh: bool = False, db: Session = Depends(get_db)):
    if not connected():
        return {"connected": False, "events": []}
    try:
        day = dt.date.fromisoformat(date) if date else dt.date.today()
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")
    cal = await _calendar(force=refresh)
    row = db.query(AppConfig).filter(AppConfig.key == "leader_name").first()
    return {"connected": True, "date": day.isoformat(), "events": events_on(cal, day, row.value if row else ""),
            "synced_at": _cache["synced_at"], "error": _cache["error"]}
