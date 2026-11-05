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
        s.calls.append(user.rsplit("\n\n", 1)[-1]); await asyncio.sleep(0.05)
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
    prompt = eng._build_prompt("my_turn")
    assert prompt.rsplit("\n\n", 1)[-1].startswith("TASK (my_turn)"), prompt   # task last
    assert "ALREADY SHOWN:\n- Bottom line: enterprise first" in prompt               # avoid repeats
    assert stub.calls[0].startswith("TASK (question_to_me)")
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

# --- prompt assembly + post-meeting parsing -------------------------------
from coach_engine import mode_focus, DEFAULT_FOCUS
assert "guest" in mode_focus("Fireside Chat & Guest Speaker")
assert "Trade, never give" in mode_focus("Negotiation & Deal Mode")
assert mode_focus("General Executive") == DEFAULT_FOCUS

from post_meeting_synthesis import parse_briefing, _chunks
raw = """**--- EXECUTIVE SUMMARY ---**
Bottom line: ship enterprise first.
## --- ACTION ITEMS ---
- Sarah | Migration plan | Friday
--- OPEN QUESTIONS ---
- Who covers SMB churn?
--- STRATEGIC REROUTES ---
1. ORIGIN: "I think maybe we could possibly look at shipping it next quarter" | ALTERNATIVE: "We will ship it next quarter" | RATIONALE: Commit.
"""
summary, reroutes = parse_briefing(raw)
assert summary.startswith("Bottom line") and "Action Items:\n- Sarah" in summary and "Open Questions:" in summary, summary
assert reroutes.startswith("1. ORIGIN") and "---" not in summary
assert parse_briefing("--- EXECUTIVE SUMMARY ---\nx\n--- STRATEGIC REROUTES ---\nNone")[1] == ""
assert parse_briefing("free text")[0] == "free text"
assert parse_briefing("x<channel|>--- EXECUTIVE SUMMARY ---\nBottom line: y")[0] == "Bottom line: y"
from lm_studio_client import strip_reasoning
assert strip_reasoning("plan...<channel|>--- EXECUTIVE SUMMARY ---") == "--- EXECUTIVE SUMMARY ---"
assert parse_briefing("Bottom line: x\n--- ACTION ITEMS ---\n- None")[0].startswith("Bottom line: x")
parts = _chunks("\n".join(f"Me: line {i}" for i in range(100)), 120)
assert all(len(p) <= 120 for p in parts) and "\n".join(parts).count("line") == 100
print("prompts ok")


def test_reroute_filter():
    from post_meeting_synthesis import parse_briefing
    raw = ("--- EXECUTIVE SUMMARY ---\nBottom line: ok\n--- STRATEGIC REROUTES ---\n"
           '1. ORIGIN: "I think what I am trying to understand a couple of things." | ALTERNATIVE: "We must address X, Y, and Z." | RATIONALE: r\n'
           '2. ORIGIN: "Too short." | ALTERNATIVE: "Clear." | RATIONALE: r\n'
           '3. ORIGIN: "I can not really do anything about the slow API calls." | ALTERNATIVE: "API latency is outside our control; we track it." | RATIONALE: r\n')
    _, rr = parse_briefing(raw)
    assert rr.count("ORIGIN") == 1 and "slow API" in rr, rr


test_reroute_filter()


