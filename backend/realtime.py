"""Real-time meeting pipeline: audio WS → streaming ASR → telemetry/coach → event fan-out.

    /ws/audio/{meeting_id}   client → server: 80 ms interleaved stereo float32 frames (L=Me, R=Participant)
                             server → client: same events as /ws/events (back-compat for the main window)
    /ws/events/{meeting_id}  server → client only: transcript partial/final, telemetry, card, asr_status
    GET  /asr/status         hardware, power, calibration, recommended plan, live channel states
    POST /asr/calibrate      re-measure this machine (background, refused during a meeting)
    POST /asr/validate       {asr_backend, asr_profile} → plan + plain-language warnings (Settings guardrail)
"""
from __future__ import annotations

import asyncio
import datetime
import logging
import threading
from collections import deque
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import adaptive
import llm_provider
from asr_service import STREAM_PROFILES, AsrEvent, StreamingTranscriptionService, resolve_model_paths
from coach_engine import CoachingEngine, LlmCoordinator, OpenAICompatClient
from hardware import HardwareInfo, PowerState, llm_is_local, probe_hardware, read_power_state
from database import AppConfig, Insight, Meeting, SessionLocal, Transcript
from telemetry import DEFAULT_FILLERS, SpeechTelemetry

logger = logging.getLogger(__name__)
router = APIRouter()

SUBSCRIBER_QUEUE = 256
BACKLOG_FRAMES = 30 * 1000 // 80     # audio buffered while the session loads (30 s of 80 ms frames)


# ---------------------------------------------------------------- fan-out
class EventBus:
    """Per-meeting pub/sub. Slow subscribers drop their oldest events instead of blocking ASR."""

    def __init__(self) -> None:
        self._subs: dict[int, set[asyncio.Queue]] = {}

    def subscribe(self, meeting_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE)
        self._subs.setdefault(meeting_id, set()).add(q)
        return q

    def unsubscribe(self, meeting_id: int, q: asyncio.Queue) -> None:
        subs = self._subs.get(meeting_id)
        if subs:
            subs.discard(q)
            if not subs:
                del self._subs[meeting_id]

    def publish(self, meeting_id: int, event: dict) -> None:
        for q in self._subs.get(meeting_id, ()):
            if q.full():
                q.get_nowait()
            q.put_nowait(event)


bus = EventBus()


async def _pump(ws: WebSocket, q: asyncio.Queue) -> None:
    while True:
        await ws.send_json(await q.get())


# ---------------------------------------------------------------- config
@dataclass
class RealtimeConfig:
    llm_api_url: str = "http://127.0.0.1:1234/v1"
    llm_model: str | None = None
    llm_thinking: bool = False       # model reasoning ("think"); off keeps cards fast
    llm_streaming: bool = True       # stream cards: the headline shows before the body is written
    llm_allow_remote: bool = False   # user opted in to sending transcripts to another machine
    asr_profile: str = "auto"        # auto (planner decides) | ultra | low | balanced | accurate
    asr_backend: str = "auto"        # auto (planner decides per channel) | gpu | cpu
    asr_adaptive: bool = True        # runtime governor steps profiles down/up on measured lag
    filler_words: list[str] = field(default_factory=lambda: list(DEFAULT_FILLERS))
    vocabulary: list[str] = field(default_factory=list)
    coach_instructions: str = ""

    @classmethod
    def load(cls) -> "RealtimeConfig":
        db = SessionLocal()
        try:
            c = {r.key: r.value for r in db.query(AppConfig).all()}
        finally:
            db.close()
        split = lambda s: [w.strip() for w in (s or "").split(",") if w.strip()]  # noqa: E731
        return cls(
            llm_api_url=c.get("llm_api_url", cls.llm_api_url),
            llm_model=c.get("llm_model") or None,
            llm_thinking=llm_provider.parse_bool(c.get("llm_thinking")),
            llm_streaming=llm_provider.parse_bool(c.get("llm_streaming"), default=True),
            llm_allow_remote=llm_provider.parse_bool(c.get("llm_allow_remote")),
            asr_profile=c.get("asr_profile", "auto"),
            asr_backend=normalize_backend(c.get("asr_backend", "auto")),
            asr_adaptive=(c.get("asr_adaptive", "true").lower() not in ("false", "0", "off")),
            filler_words=split(c.get("filler_words")) or list(DEFAULT_FILLERS),
            vocabulary=split(c.get("custom_jargon")),
            coach_instructions=c.get("coach_instructions", ""),
        )

    @property
    def llm_local(self) -> bool:
        return llm_is_local(self.llm_api_url)


