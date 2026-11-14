"""Leadership features: analysis helpers, live tracker, commitments, growth, briefs and rehearsal (LLM stubbed),
against a throwaway SQLite database (never the real one)."""
import datetime as dt, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(tempfile.mkdtemp())
os.environ["ELOQUENT_STATE_DIR"] = os.getcwd()
os.environ["ELOQUENT_API_TOKEN"] = TOKEN = "t" * 64

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import leadership
import leadership_analysis as la
import main
from database import AppConfig, Base, Commitment, Meeting, MeetingItem, Transcript

# ---------------------------------------------------------------- pure helpers
wed = dt.date(2026, 11, 11)
assert la.resolve_due("Friday", wed) == dt.date(2026, 11, 13)
assert la.resolve_due("next week", wed) == dt.date(2026, 11, 20)
assert la.resolve_due("Nov 20", wed) == dt.date(2026, 11, 20)
assert la.resolve_due("in 2 weeks", wed) == dt.date(2026, 11, 25)
assert la.resolve_due("Q1", wed) == dt.date(2027, 3, 31)
assert la.resolve_due("No date", wed) is None

summary = ("**Bottom line:** ship it\n\n**Action items**\n- **Me** — Send churn numbers (Friday)\n"
           "- **Sarah** — Draft migration plan (Nov 1)\n- Unowned thing\n\n**Risks & concerns**\n- churn")
acts = la.summary_actions(summary)
assert [(a["owner"], a["action"], a["due_text"]) for a in acts] == [
    ("Me", "Send churn numbers", "Friday"), ("Sarah", "Draft migration plan", "Nov 1"), ("Unassigned", "Unowned thing", None)]
assert la.is_mine("Me", "") and la.is_mine("Pavan", "Pavan Sreepada") and not la.is_mine("Sarah", "Pavan Sreepada")

t = la.DecisionTracker()
assert t.ingest("Participant", "OK, we've decided to go with vendor B for the rollout.")[0]["kind"] == "decision"
assert t.ingest("Participant", "The team will review it. Sarah will own the migration plan.")[0]["owner"] == "Sarah"
assert t.ingest("Me", "Let's take that offline.")[0]["kind"] == "parked"
assert t.ingest("Me", "Let's take that offline.") == []   # duplicates are ignored
snap = t.snapshot()
assert snap["type"] == "tracker" and snap["counts"] == {"decisions": 1, "commitments": 1, "unowned": 0, "parked": 1}, snap

# Echo of the other channel on the mic → not counted as mine.
L = la.Line
echo = la.find_echoes([L("Participant", "what is your view on the enterprise pricing change", 0, 3000),
                       L("Me", "what is your view on the enterprise pricing change", 500, 3000)])
assert echo == {1}, echo

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

calls = []


async def fake_complete(system, user, max_tokens=0, temperature=0.0):
    calls.append((system, user))
    if "Rewrite what a senior leader said" in system:
        return "BETTER: We'll hold enterprise pricing.\nWHY: answer first"
    if "reviewing a practice conversation" in system:
        return "SCORES: clarity=7, confidence=6, listening=8, persuasion=5, presence=7\nSTRENGTHS:\n- clear"
    if "role-playing" in system:
        return "THEM: What's the payback period?"
    return "## Brief\n- ok"

leadership._llm.complete = fake_complete
leadership._llm._external = lambda: None

db = Session()
db.add_all([AppConfig(key="leader_name", value="Pavan Sreepada"), AppConfig(key="filler_words", value="um,like"),
            AppConfig(key="custom_jargon", value="ARR")])
start = dt.datetime.utcnow() - dt.timedelta(days=2)
me = ("Our priority is enterprise retention. We will hold price and add a premium tier next quarter, "
      "and I'll send the plan to the board on Friday. ") * 3
m = Meeting(title="1:1 with Sarah", mode="1:1", start_time=start, end_time=start + dt.timedelta(minutes=30),
            attendees="Sarah Lee", summary=summary)
db.add(m); db.commit()
for i in range(6):
    db.add(Transcript(meeting_id=m.id, speaker="Me" if i % 2 == 0 else "Participant",
                      text=me if i % 2 == 0 else "I'm worried about churn risk in mid market accounts this quarter.",
                      timestamp=start + dt.timedelta(seconds=10 * i)))
db.add(MeetingItem(meeting_id=m.id, kind="commitment", text="I'll send the deck", owner="Me", speaker="Me"))
db.commit()
mid = m.id
db.close()

# Commitments sync is idempotent and the summary supersedes live-tracker items.
assert client.post("/commitments/sync").json()["added"] == 3
assert client.post("/commitments/sync").json()["added"] == 0
rows = client.get("/commitments").json()
assert {r["action"] for r in rows} == {"Send churn numbers", "Draft migration plan", "Unowned thing"}, rows
mine = [r for r in rows if r["is_mine"]]
assert len(mine) == 1 and mine[0]["due_date"], mine
sarah = next(r for r in rows if r["owner"] == "Sarah")
assert sarah["overdue"] or sarah["due_date"] is None or sarah["due_date"] >= dt.date.today().isoformat()