def test_ask_now():
    """Hotkey card: preempts, returns one card at top priority, and always reports completion."""
    class AskStub:
        def __init__(s, cards): s.cards, s.prompts = cards, []
        async def json_completion(s, sys_, user, schema, max_tokens=220):
            s.prompts.append(user); await asyncio.sleep(0.01)
            return {"cards": s.cards}

    async def run():
        events = []
        async def emit(e): events.append(e)
        two = [{"kind": "question", "headline": "Who owns the pricing decision?", "body": ""},
               {"kind": "risk", "headline": "Capacity is unplanned for the enterprise push.", "body": ""}]
        stub = AskStub(two)
        eng = CoachingEngine(stub, emit)
        eng.notes = "Push for a decision on pricing by Friday"
        await eng.ask()
        await asyncio.sleep(0.05)
        kinds = [(e["type"], e.get("state")) for e in events]
        assert kinds == [("ask", "pending"), ("card", None), ("ask", "done")], kinds
        card = events[1]
        assert card["priority"] == 1 and card["trigger"] == "ask", card
        assert "TASK (ask)" in stub.prompts[0] and "LEADER NOTES" in stub.prompts[0]
        assert "pricing by Friday" in stub.prompts[0]

        events.clear()
        eng2 = CoachingEngine(AskStub([]), emit)
        await eng2.ask()
        await asyncio.sleep(0.05)
        assert events[-1] == {"type": "ask", "state": "empty"}, events
    asyncio.run(run())


def test_clean_email():
    from post_meeting_synthesis import clean_email
    raw = "Sure! Here's the draft:\n```\n**Subject:** Q3 pricing decision\n\nHi all,\nWe agreed.\n\nThanks,\n```"
    out = clean_email(raw)
    assert out.startswith("Subject: Q3 pricing decision"), out
    assert "**" not in out and "```" not in out and out.endswith("Thanks,"), out


test_ask_now()
test_clean_email()
print("ask + follow-up ok")


# --- LLM server flexibility (Ollama / LM Studio / generic), mocked HTTP ------
import json
import httpx
import llm_provider
from coach_engine import OpenAICompatClient
from lm_studio_client import LMStudioClient

OOM = "model requires 16.9 GiB but only 11.3 GiB are available (after 512.0 MiB overhead)"


def fake_server(kind: str, *, chat_status: int = 200, loaded: str | None = None):
    """MockTransport imitating the endpoints each server really exposes."""
    seen = {"chat_models": []}

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/v1/chat/completions":
            seen["chat_models"].append(json.loads(req.content)["model"])
            if chat_status != 200:
                return httpx.Response(chat_status, json={"error": {"message": OOM, "type": "api_error"}})
            body = {"cards": [{"kind": "question", "headline": "Who owns the pricing decision?", "body": ""}]}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(body)}}]})
        if kind == "ollama":
            if path == "/api/version":
                return httpx.Response(200, json={"version": "0.13.0"})
            if path == "/api/tags":
                return httpx.Response(200, json={"models": [
                    {"name": "qwen3.8:27b", "size": 18_174_721_847},
                    {"name": "nomic-embed-text:latest", "size": 1},
                    {"name": "gemma4:e4b", "size": 3_000_000_000}]})
            if path == "/api/ps":
                return httpx.Response(200, json={"models": [{"name": loaded, "context_length": 8192}] if loaded else []})
            if path == "/v1/models":
                return httpx.Response(200, json={"data": [{"id": "qwen3.8:27b"}, {"id": "gemma4:e4b"}]})
        if kind == "lmstudio":
            if path == "/api/v0/models":
                return httpx.Response(200, json={"data": [
                    {"id": "google/gemma-4-12b-qat", "type": "vlm", "state": "not-loaded", "max_context_length": 131072},
                    {"id": "text-embedding-nomic", "type": "embeddings", "state": "loaded"},
                    {"id": "google/gemma-4-e4b", "type": "vlm", "state": "loaded", "loaded_context_length": 16384}]})
            if path == "/v1/models":
                return httpx.Response(200, json={"data": [{"id": "google/gemma-4-12b-qat"}, {"id": "google/gemma-4-e4b"}]})
        if kind == "generic" and path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "my-model.gguf"}]})
        return httpx.Response(404, json={"error": "not found"})

    return httpx.MockTransport(handler), seen


