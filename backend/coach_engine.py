"""Live executive coaching: trigger policy + LLM card generation (slow path)."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx

from telemetry import COMMITMENT_MARKERS, ME, OBJECTION_MARKERS, OWNER_MARKERS, SpeechTelemetry, Utterance

logger = logging.getLogger(__name__)

CARD_KINDS = ["question", "counterpoint", "alignment", "bluf", "context", "risk", "answer", "bio"]

CARD_SCHEMA = {
    "type": "object",
    "properties": {
        "cards": {
            "type": "array", "minItems": 0, "maxItems": 2,
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": CARD_KINDS},
                    "headline": {"type": "string", "description": "<= 12 words, speakable verbatim"},
                    "body": {"type": "string", "description": "<= 25 words of support, or empty"},
                },
                "required": ["kind", "headline", "body"],
            },
        }
    },
    "required": ["cards"],
}

SYSTEM_PROMPT = """You are a discreet executive communication coach whispering into a leader's heads-up display during a live meeting.
Speaker "Me" is the leader. Produce at most 2 cards that the leader can use in the next 10 seconds.

Card kinds:
- question: one high-leverage Socratic question to ask the room.
- counterpoint: a crisp, respectful strategic counterpoint to the last claim.
- alignment: a cue that converts discussion into a decision (owner, date, success metric) or names shared ground.
- bluf: a bottom-line-first reframe of what the leader is trying to say (Pyramid Principle: answer, then 2-3 supports).
- context: a fact from PREP NOTES relevant to what was just said.
- risk: an unaddressed risk, dependency, or drift from the agenda.
- answer / bio: facts or people from PREP NOTES only.
Grounding: never state a number, name, capability or commitment that does not appear verbatim in TRANSCRIPT or PREP NOTES.
If you lack a fact, phrase the card as a question instead of an assertion.