r = client.patch(f"/commitments/{mine[0]['id']}", json={"due_text": "yesterday 2020-01-01"})
assert r.json()["overdue"], r.json()
assert client.get("/commitments/reminders").json()["overdue"][0]["id"] == mine[0]["id"]
assert client.patch(f"/commitments/{mine[0]['id']}", json={"status": "done"}).json()["status"] == "done"
assert client.patch(f"/commitments/{mine[0]['id']}", json={"status": "bogus"}).status_code == 400
c = client.post("/commitments", json={"action": "Call Raj", "owner": "Pavan", "due_text": "tomorrow"}).json()
assert c["is_mine"] and c["due_date"] == (dt.date.today() + dt.timedelta(days=1)).isoformat(), c

# Growth: verified meeting by default, attribution override works.
g = client.get("/growth").json()
assert g["meetings"][0]["id"] == mid and g["attribution"]["used"] + g["attribution"]["mixed"] + g["attribution"]["excluded"] >= 1
assert client.put(f"/meetings/{mid}/attribution", json={"attribution": "exclude"}).json()["attribution"] == "exclude"
assert client.get("/growth").json()["attribution"]["excluded"] == 1
assert client.put(f"/meetings/{mid}/attribution", json={"attribution": "nope"}).status_code == 400
client.put(f"/meetings/{mid}/attribution", json={"attribution": "verified"})
assert client.get("/growth").json()["attribution"]["used"] == 1

# Say it better + practice.
items = client.get("/growth/say-it-better?days=7").json()["items"]
rw = client.post("/growth/say-it-better/rewrite", json={"original": "I think maybe we hold price", "meeting_id": mid}).json()
assert rw["better"] == "We'll hold enterprise pricing.", rw
assert client.post("/growth/practice", json={"original": "I think maybe we hold price", "meeting_id": mid}).json()["practiced"]

# Stakeholders, people, radar, brief.
assert {"name": "Sarah Lee", "meetings": 1} in client.get("/people").json()
sid = client.post("/stakeholders", json={"name": "Sarah Lee", "role": "VP Sales"}).json()["id"]
assert client.post("/stakeholders", json={"name": "sarah lee"}).status_code == 409
s = client.get("/stakeholders").json()["stakeholders"][0]
assert s["meetings"] == 1 and s["their_open_commitments"] == 1, s
assert client.get("/team/radar").json()["people"][0]["person"] == "Sarah Lee"
b = client.post("/brief", json={"title": "Pricing sync", "attendees": "Sarah Lee", "mode": "1:1"}).json()
assert b["meeting_ids"] == [mid] and "Draft migration plan" in b["context"] and b["brief"] == "## Brief\n- ok", b
assert client.get("/generated-docs?kind=brief").json()[0]["content"] == "## Brief\n- ok"

# Rehearsal: open, answer (per-turn feedback), finish (scorecard).
rh = client.post("/rehearsals", json={"persona": "skeptical_cfo", "scenario": "Budget ask"}).json()
assert rh["turns"][0]["text"] == "THEM: What's the payback period?" or rh["turns"][0]["role"] == "them"
turn = client.post(f"/rehearsals/{rh['id']}/turn", json={"text": "Um, I think maybe, like, it kind of depends."}).json()
assert turn["reply"] == "What's the payback period?" and turn["feedback"]["tips"], turn
done = client.post(f"/rehearsals/{rh['id']}/finish").json()
assert done["scores"]["scores"]["clarity"] == 7 and done["scores"]["stats"]["me_words"] > 0, done
assert client.get("/growth").json()["practice"]["count"] == 1

# Meeting fields and delete cascade.
assert client.patch(f"/meetings/{mid}", json={"attendees": "Raj,  Sarah Lee, raj"}).json()["attendees"] == "Raj, Sarah Lee"
d = client.get(f"/meetings/{mid}").json()
assert d["attendees"] == "Raj, Sarah Lee" and d["attribution"] == "verified"
assert client.delete(f"/meetings/{mid}").status_code == 200
db = Session()
assert db.query(Commitment).filter(Commitment.meeting_id == mid).count() == 0
assert db.query(MeetingItem).count() == 0
db.close()

# LLM features refuse while a local-LLM meeting is live.
fake_live = type("S", (), {"meeting_id": 999})()
main.realtime.runtime.sessions.add(fake_live)
try:
    assert client.post("/growth/say-it-better/rewrite", json={"original": "x"}).status_code == 409
finally:
    main.realtime.runtime.sessions.discard(fake_live)

print("test_leadership: OK")