def normalize_backend(v: str) -> str:
    v = (v or "auto").lower()
    return v if v in ("auto", "cpu") else "gpu" if v in ("gpu", "metal", "cuda", "vulkan", "rocm") else "auto"


# ---------------------------------------------------------------- hardware-adaptive runtime (process-wide)
class AsrRuntime:
    """Probe once, calibrate once (cached), re-plan on power changes, never calibrate mid-meeting."""

    POWER_POLL_S = 30.0

    def __init__(self) -> None:
        self.paths: tuple[str, str] | None = None
        self.hw: HardwareInfo | None = None
        self.power = PowerState()
        self.cal: adaptive.Calibration | None = None
        self.sessions: set["MeetingSession"] = set()
        self._cal_thread: threading.Thread | None = None
        self._cal_cancel = threading.Event()
        self._poll: asyncio.Task | None = None

    async def start(self) -> None:
        if self.paths is None:
            self.paths = await asyncio.to_thread(resolve_model_paths)
            self.hw = await asyncio.to_thread(probe_hardware)
            self.power = await asyncio.to_thread(read_power_state)
            self.cal = adaptive.load_cached(self.hw)
            logger.info("ASR models %s | %s | %s | calibration %s", self.paths, self.hw.chip,
                        self.power, "cached" if self.cal else "missing")
        if self._poll is None:
            self._poll = asyncio.create_task(self._poll_power())
        if self.cal is None:
            self.calibrate_in_background()

    @property
    def calibrating(self) -> bool:
        return self._cal_thread is not None and self._cal_thread.is_alive()

    def calibrate_in_background(self) -> bool:
        if self.calibrating or self.sessions or self.paths is None or self.hw is None:
            return False
        self._cal_cancel.clear()
        loop = asyncio.get_running_loop()

        def run() -> None:
            cal = adaptive.calibrate(self.paths[0], self.hw, cancel=self._cal_cancel)
            if cal is None:
                logger.info("ASR calibration cancelled (meeting started)")
                return
            adaptive.save_cached(cal)
            loop.call_soon_threadsafe(self._calibrated, cal)
        self._cal_thread = threading.Thread(target=run, name="asr-calibrate", daemon=True)
        self._cal_thread.start()
        logger.info("ASR calibration started (~25 s, one-off per machine)")
        return True

    def _calibrated(self, cal: adaptive.Calibration) -> None:
        self.cal = cal
        logger.info("ASR calibration done in %.0fs: %s", cal.seconds_taken, cal.duty)

    def plan(self, cfg: RealtimeConfig) -> adaptive.AsrPlan:
        assert self.hw is not None
        if cfg.asr_profile == "auto" and cfg.asr_backend == "auto":
            return adaptive.recommend(self.cal, self.hw, self.power, cfg.llm_local)
        return adaptive.validate(self.cal, self.hw, self.power, cfg.llm_local, cfg.asr_backend, cfg.asr_profile)

    def session_started(self, s: "MeetingSession") -> None:
        self.sessions.add(s)
        self._cal_cancel.set()                      # never compete with a live meeting

    def session_ended(self, s: "MeetingSession") -> None:
        self.sessions.discard(s)
        if self.cal is None and not self.sessions:
            self.calibrate_in_background()

    async def _poll_power(self) -> None:
        while True:
            await asyncio.sleep(self.POWER_POLL_S)
            try:
                p = await asyncio.to_thread(read_power_state)
            except Exception as err:  # noqa: BLE001
                logger.debug("power poll failed: %s", err)
                continue
            if p != self.power:
                logger.info("power state changed: %s → %s; re-planning ASR", self.power, p)
                self.power = p
                for s in list(self.sessions):
                    s.replan()

    def status(self) -> dict:
        assert self.hw is not None
        cfg = RealtimeConfig.load()
        return {"hardware": self.hw.to_json(), "power": self.power.__dict__ | {"constrained": self.power.constrained},
                "calibration": None if self.cal is None else
                {"duty": self.cal.duty, "created_at": self.cal.created_at, "seconds_taken": self.cal.seconds_taken},
                "calibrating": self.calibrating,
                "settings": {"asr_profile": cfg.asr_profile, "asr_backend": cfg.asr_backend,
                             "asr_adaptive": cfg.asr_adaptive, "llm_local": cfg.llm_local},
                "recommended": adaptive.recommend(self.cal, self.hw, self.power, cfg.llm_local).to_json(),
                "options": adaptive.options(self.cal, self.hw, self.power, cfg.llm_local),
                "active": self.plan(cfg).to_json(),
                "live": {s.meeting_id: s.controller.status() for s in self.sessions}}