Rules: headline <= 12 words, written exactly as the leader would say it. body <= 25 words or empty.
Prefer the card kind requested by TRIGGER. Return {"cards": []} if nothing would materially help.
Respond with JSON only."""

TRIGGER_GUIDANCE = {
    "question_to_me": "A participant just asked the leader a question. Give a 'bluf' card answering bottom-line-first.",
    "objection": "A participant pushed back. Give a 'counterpoint' or 'alignment' card that acknowledges and redirects.",
    "my_turn": "The leader has been listening for a while. Give a 'question' card that raises the level of the discussion.",
    "commitment_no_owner": "A commitment was made without an owner or date. Give an 'alignment' card that locks it down.",
    "monologue": "The leader has been talking too long. Give a 'bluf' card to land the point and hand the floor back.",
    "heartbeat": "Periodic check. Only produce a card if there is a clear, high-value opportunity.",
}

TRIGGER_PRIORITY = {"question_to_me": 1, "objection": 1, "commitment_no_owner": 2,
                    "monologue": 2, "my_turn": 2, "heartbeat": 3}


@dataclass
class CoachCard:
    id: str
    kind: str
    headline: str
    body: str
    priority: int
    ttl_s: int
    trigger: str
    created_at_ms: int

    def to_json(self) -> dict:
        return {"type": "card", **self.__dict__}


class TriggerPolicy:
    def __init__(self, cooldown_s: float = 8.0, heartbeat_s: float = 60.0, listen_turn_s: float = 20.0):
        self.cooldown_s = cooldown_s
        self.heartbeat_s = heartbeat_s
        self.listen_turn_s = listen_turn_s
        self.last_fire = 0.0
        self._listened_ms = 0
        self._monologue_flagged = False

    def evaluate(self, u: Utterance, telemetry: SpeechTelemetry, now: float | None = None) -> str | None:
        now = time.monotonic() if now is None else now
        trigger = None
        if u.speaker != ME:
            self._listened_ms += u.duration_ms
            self._monologue_flagged = False
            if u.is_question and re.search(r"\byou(r)?\b", u.text, re.I):
                trigger = "question_to_me"
            elif OBJECTION_MARKERS.search(u.text) and u.sentiment < 0.1:
                trigger = "objection"
            elif self._listened_ms >= self.listen_turn_s * 1000:
                trigger = "my_turn"
        else:
            self._listened_ms = 0
            if not self._monologue_flagged and telemetry.snapshot().monologue_s > 90:
                trigger, self._monologue_flagged = "monologue", True
        if trigger is None and COMMITMENT_MARKERS.search(u.text) and not OWNER_MARKERS.search(u.text):
            trigger = "commitment_no_owner"
        if trigger is None and now - self.last_fire >= self.heartbeat_s:
            trigger = "heartbeat"
        if trigger is None:
            return None
        if TRIGGER_PRIORITY[trigger] > 1 and now - self.last_fire < self.cooldown_s:
            return None
        self.last_fire = now
        if trigger == "my_turn":
            self._listened_ms = 0
        return trigger


class OpenAICompatClient:
    """Pooled client for LM Studio / Ollama / llama-server (OpenAI-compatible)."""

    def __init__(self, base_url: str, model: str | None = None, timeout_s: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self._model = model
        self._http = httpx.AsyncClient(timeout=timeout_s)

    async def model_id(self) -> str:
        if self._model is None:
            try:
                res = await self._http.get(f"{self.base_url}/models")
                ids = [m["id"] for m in res.json().get("data", []) if "embed" not in m["id"].lower()]
                self._model = ids[0] if ids else "local-model"
            except Exception:  # noqa: BLE001
                self._model = "local-model"
        return self._model

    async def json_completion(self, system: str, user: str, schema: dict, max_tokens: int = 220) -> dict:
        payload = {
            "model": await self.model_id(),
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.3,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": "cards", "schema": schema}},
        }
        res = await self._http.post(f"{self.base_url}/chat/completions", json=payload)
        res.raise_for_status()
        content = res.json()["choices"][0]["message"]["content"] or ""
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
        match = re.search(r"\{.*\}", content, re.S)
        return json.loads(match.group(0)) if match else {"cards": []}

    async def aclose(self) -> None:
        await self._http.aclose()


_NUM_RE = re.compile(r"\$?\d[\d,.]*\s?(?:%|percent|[kmb]\b|million|billion)?", re.I)


def _numbers(text: str) -> set[str]:
    return {re.sub(r"[\s,$]|percent", "", m.group(0).lower()).replace("%", "").rstrip(".")
            for m in _NUM_RE.finditer(text)}


def is_grounded(card_text: str, sources: str) -> bool:
    """Reject cards that cite figures not present in the transcript or prep notes."""
    return _numbers(card_text) <= _numbers(sources)


def _tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9$%']+", text.lower()) if len(w) > 2}


def select_prep_notes(prep_notes: str, recent_text: str, k: int = 4) -> str:
    """Pick the prep-note lines with the most term overlap with the live conversation."""
    lines = [ln.strip() for ln in re.split(r"[\n•]+|(?<=[.!?])\s+", prep_notes) if ln.strip()]
    if len(lines) <= k:
        return "\n".join(lines)
    q = _tokens(recent_text)
    return "\n".join(sorted(lines, key=lambda ln: len(_tokens(ln) & q), reverse=True)[:k])


Emit = Callable[[dict], Awaitable[None]]


class LlmCoordinator:
    """Keeps the coaching LLM from starving live ASR when both share one machine/GPU.

    P1 cards (a question to me, an objection) always run. P2/P3 wait while the ASR governor
    reports pressure, or — when the LLM is local — while I'm mid-sentence (my caption has priority).
    """
    DEFER_TTL_S = 20.0

    def __init__(self, controller=None, *, llm_local: bool = False,
                 me_speaking: Callable[[], bool] = lambda: False):
        self.controller = controller          # adaptive.AdaptiveController or None
        self.llm_local = llm_local
        self.me_speaking = me_speaking

    def pressure(self) -> bool:
        return bool(self.controller and self.controller.under_pressure())

    def allow(self, prio: int) -> bool:
        return prio <= 1 or not (self.pressure() or (self.llm_local and self.me_speaking()))

    def busy(self, flag: bool) -> None:
        if self.controller is not None and self.llm_local:
            self.controller.external_load = flag   # don't step ASR back up mid-generation


class CoachingEngine:
    def __init__(self, llm: OpenAICompatClient, emit: Emit, *, mode: str = "General Executive",
                 agenda: str = "", prep_notes: str = "", telemetry: SpeechTelemetry | None = None,
                 context_window_s: int = 120, coordinator: LlmCoordinator | None = None):
        self.llm = llm
        self.emit = emit
        self.mode = mode
        self.agenda = agenda
        self.prep_notes = prep_notes
        self.telemetry = telemetry or SpeechTelemetry()
        self.policy = TriggerPolicy()
        self.context_window_ms = context_window_s * 1000
        self._inflight: asyncio.Task | None = None
        self._inflight_priority = 99
        self._inflight_trigger = ""
        self._recent_headlines: list[set[str]] = []
        self.coord = coordinator or LlmCoordinator()
        self._deferred: tuple[str, float] | None = None   # (trigger, monotonic time)

    async def on_final(self, speaker: str, text: str, t0_ms: int, t1_ms: int) -> None:
        u = self.telemetry.ingest(speaker, text, t0_ms, t1_ms)
        await self.emit(self.telemetry.snapshot().to_json())
        trigger = self.policy.evaluate(u, self.telemetry)
        if trigger:
            self._launch(trigger)
        else:
            self._retry_deferred()

    def yield_gpu(self) -> None:
        """ASR is falling badly behind: cancel a low-priority generation and retry it later."""
        if self._inflight and not self._inflight.done() and self._inflight_priority >= 2:
            self._inflight.cancel()
            self._defer(self._inflight_trigger)

    def _defer(self, trigger: str) -> None:
        if self._deferred is None or TRIGGER_PRIORITY[trigger] <= TRIGGER_PRIORITY[self._deferred[0]]:
            self._deferred = (trigger, time.monotonic())

    def _retry_deferred(self) -> None:
        if self._deferred is None or (self._inflight and not self._inflight.done()):
            return
        trigger, at = self._deferred
        if time.monotonic() - at > LlmCoordinator.DEFER_TTL_S:
            self._deferred = None                  # the moment has passed
        elif self.coord.allow(TRIGGER_PRIORITY[trigger]):
            self._deferred = None
            self._launch(trigger)

    def _launch(self, trigger: str) -> None:
        prio = TRIGGER_PRIORITY[trigger]
        if not self.coord.allow(prio):
            self._defer(trigger)
            return
        if self._deferred and self._deferred[0] == trigger:
            self._deferred = None
        if self._inflight and not self._inflight.done():
            if prio >= self._inflight_priority:
                return
            self._inflight.cancel()
        self._inflight_priority, self._inflight_trigger = prio, trigger
        self._inflight = asyncio.create_task(self._generate(trigger, prio))

    def _build_prompt(self, trigger: str) -> str:
        hist = list(self.telemetry.history)
        cutoff = (hist[-1].t1_ms if hist else 0) - self.context_window_ms
        transcript = "\n".join(f"{u.speaker}: {u.text}" for u in hist if u.t1_ms >= cutoff)
        snap = self.telemetry.snapshot()
        parts = [f"MODE: {self.mode}", f"TRIGGER: {trigger} - {TRIGGER_GUIDANCE[trigger]}"]
        if self.agenda:
            parts.append(f"AGENDA: {self.agenda}")
        if self.prep_notes:
            parts.append("PREP NOTES:\n" + select_prep_notes(self.prep_notes, transcript[-1500:]))
        parts.append(f"TELEMETRY: leader talk share {snap.talk_share_recent_pct:.0f}%, "
                     f"room sentiment {snap.room_sentiment:+.2f}, monologue {snap.monologue_s:.0f}s")
        parts.append("TRANSCRIPT (most recent last):\n" + transcript)
        return "\n\n".join(parts)

    def _is_duplicate(self, headline: str) -> bool:
        toks = _tokens(headline)
        for prev in self._recent_headlines[-10:]:
            if toks and len(toks & prev) / len(toks | prev) > 0.6:
                return True
        self._recent_headlines.append(toks)
        return False

    async def _generate(self, trigger: str, prio: int) -> None:
        t = time.perf_counter()
        self.coord.busy(True)
        try:
            data = await self.llm.json_completion(SYSTEM_PROMPT, self._build_prompt(trigger), CARD_SCHEMA,
                                                  max_tokens=160 if self.coord.pressure() else 220)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            logger.warning("coach LLM call failed (%s): %r", trigger, err)
            return
        finally:
            self.coord.busy(False)
        latency_ms = (time.perf_counter() - t) * 1000
        sources = f"{self.prep_notes}\n{self.agenda}\n" + "\n".join(u.text for u in self.telemetry.history)
        for raw in data.get("cards", [])[:2]:
            kind = raw.get("kind") if raw.get("kind") in CARD_KINDS else "question"
            headline = str(raw.get("headline", "")).strip().strip('"')
            body = str(raw.get("body", "")).strip()
            if not headline or not is_grounded(f"{headline} {body}", sources):
                logger.info("dropped ungrounded card: %s", headline)
                continue
            if self._is_duplicate(headline):
                continue
            card = CoachCard(id=uuid.uuid4().hex[:10], kind=kind, headline=headline,
                             body=body, priority=prio,
                             ttl_s=45 if prio == 1 else 75, trigger=trigger,
                             created_at_ms=int(time.time() * 1000))
            logger.info("card %s/%s in %.0fms: %s", trigger, kind, latency_ms, headline)
            await self.emit(card.to_json())
