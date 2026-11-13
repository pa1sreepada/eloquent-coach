"""Teleprompter endpoints (scripts, runs, LLM helpers), against a throwaway SQLite database (never the real one)."""
import asyncio, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(tempfile.mkdtemp())   # database.py uses a cwd-relative path; keep any stray file out of backend/
os.environ["ELOQUENT_STATE_DIR"] = os.getcwd()   # no real token file or key
os.environ["ELOQUENT_API_TOKEN"] = TOKEN = "t" * 64

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import main
import prompter
from database import Base, ScriptRun

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
client = TestClient(main.app, base_url="http://127.0.0.1:8000",
                    headers={"Authorization": f"Bearer {TOKEN}"})   # no `with`: skips startup (ASR warmup)

SCRIPT = """# Why now
Good morning everyone. [pause] Revenue grew 20% with Acme and the EMEA team.
> look at the CFO
# The ask
Approve the *hiring plan* today."""


def test_text_helpers():
    assert prompter.spoken_words(SCRIPT) == 17, prompter.spoken_words(SCRIPT)
    vocab = prompter.script_vocabulary(SCRIPT)
    assert "Acme" in vocab and "EMEA" in vocab , vocab
    assert "Good" not in vocab and "Approve" not in vocab and "CFO" not in vocab, vocab   # sentence starts, notes
    assert prompter.clean_line('Bridge: "So that brings me back to the plan."\nextra') == "So that brings me back to the plan."
    assert prompter.clean_polish("Here's the rewrite:\n```\nHello.\n```") == "Hello."


def test_scripts_and_runs():
    r = client.post("/scripts", json={"title": "  Board update ", "content": SCRIPT})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["title"] == "Board update" and s["words"] == 17 and s["target_wpm"] == 150 and s["runs"] == []
    sid = s["id"]

    assert client.put(f"/scripts/{sid}", json={"target_wpm": 40}).status_code == 422
    r = client.put(f"/scripts/{sid}", json={"title": "", "target_wpm": 140})
    assert r.json()["title"] == "Untitled script" and r.json()["target_wpm"] == 140 and r.json()["content"] == SCRIPT

    run = {"duration_s": 95, "avg_wpm": 148, "coverage_pct": 92, "adlib_s": 12, "fillers": 3, "finished": True,
           "details": {"skipped": ["Approve the hiring plan today."], "paraphrased": 1}}
    r = client.post(f"/scripts/{sid}/runs", json=run)
    assert r.status_code == 200 and r.json()["details"]["paraphrased"] == 1, r.text
    assert client.post(f"/scripts/{sid}/runs", json={**run, "coverage_pct": 120}).status_code == 422

    listed = client.get("/scripts").json()
    assert listed[0]["id"] == sid and listed[0]["runs_count"] == 1 and listed[0]["last_run"]["avg_wpm"] == 148
    assert "content" not in listed[0]
    full = client.get(f"/scripts/{sid}").json()
    assert full["runs"][0]["finished"] is True and full["runs"][0]["details"]["skipped"]

    assert client.delete(f"/scripts/{sid}").json() == {"status": "deleted"}
    assert client.get(f"/scripts/{sid}").status_code == 404
    db = Session()
    assert db.query(ScriptRun).count() == 0   # runs go with their script
    db.close()


def test_llm_helpers():
    calls = []

    async def fake_complete(system, user, **kw):
        calls.append((system, user, kw))
        return '"And that is exactly why the plan matters."' if system == prompter.BRIDGE_PROMPT else "```\nWe grew. [pause]\n```"
    prompter._llm.complete = fake_complete

    r = client.post("/prompter/bridge", json={"said": "shout out to Sarah", "next": "Approve the hiring plan today.", "title": "Board"})
    assert r.json() == {"line": "And that is exactly why the plan matters.", "error": None}, r.json()
    assert "shout out to Sarah" in calls[-1][1] and "Approve the hiring plan" in calls[-1][1]
    assert client.post("/prompter/bridge", json={"said": "x", "next": " "}).json()["line"] is None

    r = client.post("/prompter/polish", json={"content": "We have grown."})
    assert r.json() == {"content": "We grew. [pause]", "error": None}, r.json()

    async def empty(*a, **kw):
        return ""
    prompter._llm.complete = empty
    prompter._llm.last_error = "Ollama error 500: out of memory"
    assert client.post("/prompter/polish", json={"content": "Hi."}).json()["error"] == "Ollama error 500: out of memory"


test_text_helpers()
test_scripts_and_runs()
test_llm_helpers()
print("prompter api ok")