runtime = AsrRuntime()


# ---------------------------------------------------------------- persistence (runs in threads)
def _load_meeting(meeting_id: int) -> dict | None:
    db = SessionLocal()
    try:
        m = db.query(Meeting).filter(Meeting.id == meeting_id).first()
        if not m:
            return None
        return {"mode": m.mode or "General", "agenda": m.agenda or "", "prep_notes": m.prep_notes or "",
                "start": m.start_time}
    finally:
        db.close()


def _persist_final(meeting_id: int, start: datetime.datetime | None, ev: dict) -> None:
    db = SessionLocal()
    try:
        ts = (start + datetime.timedelta(milliseconds=ev["t0_ms"])) if start else None
        db.add(Transcript(meeting_id=meeting_id, text=ev["text"], speaker=ev["speaker"],
                          start_ms=ev["t0_ms"], end_ms=ev["t1_ms"], utterance_id=ev["utterance_id"],
                          **({"timestamp": ts} if ts else {})))
        db.commit()
    finally:
        db.close()


def _persist_card(meeting_id: int, card: dict) -> None:
    db = SessionLocal()
    try:
        db.add(Insight(meeting_id=meeting_id, insight_type=card["kind"], text=card["headline"],
                       strategic_rationale=card.get("body") or None))
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------- per-meeting session
class MeetingSession:
    def __init__(self, meeting_id: int, meta: dict, cfg: RealtimeConfig, rt: AsrRuntime):
        self.meeting_id = meeting_id
        self.meta = meta
        self.cfg = cfg
        self.rt = rt
        self.plan = rt.plan(cfg)
        assert rt.paths is not None
        self.asr = StreamingTranscriptionService(
            *rt.paths, sink=self._on_asr, vocabulary=cfg.vocabulary or None,
            channels={s: (c.device, c.profile) for s, c in self.plan.channels.items()},
            monitor=self._observe)
        self.controller = adaptive.AdaptiveController(
            self.plan, self.asr, cal=rt.cal, emit=self._publish_status,
            on_severe=lambda: self.coach.yield_gpu(), enabled=cfg.asr_adaptive)
        self.llm = OpenAICompatClient(cfg.llm_api_url, model=cfg.llm_model, thinking=cfg.llm_thinking,
                                      stream=cfg.llm_streaming, allow_remote=cfg.llm_allow_remote)
        self.coach = CoachingEngine(
            self.llm, self._emit, mode=meta["mode"], agenda=meta["agenda"], prep_notes=meta["prep_notes"],
            instructions=cfg.coach_instructions, telemetry=SpeechTelemetry(fillers=cfg.filler_words),
            coordinator=LlmCoordinator(self.controller, llm_local=cfg.llm_local,
                                       me_speaking=lambda: self.asr.in_utterance("Me")))
        self._bg: set[asyncio.Task] = set()
        logger.info("meeting %s: ASR plan (%s) %s | %s", meeting_id, self.plan.source,
                    {s: f"{c.device}/{c.profile}" for s, c in self.plan.channels.items()},
                    "; ".join(self.plan.reasons + self.plan.warnings))

    def _observe(self, speaker: str, lag_ms: float, audio_ms: float, in_utt: bool) -> None:
        self.controller.observe(speaker, lag_ms, audio_ms, in_utt)

    def _publish_status(self, status: dict) -> None:
        bus.publish(self.meeting_id, {**status, "source": self.plan.source,
                                      "reasons": self.plan.reasons, "warnings": self.plan.warnings})

    def replan(self) -> None:
        self.plan = self.rt.plan(self.cfg)
        self.controller.update_plan(self.plan)
        self._publish_status(self.controller.status())

    async def _emit(self, event: dict) -> None:
        bus.publish(self.meeting_id, event)
        # A streamed card is shown headline-first ("partial") and saved once its body arrives ("card_update").
        if (event.get("type") == "card" and not event.get("partial")) or event.get("type") == "card_update":
            self._spawn(asyncio.to_thread(_persist_card, self.meeting_id, event))

    async def _on_asr(self, ev: AsrEvent) -> None:
        payload = ev.to_json()
        bus.publish(self.meeting_id, payload)
        if ev.type == "final":
            self._spawn(asyncio.to_thread(_persist_final, self.meeting_id,
                                          self.meta["start"], payload))
            # Telemetry is sub-ms; the LLM call inside is spawned, never awaited here.
            await self.coach.on_final(ev.speaker, ev.text, ev.t0_ms, ev.t1_ms)

    def _spawn(self, coro) -> None:
        t = asyncio.ensure_future(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)
        t.add_done_callback(lambda t: t.cancelled() or not t.exception()
                            or logger.error("background task failed: %r", t.exception()))

    async def close(self) -> None:
        await self.asr.close()
        if self.coach._inflight:
            self.coach._inflight.cancel()
        if self._bg:
            await asyncio.gather(*self._bg, return_exceptions=True)
        await self.llm.aclose()


