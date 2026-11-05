"""Meeting edit endpoints (type, title, transcript lines), against a throwaway SQLite database (never the real one)."""
import datetime, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(tempfile.mkdtemp())   # database.py uses a cwd-relative path; keep any stray file out of backend/

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import main
from database import Base, Meeting, Transcript

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
client = TestClient(main.app)   # no `with`: skips startup (ASR warmup)

db = Session()
t0 = datetime.datetime(2026, 1, 1, 9, 0, 0)
m, other = Meeting(title="Sync"), Meeting(title="Other")
db.add_all([m, other]); db.commit()
lines = [Transcript(meeting_id=m.id, speaker="Participant", text=f"line {i}", timestamp=t0 + datetime.timedelta(seconds=i))
         for i in range(4)]
foreign = Transcript(meeting_id=other.id, speaker="Me", text="keep me", timestamp=t0)
db.add_all(lines + [foreign]); db.commit()
ids = [t.id for t in lines]
m_id, other_id, foreign_id = m.id, other.id, foreign.id
db.close()

# Edit text and speaker; whitespace is trimmed.
r = client.patch(f"/meetings/{m_id}/transcripts/{ids[0]}", json={"text": "  Corrected words ", "speaker": "Me"})
assert r.status_code == 200 and r.json()["text"] == "Corrected words" and r.json()["speaker"] == "Me", r.json()

# Validation: empty text, unknown speaker, line from another meeting.
assert client.patch(f"/meetings/{m_id}/transcripts/{ids[1]}", json={"text": "  "}).status_code == 400
assert client.patch(f"/meetings/{m_id}/transcripts/{ids[1]}", json={"text": "x", "speaker": "Bob"}).status_code == 400
assert client.patch(f"/meetings/{m_id}/transcripts/{foreign_id}", json={"text": "x"}).status_code == 404

# Delete several; ids from another meeting are ignored.
r = client.post(f"/meetings/{m_id}/transcripts/delete", json={"ids": [ids[1], ids[2], foreign_id]})
assert r.json()["deleted"] == 2, r.json()
assert client.post(f"/meetings/{m_id}/transcripts/delete", json={"ids": []}).status_code == 400
assert client.post("/meetings/9999/transcripts/delete", json={"ids": [ids[3]]}).status_code == 404

detail = client.get(f"/meetings/{m_id}").json()
assert [(t["speaker"], t["text"]) for t in detail["transcripts"]] == [("Me", "Corrected words"), ("Participant", "line 3")]
assert client.get(f"/meetings/{other_id}").json()["transcripts"][0]["text"] == "keep me"
# Change the meeting type (decides the summary sections) without touching the title.
r = client.patch(f"/meetings/{m_id}", json={"mode": "  OKR & Delivery   Review "})
assert r.status_code == 200 and r.json()["mode"] == "OKR & Delivery Review" and r.json()["title"] == "Sync", r.json()
assert client.get(f"/meetings/{m_id}").json()["mode"] == "OKR & Delivery Review"
assert client.patch(f"/meetings/{m_id}", json={"mode": " "}).status_code == 400
assert client.patch(f"/meetings/{m_id}", json={}).status_code == 400
r = client.patch(f"/meetings/{m_id}", json={"title": "Weekly sync"})
assert r.json()["title"] == "Weekly sync" and r.json()["mode"] == "OKR & Delivery Review", r.json()
print("meeting api ok")
