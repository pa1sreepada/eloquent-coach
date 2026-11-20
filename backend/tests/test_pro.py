"""Health diagnostics, LLM timing, calendar feed parsing and global search, against a throwaway database.
The OS credential store is stubbed so nothing touches the real Keychain."""
import asyncio, datetime as dt, os, sys, tempfile, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(tempfile.mkdtemp())
os.environ["ELOQUENT_STATE_DIR"] = os.getcwd()
os.environ["ELOQUENT_API_TOKEN"] = TOKEN = "t" * 64
_vault: dict = {}
sys.modules["keyring"] = types.SimpleNamespace(
    get_password=lambda s, a: _vault.get(a), set_password=lambda s, a, v: _vault.__setitem__(a, v),
    delete_password=lambda s, a: _vault.pop(a, None), get_keyring=lambda: object())

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import calendar_feed as cf
import health
import main
import perf
from database import Base, Commitment, Meeting, Stakeholder, Transcript

# ---------------------------------------------------------------- perf
assert perf.parse_swapusage("total = 20480.00M  used = 19456.50M  free = 1023.50M  (encrypted)") == 19.0
assert perf.parse_swapusage("total = 0.00M  used = 0.00M  free = 0.00M") == 0.0 and perf.parse_swapusage("") is None


async def timed():
    async with perf.Timer("coach"):
        await asyncio.sleep(0)
    try:
        async with perf.Timer("coach"):
            raise RuntimeError
    except RuntimeError:
        pass
    try:
        async with perf.Timer("coach"):
            raise asyncio.CancelledError   # preempted cards aren't counted
    except asyncio.CancelledError:
        pass
asyncio.run(timed())
s = perf.llm_summary("coach")
assert s["calls"] == 2 and s["failures"] == 1 and s["p50_s"] is not None, s
perf.reset()

# ---------------------------------------------------------------- assess
ok_llm = {"reachable": True, "message": ""}
idle = {"calls": 0, "failures": 0, "p50_s": None, "p90_s": None}
mem_ok = {"pressure": "normal", "swap_used_gb": 0.5}
assert health.assess(ok_llm, idle, idle, mem_ok, None) == ("good", [])
status, issues = health.assess({"reachable": False, "message": "refused"}, idle, idle, mem_ok, None)
assert status == "problem" and "LM Studio" in issues[0]["fix"]
# The 25-minute meeting with one card: slow calls timing out under 19 GB swap.
status, issues = health.assess(ok_llm, {"calls": 6, "failures": 5, "p50_s": 18, "p90_s": 19}, {"calls": 2, "failures": 0, "p50_s": 70, "p90_s": 80},
                               {"pressure": "warning", "swap_used_gb": 19.0}, 3200)
titles = [i["title"] for i in issues]
assert status == "problem" and any("5 of the last 6" in t for t in titles) and any("very low on memory" in t for t in titles), titles
assert any("Summaries" in t for t in titles) and any("lagging" in t for t in titles)
assert health.assess(ok_llm, {"calls": 4, "failures": 0, "p50_s": 10, "p90_s": 15}, idle, mem_ok, None)[0] == "warning"

# ---------------------------------------------------------------- calendar parsing
assert cf.normalize_url("webcal://p01-caldav.icloud.com/x/y.ics") == "https://p01-caldav.icloud.com/x/y.ics"
for bad in ("http://example.com/cal.ics", "file:///etc/passwd", "https://", "https://a.com/x y"):
    try:
        cf.normalize_url(bad)
        raise AssertionError(bad)
    except ValueError:
        pass