async def warmup() -> None:
    """Call from app startup: models, hardware probe, cached calibration (or start one), power polling."""
    await runtime.start()


# ---------------------------------------------------------------- routes
@router.websocket("/ws/audio/{meeting_id}")
async def audio_ws(ws: WebSocket, meeting_id: int):
    await ws.accept()
    meta = await asyncio.to_thread(_load_meeting, meeting_id)
    if meta is None:
        await ws.close(code=4404, reason="meeting not found")
        return
    await runtime.start()
    cfg = await asyncio.to_thread(RealtimeConfig.load)
    q = bus.subscribe(meeting_id)
    pump = asyncio.create_task(_pump(ws, q))
    # Model load is ~0.2–1 s idle but can take 10–20 s while a local LLM saturates the GPU.
    # Keep reading (and buffering) meanwhile: an unread socket stalls WS keepalive pings.
    loading = asyncio.ensure_future(asyncio.to_thread(MeetingSession, meeting_id, meta, cfg, runtime))
    backlog: deque[bytes] = deque(maxlen=BACKLOG_FRAMES)
    session: MeetingSession | None = None
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if session is None and loading.done():
                session = loading.result()
                runtime.session_started(session)
                session._publish_status(session.controller.status())
                session._spawn(session.coach.warmup())
                while backlog:
                    session.asr.push_interleaved(backlog.popleft())
            if msg.get("bytes"):
                if session is None:
                    backlog.append(msg["bytes"])
                else:
                    session.asr.push_interleaved(msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        bus.unsubscribe(meeting_id, q)
        if session is None:
            try:
                session = await loading
            except Exception:  # noqa: BLE001
                logger.exception("meeting %s: ASR session failed to start", meeting_id)
                return
        else:
            runtime.session_ended(session)
        await session.close()
        logger.info("audio WS closed for meeting %s", meeting_id)


@router.websocket("/ws/events/{meeting_id}")
async def events_ws(ws: WebSocket, meeting_id: int):
    await ws.accept()
    q = bus.subscribe(meeting_id)
    pump = asyncio.create_task(_pump(ws, q))
    try:
        while True:
            await ws.receive_text()  # keepalive / ignore
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        bus.unsubscribe(meeting_id, q)


def live_session(meeting_id: int) -> "MeetingSession | None":
    return next((s for s in runtime.sessions if s.meeting_id == meeting_id), None)


@router.post("/meetings/{meeting_id}/ask", status_code=202)
async def ask_now(meeting_id: int):
    """'What do I say now?': one on-demand card, delivered over the events socket like any other."""
    session = live_session(meeting_id)
    if session is None:
        raise HTTPException(409, "This meeting isn't live.")
    await session.coach.ask()
    return {"status": "asking"}


class ValidateRequest(BaseModel):
    asr_backend: str = "auto"
    asr_profile: str = "auto"


@router.get("/asr/status")
async def asr_status():
    await runtime.start()
    return await asyncio.to_thread(runtime.status)


@router.post("/asr/calibrate", status_code=202)
async def asr_calibrate():
    await runtime.start()
    if runtime.sessions:
        raise HTTPException(409, "A meeting is in progress; calibrate afterwards.")
    if not runtime.calibrating:
        runtime.calibrate_in_background()
    return {"calibrating": True}


@router.post("/asr/validate")
async def asr_validate(req: ValidateRequest):
    await runtime.start()
    if req.asr_profile not in ("auto", *STREAM_PROFILES):
        raise HTTPException(422, f"asr_profile must be auto or one of {list(STREAM_PROFILES)}")
    cfg = await asyncio.to_thread(RealtimeConfig.load)
    cfg.asr_backend, cfg.asr_profile = normalize_backend(req.asr_backend), req.asr_profile
    return runtime.plan(cfg).to_json()
