import asyncio, sys
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from telemetry import SpeechTelemetry
from coach_engine import CoachingEngine, TriggerPolicy, select_prep_notes

t = SpeechTelemetry()
t.ingest("Me", "Um, so I think we should, like, prioritize enterprise. Who owns this?", 0, 6000)
t.ingest("Participant", "I'm not sure, honestly I'm worried about capacity.", 7500, 11000)
s = t.snapshot()
assert s.fillers_total == 2, s.fillers_total
assert s.hedges_total == 1, s.hedges_total
assert abs(s.avg_wait_after_question_s - 1.5) < 1e-6, s.avg_wait_after_question_s
assert abs(s.my_wpm - 12/0.1) < 1e-6, s.my_wpm
assert s.room_sentiment < 0, s.room_sentiment
print("telemetry ok", s.to_json())

p = TriggerPolicy(); tt = SpeechTelemetry()
u = tt.ingest("Participant", "What's your view on the pricing change?", 0, 3000)
assert p.evaluate(u, tt, now=100) == "question_to_me"
u = tt.ingest("Participant", "But I disagree, that won't work for us.", 3000, 6000)
assert p.evaluate(u, tt, now=101) == "objection"
u = tt.ingest("Me", "Let's ship the beta next sprint.", 6000, 8000)
assert p.evaluate(u, tt, now=102) is None
assert p.evaluate(u, tt, now=120) == "commitment_no_owner"
print("triggers ok")
assert "ARR" in select_prep_notes("Q3 ARR is $4.2M.\nSarah leads API.\nBudget frozen.\nHiring paused.\nOffsite in May.", "what was ARR in Q3", k=2)

class Stub:
    def __init__(s): s.calls=[]
    async def json_completion(s, sys_, user, schema, max_tokens=220):
        s.calls.append(user.split("\n")[1]); await asyncio.sleep(0.05)
        return {"cards":[{"kind":"bluf","headline":"Bottom line: enterprise first, capacity via contractors.","body":""}]}
out=[]
async def emit(e): out.append(e)
async def main():
    stub=Stub(); eng=CoachingEngine(stub, emit, prep_notes="Q3 ARR is $4.2M")
    await eng.on_final("Participant","Can you walk us through your plan?",0,3000)
    await asyncio.sleep(0.1)
    eng.policy.last_fire = 0
    await eng.on_final("Participant","Could you clarify your plan again?",3000,5000)
    await asyncio.sleep(0.1)
    cards=[e for e in out if e["type"]=="card"]
    assert len(cards)==1, cards
    print("engine ok:", cards[0]["kind"], cards[0]["headline"], "| trigger line:", stub.calls[0])
asyncio.run(main())

from coach_engine import is_grounded
assert is_grounded("ARR grew 40% last quarter", "revenue grew 40 percent")
assert not is_grounded("Margin is 22%", "ARR grew 40%")
assert is_grounded("Who owns the migration?", "")
assert is_grounded("Ask for $2.5M budget", "budget request is $2.5M")
assert not is_grounded("We hire 3 engineers", "two engineers")
print("grounding: ok")

# --- LLM coordination with the ASR governor -------------------------------
from coach_engine import LlmCoordinator

class FakeGov:
    def __init__(s): s.pressure = False; s.external_load = False
    def under_pressure(s): return s.pressure

async def coordination():
    gov, speaking = FakeGov(), [False]
    stub = Stub(); out.clear()
    seen_load, seen_tokens = [], []
    async def slow(sys_, user, schema, max_tokens=220):
        seen_load.append(gov.external_load); seen_tokens.append(max_tokens)
        await asyncio.sleep(0.2)
        return {"cards": [{"kind": "alignment", "headline": "Who owns the beta, and by when?", "body": ""}]}
    stub.json_completion = slow
    eng = CoachingEngine(stub, emit, coordinator=LlmCoordinator(gov, llm_local=True, me_speaking=lambda: speaking[0]))
    # P2 under ASR pressure → deferred, not sent.
    gov.pressure = True
    eng._launch("commitment_no_owner")
    assert eng._inflight is None and eng._deferred[0] == "commitment_no_owner"
    # P1 always goes through, with a shorter answer budget; marks the GPU busy while in flight.
    eng._launch("question_to_me"); await asyncio.sleep(0.25)
    assert seen_load == [True] and seen_tokens == [160] and gov.external_load is False
    # Pressure clears but I'm mid-sentence with a local LLM → still waits.
    gov.pressure = False; speaking[0] = True
    eng._retry_deferred(); assert eng._deferred is not None
    # I stop talking → the deferred card fires on the next final.
    speaking[0] = False
    eng.policy.last_fire = time.time()  # suppress a new trigger
    await eng.on_final("Participant", "Okay.", 9000, 9500); await asyncio.sleep(0.25)
    assert eng._deferred is None and seen_tokens[-1] == 220 and len(seen_tokens) == 2
    # Severe ASR lag cancels an in-flight P2 and re-defers it; P1 is never yielded.
    eng._launch("monologue"); await asyncio.sleep(0.01)
    eng.yield_gpu(); await asyncio.sleep(0.01)
    assert eng._inflight.cancelled() and eng._deferred[0] == "monologue"
    eng._deferred = None
    eng._launch("objection"); await asyncio.sleep(0.01); eng.yield_gpu()
    assert not eng._inflight.cancelled(); await asyncio.sleep(0.25)
    # Stale deferrals expire.
    eng._defer("heartbeat"); eng._deferred = ("heartbeat", time.monotonic() - 30)
    eng._retry_deferred(); assert eng._deferred is None
    print("coordination ok")

import time
asyncio.run(coordination())
