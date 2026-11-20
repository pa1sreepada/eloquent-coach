"""Rephrase: option parsing, prompt storage and the endpoint (LLM stubbed), against a throwaway database."""
import os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(tempfile.mkdtemp())
os.environ["ELOQUENT_STATE_DIR"] = os.getcwd()
os.environ["ELOQUENT_API_TOKEN"] = TOKEN = "t" * 64

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import leadership
import main
import rephrase as rp
from database import Base

# ---------------------------------------------------------------- parsing
three = ("**Professional & Executive** (Leadership, Emails)\nHi team,\n- Peak freeze starts Nov 20.\n\n---\n"
         "**Collaborative & Conversational**\nHey all, quick heads-up on the freeze.\n---\n"
         "### Option 3: Short & Direct\nFreeze Nov 20. Ack by EOD?")
opts = rp.parse_options(three)
assert [o["label"] for o in opts] == ["Professional & Executive", "Collaborative & Conversational", "Short & Direct"], opts
assert opts[0]["text"].startswith("Hi team") and "- Peak freeze" in opts[0]["text"]
assert opts[2]["text"] == "Freeze Nov 20. Ack by EOD?"

# Leaked preamble is dropped; a label after the preamble is still found.
leaky = "Sure! Here are three options.\n---\nOkay, the user wants...\n**Polite & Firm**\nPlease confirm by Friday.\n---\n**Short & Crisp**\nConfirm by Fri?"
assert [(o["label"], o["text"]) for o in rp.parse_options(leaky)] == [
    ("Polite & Firm", "Please confirm by Friday."), ("Short & Crisp", "Confirm by Fri?")]

# Unlabelled chunks get the default names; a bare single reply is one option.
assert [o["label"] for o in rp.parse_options("A\n---\nB\n---\nC")] == [
    "Professional & Executive", "Collaborative & Conversational", "Short & Direct"]
assert rp.parse_options("Just this.", ["Short & Direct"]) == [{"label": "Short & Direct", "text": "Just this."}]
assert rp.parse_options("") == []

req = rp.build_request("draft", "direct", "personal", "", "shorter")
assert "Short & Crisp" in req and "not a work message" in req and "Also: shorter" in req
assert "**Short & Direct**" in rp.build_request("d", "all", "auto", "Short & Direct")

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
reply = {"raw": three}


async def fake_complete(system, user, max_tokens=0, temperature=0.0):
    calls.append((system, user, max_tokens))
    return reply["raw"]

leadership._llm.complete = fake_complete
leadership._llm._external = lambda: None

p = client.get("/rephrase/prompt").json()
assert p["prompt"] == rp.DEFAULT_PROMPT and not p["custom"]
assert client.put("/rephrase/prompt", json={"prompt": "  My style.  "}).json() == {
    "prompt": "My style.", "default": rp.DEFAULT_PROMPT, "custom": True}
assert client.put("/rephrase/prompt", json={"prompt": "Mine v2"}).json()["prompt"] == "Mine v2"

r = client.post("/rephrase", json={"text": "freeze nov 20 pls ack"})
assert r.status_code == 200 and len(r.json()["options"]) == 3, r.text
system, user, budget = calls[-1]
assert system.startswith("Mine v2") and rp.FORMAT_RULES in system and "freeze nov 20 pls ack" in user and budget == 2400

# Refining one option keeps its name and returns only the last option.
reply["raw"] = "**Short & Direct**\nFreeze Nov 20 — ack?"
r = client.post("/rephrase", json={"text": "x", "label": "Short & Direct", "instruction": "shorter"}).json()
assert r["options"] == [{"label": "Short & Direct", "text": "Freeze Nov 20 — ack?"}], r

# Reset to default; validation.
assert client.put("/rephrase/prompt", json={"prompt": ""}).json()["custom"] is False
assert client.post("/rephrase", json={"text": ""}).status_code == 422
assert client.post("/rephrase", json={"text": "   "}).status_code == 400
assert client.post("/rephrase", json={"text": "x" * (rp.MAX_DRAFT + 1)}).status_code == 422
assert client.post("/rephrase", json={"text": "x", "style": "bogus"}).status_code == 422
assert client.post("/rephrase", json={"text": "x"}, headers={"Authorization": "Bearer nope"}).status_code == 401

print("test_rephrase: OK")