ICS = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:standup
DTSTART:20261116T150000Z
DTEND:20261116T151500Z
RRULE:FREQ=DAILY;COUNT=10
SUMMARY:Team sync
ORGANIZER;CN=Pavan S:mailto:pavan@example.com
ATTENDEE;CN=Sarah Lee:mailto:sarah@example.com
ATTENDEE:mailto:raj.kumar@example.com
DESCRIPTION:Agenda: peak readiness\\nJoin: https://acme.zoom.us/j/123456?pwd=abc
END:VEVENT
BEGIN:VEVENT
UID:cancelled
DTSTART:20261120T170000Z
DTEND:20261120T180000Z
STATUS:CANCELLED
SUMMARY:Old review
END:VEVENT
BEGIN:VEVENT
UID:hold
DTSTART:20261120T190000Z
DTEND:20261120T200000Z
TRANSP:TRANSPARENT
SUMMARY:Focus time
END:VEVENT
BEGIN:VEVENT
UID:allday
DTSTART;VALUE=DATE:20261120
DTEND;VALUE=DATE:20261121
SUMMARY:Peak freeze
END:VEVENT
END:VCALENDAR
"""
import icalendar
cal = icalendar.Calendar.from_ical(ICS)
evs = cf.events_on(cal, dt.date(2026, 11, 20), leader="Pavan")
assert [e["title"] for e in evs] == ["Peak freeze", "Team sync"], evs
sync = evs[1]
assert sync["attendees"] == ["Sarah Lee", "Raj Kumar"], sync["attendees"]   # the leader is left out
assert sync["join_url"] == "https://acme.zoom.us/j/123456?pwd=abc" and "peak readiness" in sync["agenda"]
assert evs[0]["all_day"] and not sync["all_day"]
assert dt.datetime.fromisoformat(sync["end"]) - dt.datetime.fromisoformat(sync["start"]) == dt.timedelta(minutes=15)
assert cf.events_on(cal, dt.date(2026, 11, 30)) == []   # the recurrence ended

# ---------------------------------------------------------------- API
engine = create_engine(f"sqlite:///{os.path.join(os.getcwd(), 'test.db')}", connect_args={"check_same_thread": False})
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)


def override_db():
    db = Session()
    try:
        yield db
    finally:
        db.close()


main.app.dependency_overrides[main.get_db] = override_db
client = TestClient(main.app, base_url="http://127.0.0.1:8000", headers={"Authorization": f"Bearer {TOKEN}"})

fetched = []


async def fake_fetch(url):
    fetched.append(url)
    if "broken" in url:
        raise ValueError("That address didn't return a calendar (ICS) file.")
    return ICS
cf._fetch = fake_fetch

assert client.get("/calendar/events").json() == {"connected": False, "events": []}
assert client.put("/calendar/source", json={"url": "https://cal.example.com/broken.ics"}).status_code == 400
assert client.put("/calendar/source", json={"url": "http://cal.example.com/x.ics"}).status_code == 400
r = client.put("/calendar/source", json={"url": "webcal://cal.example.com/secret.ics"})
assert r.status_code == 200 and r.json()["connected"], r.text
assert _vault["calendar_ics_url"] == "https://cal.example.com/secret.ics"
assert "secret" not in r.text   # the URL is never returned
ev = client.get("/calendar/events", params={"date": "2026-11-20"}).json()
assert [e["title"] for e in ev["events"]] == ["Peak freeze", "Team sync"] and ev["synced_at"], ev
n = len(fetched)
client.get("/calendar/events", params={"date": "2026-11-19"})
assert len(fetched) == n   # cached
client.get("/calendar/events", params={"date": "2026-11-19", "refresh": True})
assert len(fetched) == n + 1
assert client.get("/calendar/events", params={"date": "nope"}).status_code == 400

# Diagnostics: checklist reflects the calendar; no LLM server in tests → unreachable is reported.
d = client.get("/health/diagnostics").json()
steps = {s["id"]: s["done"] for s in d["setup"]}
assert steps["calendar"] is True and steps["name"] is False and steps["voice"] is False, steps
assert d["status"] == "problem" and not d["llm"]["reachable"] and "memory" in d and "llm_calls" in d
assert client.delete("/calendar/source").json()["connected"] is False and "calendar_ics_url" not in _vault

# Wizard name step saves just the name, even before any other setting exists.
assert client.put("/settings/leader-name", json={"leader_name": "  Pavan   S "}).json()["leader_name"] == "Pavan S"
assert {s["id"]: s["done"] for s in client.get("/health/diagnostics").json()["setup"]}["name"] is True

# Search
db = Session()
m1 = Meeting(title="Peak readiness review", attendees="Sarah Lee", summary="**Bottom line:** ArgoCD rollout is on track",
             start_time=dt.datetime(2026, 11, 18, 15))
m2 = Meeting(title="1:1 Raj", notes="Raj wants the Aviator 50% rollout", start_time=dt.datetime(2026, 11, 19, 15))
db.add_all([m1, m2]); db.flush()
db.add_all([Transcript(meeting_id=m1.id, speaker="Participant", text="the ArgoCD sync failed twice in STG last week"),
            Transcript(meeting_id=m1.id, speaker="Me", text="let's get ArgoCD fixed before the freeze"),
            Commitment(meeting_id=m2.id, owner="Raj", action="Share the Aviator 50%_ rollout plan", status="open"),
            Stakeholder(name="Sarah Lee", role="VP Product")])
db.commit(); db.close()

r = client.get("/search", params={"q": "argocd"}).json()
assert [m["title"] for m in r["meetings"]] == ["Peak readiness review"] and r["meetings"][0]["field"] == "summary"
assert r["transcripts"][0]["count"] == 2 and "ArgoCD" in r["transcripts"][0]["snippet"]
r = client.get("/search", params={"q": "aviator raj"}).json()     # every word must match
assert [m["title"] for m in r["meetings"]] == ["1:1 Raj"] and r["commitments"][0]["owner"] == "Raj"
assert client.get("/search", params={"q": "50%_"}).json()["commitments"]   # LIKE wildcards are literal
assert client.get("/search", params={"q": "sarah"}).json()["people"][0]["role"] == "VP Product"
assert client.get("/search", params={"q": "a"}).json()["meetings"] == []
assert client.get("/search", params={"q": "x" * 201}).status_code == 400
assert client.get("/search", params={"q": "argocd"}, headers={"Authorization": "Bearer no"}).status_code == 401

print("test_pro: OK")