def test_provider_detection_and_model_choice():
    async def run():
        for kind, expected, loaded, want in [
            ("ollama", llm_provider.OLLAMA, "gemma4:e4b", "gemma4:e4b"),       # loaded model beats list order
            ("ollama", llm_provider.OLLAMA, None, "qwen3.8:27b"),              # nothing loaded: server order
            ("lmstudio", llm_provider.LMSTUDIO, None, "google/gemma-4-e4b"),  # LM Studio "state": "loaded"
            ("generic", llm_provider.GENERIC, None, "my-model.gguf"),
        ]:
            transport, _ = fake_server(kind, loaded=loaded)
            async with httpx.AsyncClient(transport=transport) as c:
                url = "http://127.0.0.1:9999/v1"
                provider = await llm_provider.detect_provider(c, url)
                assert provider == expected, (kind, provider)
                models = await llm_provider.list_models(c, url, provider)
                assert all("embed" not in m.id for m in models), models
                assert llm_provider.pick_model(models) == want, (kind, models)

        # Post-meeting client reads the real context window from Ollama (loaded) and LM Studio.
        lm = LMStudioClient()
        for kind, loaded, model, ctx in [("ollama", "gemma4:e4b", "gemma4:e4b", 8192),
                                         ("ollama", None, "gemma4:e4b", 4096),
                                         ("lmstudio", None, "google/gemma-4-e4b", 16384)]:
            lm._ctx_cache.clear()
            transport, _ = fake_server(kind, loaded=loaded)
            async with httpx.AsyncClient(transport=transport) as c:
                assert await lm._context_tokens(c, "http://127.0.0.1:9999/v1", model) == ctx, (kind, loaded)
    asyncio.run(run())


def test_llm_failure_reaches_hud():
    """A server error (Ollama out of memory) surfaces as llm_status + ask error, and clears on recovery."""
    async def run():
        events = []
        async def emit(e): events.append(e)
        llm = OpenAICompatClient("http://127.0.0.1:11434/v1")
        transport, seen = fake_server("ollama", chat_status=500)
        llm._http = httpx.AsyncClient(transport=transport)
        eng = CoachingEngine(llm, emit)

        await eng.warmup()
        assert events[-1]["type"] == "llm_status" and not events[-1]["ok"], events
        assert "Ollama error 500" in events[-1]["message"] and "16.9 GiB" in events[-1]["message"], events[-1]

        events.clear()
        await eng.ask()
        await asyncio.sleep(0.05)
        assert [e["type"] for e in events] == ["ask", "ask"], events   # same error isn't repeated
        assert events[-1]["state"] == "error" and "16.9 GiB" in events[-1]["message"], events[-1]

        events.clear()   # the user loads a model that fits: coaching recovers
        transport, seen = fake_server("ollama")
        await llm._http.aclose()
        llm._http = httpx.AsyncClient(transport=transport)
        await eng.ask()
        await asyncio.sleep(0.05)
        kinds = [(e["type"], e.get("state"), e.get("ok")) for e in events]
        assert ("llm_status", None, True) in kinds and ("ask", "done", None) in kinds, kinds
        await llm.aclose()

        # Unreachable server: a readable message, and model discovery isn't cached as a failure.
        llm2 = OpenAICompatClient("http://127.0.0.1:1/v1")
        def refuse(req): raise httpx.ConnectError("refused", request=req)
        llm2._http = httpx.AsyncClient(transport=httpx.MockTransport(refuse))
        events.clear()
        eng2 = CoachingEngine(llm2, emit)
        await eng2.warmup()
        assert "Can't reach" in events[-1]["message"], events
        assert llm2._model is None
        await llm2.aclose()
    asyncio.run(run())


def test_structured_output_fallback():
    """Homebrew Ollama + MLX model answers 501 to response_format; cards must still arrive."""
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        calls.append(body)
        if "response_format" in body:
            return httpx.Response(501, json={"error": {"message": "structured output is unavailable"}})
        cards = {"cards": [{"kind": "risk", "headline": "Who signs off on the budget?", "body": ""}]}
        return httpx.Response(200, json={"choices": [{"message": {"content": "```json\n" + json.dumps(cards) + "\n```"}}]})

    async def run():
        llm = OpenAICompatClient("http://127.0.0.1:11434/v1", model="qwen3.8:27b")
        llm.provider = llm_provider.OLLAMA
        llm._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        for _ in range(2):
            data = await llm.json_completion("sys", "user", {"type": "object"})
            assert data["cards"][0]["headline"] == "Who signs off on the budget?", data
        assert len(calls) == 3, calls                     # one 501, then no further schema attempts
        assert "JSON schema" in calls[1]["messages"][0]["content"]

        # Other errors (e.g. out of memory) are still raised, not retried as prompt-only.
        llm2 = OpenAICompatClient("http://127.0.0.1:11434/v1", model="qwen3.8:27b")
        llm2._http = httpx.AsyncClient(transport=fake_server("ollama", chat_status=500)[0])
        try:
            await llm2.json_completion("sys", "user", {"type": "object"})
            raise AssertionError("expected LlmError")
        except llm_provider.LlmError as err:
            assert err.status == 500 and llm2._structured
        await llm.aclose(); await llm2.aclose()
    asyncio.run(run())


def test_thinking_setting():
    """Settings' thinking toggle reaches both clients as the fields each server understands."""
    def make(kind, reject_fields=False):
        bodies = []
        base, _ = fake_server(kind)

        def handler(req: httpx.Request) -> httpx.Response:
            if req.url.path == "/v1/chat/completions":
                body = json.loads(req.content)
                bodies.append(body)
                if reject_fields and ("reasoning_effort" in body or "think" in body):
                    return httpx.Response(400, json={"error": "unknown field"})
                cards = {"cards": []}
                return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(cards)}}]})
            return base.handle_request(req)
        return httpx.MockTransport(handler), bodies

    async def run():
        port = {"ollama": 11434, "lmstudio": 1234, "generic": 8080}
        for kind, thinking, want in [
            ("ollama", False, {"reasoning_effort": "none", "think": False}),
            ("ollama", True, {"think": True}),
            ("lmstudio", False, {"reasoning_effort": "none"}),
            ("lmstudio", True, {}),
            ("generic", True, {}),
        ]:
            transport, bodies = make(kind)
            llm = OpenAICompatClient(f"http://127.0.0.1:{port[kind]}/v1", model="m", thinking=thinking)
            llm._http = httpx.AsyncClient(transport=transport)
            await llm.json_completion("sys", "user", {"type": "object"}, max_tokens=200)
            got = {k: bodies[-1][k] for k in ("reasoning_effort", "think") if k in bodies[-1]}
            assert got == want, (kind, thinking, got)
            assert bodies[-1]["max_tokens"] == (200 + llm_provider.THINKING_EXTRA_TOKENS if thinking else 200)
            await llm.aclose()

        # A server that rejects the fields still answers, and isn't sent them again.
        transport, bodies = make("lmstudio", reject_fields=True)
        llm = OpenAICompatClient("http://127.0.0.1:1234/v1", model="m")
        llm._http = httpx.AsyncClient(transport=transport)
        await llm.json_completion("sys", "user", {"type": "object"})
        await llm.json_completion("sys", "user", {"type": "object"})
        assert [("reasoning_effort" in b) for b in bodies] == [True, False, False], bodies
        await llm.aclose()

        # Post-meeting client reads the toggle from Settings.
        for thinking in (False, True):
            transport, bodies = make("ollama")
            client = LMStudioClient("http://127.0.0.1:11434/v1")
            client._config = lambda t=thinking: ("http://127.0.0.1:11434/v1", "m", t)
            real = httpx.AsyncClient
            httpx.AsyncClient = lambda **kw: real(transport=transport)
            try:
                await client.complete("sys", "user", max_tokens=300)
            finally:
                httpx.AsyncClient = real
            assert bodies[-1]["think"] is thinking and ("reasoning_effort" in bodies[-1]) is not thinking
    assert llm_provider.parse_bool("true") and not llm_provider.parse_bool(None)
    asyncio.run(run())


test_provider_detection_and_model_choice()
test_llm_failure_reaches_hud()
test_structured_output_fallback()
test_thinking_setting()
print("llm providers ok")
