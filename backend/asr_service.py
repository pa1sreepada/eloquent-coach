"""Local streaming ASR: Parakeet-unified (GGUF) via transcribe.cpp + Silero VAD.

One ChannelTranscriber per audio channel ("Me" = mic, "Participant" = loopback).
transcribe.cpp allows one active stream per Model, so each channel owns its own
Model; weights are memory-mapped, so the second instance shares page cache.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Awaitable, Callable, Literal

import numpy as np
import transcribe_cpp

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16_000

ASR_REPO = "handy-computer/parakeet-unified-en-0.6b-gguf"
ASR_FILE = "parakeet-unified-en-0.6b-Q8_0.gguf"
VAD_REPO = "handy-computer/silero-vad-v6.2-gguf"
VAD_FILE = "silero-vad-v6.2-F32.gguf"

# Published (left, chunk, right) buffered-streaming configs for parakeet-unified.
# Lookahead latency = chunk + right. Ordered fastest → cheapest.
STREAM_PROFILES: dict[str, tuple[int, int, int]] = {
    "ultra": (5600, 80, 80),        # 160 ms lookahead, WER 1.90%
    "low": (5600, 160, 160),        # 320 ms, WER 1.64%
    "balanced": (5600, 560, 560),   # 1.12 s, WER 1.40%
    "accurate": (5600, 1040, 1040), # 2.08 s, WER 1.44%
}
LATENCY_ORDER = list(STREAM_PROFILES)


def engine_backend(device: str) -> str:
    """Map the app's device setting (auto|gpu|cpu) onto a transcribe.cpp backend name."""
    return "cpu" if device == "cpu" else "auto"


def resolve_model_paths(asr_path: str | None = None, vad_path: str | None = None) -> tuple[str, str]:
    """Return local paths, downloading into the Hugging Face cache on first use."""
    from huggingface_hub import hf_hub_download, try_to_load_from_cache

    def fetch(repo: str, name: str) -> str:
        cached = try_to_load_from_cache(repo, name)
        return cached if isinstance(cached, str) else hf_hub_download(repo, name)

    asr = asr_path or os.environ.get("ELOQUENT_ASR_MODEL") or fetch(ASR_REPO, ASR_FILE)
    vad = vad_path or os.environ.get("ELOQUENT_VAD_MODEL") or fetch(VAD_REPO, VAD_FILE)
    return asr, vad


@dataclass
class AsrEvent:
    type: Literal["partial", "final"]
    speaker: str
    utterance_id: str
    text: str
    t0_ms: int          # meeting-relative audio time of utterance start
    t1_ms: int          # meeting-relative audio time of latest audio consumed
    compute_ms: float   # wall time of the feed()/finalize() call that produced this

    def to_json(self) -> dict:
        d = asdict(self)
        d["kind"] = d.pop("type")
        return {"type": "transcript", **d}


@dataclass
class VadConfig:
    start_threshold: float = 0.5
    end_threshold: float = 0.35
    min_silence_ms: int = 450      # silence hangover that ends an utterance
    pre_roll_ms: int = 240         # audio kept before speech onset
    max_utterance_ms: int = 30_000 # force a segment boundary on monologues


@dataclass
class _Utterance:
    id: str
    t0_ms: int
    stream: "transcribe_cpp.Stream"
    last_display: str = ""
    silence_ms: int = 0


class ChannelTranscriber:
    """VAD-gated streaming transcriber for a single mono channel.

    Not thread-safe: drive it from exactly one worker thread.
    """

    def __init__(self, speaker: str, asr_path: str, vad_path: str, *,
                 profile: str = "low", vocabulary: list[str] | None = None,
                 vad: VadConfig | None = None, backend: str = "auto"):
        self.speaker = speaker
        self.asr_path = asr_path
        self.device = backend
        self.model, self.session = self.load_engine(asr_path, backend)
        self.vad_model = transcribe_cpp.Model(vad_path)
        self.vad = self.vad_model.vad_session()
        self.vad_frame = self.vad_model.vad_info.frame_samples
        self.set_profile(profile)
        self._vocabulary = vocabulary if vocabulary and self.model.supports("vocabulary") else None
        self.cfg = vad or VadConfig()
        self._pre_roll: deque[np.ndarray] = deque()
        self._pre_roll_samples = 0
        self._vad_carry = np.zeros(0, dtype=np.float32)
        self._samples_seen = 0
        self._utt: _Utterance | None = None
        self._split_requested = False
        self._staged: tuple[str, object, object] | None = None

    @staticmethod
    def load_engine(asr_path: str, device: str):
        model = transcribe_cpp.Model(asr_path, backend=engine_backend(device))
        if not model.capabilities.supports_streaming:
            raise RuntimeError(f"{asr_path} does not support streaming")
        return model, model.session()

    @property
    def in_utterance(self) -> bool:
        return self._utt is not None

    def request_split(self) -> None:
        """End the current utterance at the next step so a new profile/engine applies now."""
        self._split_requested = True

    def stage_engine(self, device: str, model, session) -> None:
        """Hand over a pre-loaded engine; swapped in at the next utterance boundary."""
        self._staged = (device, model, session)

    # ---- public -------------------------------------------------------
    def set_profile(self, profile: str) -> None:
        """Takes effect at the next utterance (each utterance opens a new stream)."""
        left, chunk, right = STREAM_PROFILES[profile]
        self.profile = profile
        self._stream_opts = transcribe_cpp.ParakeetBufferedStreamOptions(
            left_ms=left, chunk_ms=chunk, right_ms=right)

    def process(self, pcm: np.ndarray) -> list[AsrEvent]:
        pcm = np.ascontiguousarray(pcm, dtype=np.float32)
        events: list[AsrEvent] = []
        probs = self._vad_probs(pcm)
        frame_ms = self.vad_frame * 1000 // SAMPLE_RATE
        chunk_ms = len(pcm) * 1000 // SAMPLE_RATE
        start_ms = self._samples_seen * 1000 // SAMPLE_RATE
        self._samples_seen += len(pcm)

        if self._utt is None:
            self._maybe_swap_engine()
            if any(p >= self.cfg.start_threshold for p in probs):
                self._begin(start_ms)
                self._feed(np.concatenate([*self._pre_roll, pcm]), events)
                self._pre_roll.clear()
                self._pre_roll_samples = 0
            else:
                self._push_pre_roll(pcm)
            return events

        self._feed(pcm, events)
        # Trailing-silence run, measured per VAD frame so coalesced chunks don't hide pauses.
        trailing = 0
        for p in reversed(probs):
            if p >= self.cfg.end_threshold:
                break
            trailing += 1
        if probs:
            self._utt.silence_ms = (self._utt.silence_ms + chunk_ms if trailing == len(probs)
                                    else trailing * frame_ms)
        now_ms = self._samples_seen * 1000 // SAMPLE_RATE
        if (self._utt.silence_ms >= self.cfg.min_silence_ms or self._split_requested
                or now_ms - self._utt.t0_ms >= self.cfg.max_utterance_ms):
            self._split_requested = False
            self._end(events)
        return events

    def flush(self) -> list[AsrEvent]:
        events: list[AsrEvent] = []
        if self._utt is not None:
            self._end(events)
        return events

    def close(self) -> None:
        self.flush()
        staged = self._staged[1:] if self._staged else ()
        for obj in (self.session, self.model, self.vad, self.vad_model, *staged):
            try:
                obj.close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass

    # ---- internals ----------------------------------------------------
    def _maybe_swap_engine(self) -> None:
        if self._staged is None:
            return
        device, model, session = self._staged
        self._staged = None
        old = (self.session, self.model)
        self.device, self.model, self.session = device, model, session
        for obj in old:
            try:
                obj.close()
            except Exception:  # noqa: BLE001
                pass
        logger.info("ASR %s now on %s", self.speaker, device)

    def _vad_probs(self, pcm: np.ndarray) -> list[float]:
        buf = np.concatenate([self._vad_carry, pcm]) if self._vad_carry.size else pcm
        usable = (len(buf) // self.vad_frame) * self.vad_frame
        self._vad_carry = buf[usable:].copy()
        if usable == 0:
            return []
        return [float(p) for p in self.vad.stream_feed(buf[:usable]).probs]

    def _push_pre_roll(self, pcm: np.ndarray) -> None:
        self._pre_roll.append(pcm)
        self._pre_roll_samples += len(pcm)
        limit = self.cfg.pre_roll_ms * SAMPLE_RATE // 1000
        while self._pre_roll and self._pre_roll_samples - len(self._pre_roll[0]) >= limit:
            self._pre_roll_samples -= len(self._pre_roll.popleft())

    def _begin(self, start_ms: int) -> None:
        pre_ms = self._pre_roll_samples * 1000 // SAMPLE_RATE
        stream = self.session.stream(family=self._stream_opts, vocabulary=self._vocabulary)
        self._utt = _Utterance(id=uuid.uuid4().hex[:12], t0_ms=max(0, start_ms - pre_ms), stream=stream)

    def _feed(self, pcm: np.ndarray, events: list[AsrEvent]) -> None:
        utt = self._utt
        assert utt is not None
        t = time.perf_counter()
        update = utt.stream.feed(pcm)
        compute_ms = (time.perf_counter() - t) * 1000
        if update.committed_changed or update.tentative_changed:
            display = utt.stream.text().display.strip()
            if display and display != utt.last_display:
                utt.last_display = display
                events.append(self._event("partial", display, compute_ms))

    def _end(self, events: list[AsrEvent]) -> None:
        utt = self._utt
        assert utt is not None
        t = time.perf_counter()
        try:
            utt.stream.finalize()
            text = utt.stream.text().committed.strip()
        finally:
            utt.stream.reset()
        compute_ms = (time.perf_counter() - t) * 1000
        if text:
            events.append(self._event("final", text, compute_ms))
        self._utt = None

    def _event(self, kind: Literal["partial", "final"], text: str, compute_ms: float) -> AsrEvent:
        assert self._utt is not None
        return AsrEvent(kind, self.speaker, self._utt.id, text, self._utt.t0_ms,
                        self._samples_seen * 1000 // SAMPLE_RATE, round(compute_ms, 1))


EventSink = Callable[[AsrEvent], Awaitable[None]]


# monitor(speaker, lag_ms, audio_ms, in_utterance): called on the event loop after every step.
Monitor = Callable[[str, float, float, bool], None]


@dataclass
class _ChannelWorker:
    transcriber: ChannelTranscriber
    executor: ThreadPoolExecutor
    pending: list[np.ndarray] = field(default_factory=list)
    oldest_arrival: float | None = None
    busy: bool = False


class StreamingTranscriptionService:
    """Splits interleaved stereo into channels and runs them in parallel.

    Each channel has a dedicated single-thread executor (transcribe.cpp calls
    release the GIL). Audio that arrives while a channel is busy is coalesced
    into the next feed, so a slow step never builds an unbounded backlog.
    """

    def __init__(self, asr_path: str, vad_path: str, sink: EventSink, *,
                 speakers: tuple[str, str] = ("Me", "Participant"),
                 profile: str = "low", vocabulary: list[str] | None = None,
                 backend: str = "auto",
                 channels: dict[str, tuple[str, str]] | None = None,
                 monitor: Monitor | None = None):
        """`channels` maps speaker → (device, profile) and overrides backend/profile per channel."""
        self._sink = sink
        self._monitor = monitor
        self._asr_path = asr_path
        channels = channels or {}
        self._workers = {
            s: _ChannelWorker(
                ChannelTranscriber(s, asr_path, vad_path,
                                   profile=channels.get(s, (backend, profile))[1], vocabulary=vocabulary,
                                   backend=channels.get(s, (backend, profile))[0]),
                ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"asr-{s}"),
            )
            for s in speakers
        }
        self._order = list(speakers)
        self._tasks: set[asyncio.Task] = set()

    def push_interleaved(self, frame: bytes) -> None:
        stereo = np.frombuffer(frame, dtype=np.float32).reshape(-1, 2)
        now = time.monotonic()
        for idx, speaker in enumerate(self._order):
            worker = self._workers[speaker]
            worker.pending.append(stereo[:, idx].copy())
            if worker.oldest_arrival is None:
                worker.oldest_arrival = now
            if not worker.busy:
                self._schedule(worker)

    # ---- control surface used by adaptive.AdaptiveController ----------
    def set_profile(self, profile: str, speaker: str | None = None) -> None:
        if profile not in STREAM_PROFILES:
            raise ValueError(f"unknown profile {profile!r}")
        for s, w in self._workers.items():
            if speaker in (None, s):
                w.transcriber.set_profile(profile)

    def request_split(self, speaker: str) -> None:
        self._workers[speaker].transcriber.request_split()

    def switch_device(self, speaker: str, device: str) -> None:
        """Load a new engine off-thread; it is swapped in at the channel's next pause."""
        t = self._workers[speaker].transcriber

        async def load() -> None:
            model, session = await asyncio.to_thread(ChannelTranscriber.load_engine, self._asr_path, device)
            t.stage_engine(device, model, session)
        self._track(asyncio.ensure_future(load()))

    def in_utterance(self, speaker: str) -> bool:
        return self._workers[speaker].transcriber.in_utterance

    def channel_state(self) -> dict[str, dict]:
        return {s: {"device": w.transcriber.device, "profile": w.transcriber.profile}
                for s, w in self._workers.items()}

    async def close(self) -> None:
        while any(w.busy for w in self._workers.values()):
            await asyncio.sleep(0.01)
        loop = asyncio.get_running_loop()
        for w in self._workers.values():
            if w.pending:
                pcm = np.concatenate(w.pending)
                w.pending.clear()
                for ev in await loop.run_in_executor(w.executor, w.transcriber.process, pcm):
                    await self._sink(ev)
            for ev in await loop.run_in_executor(w.executor, w.transcriber.flush):
                await self._sink(ev)
            await loop.run_in_executor(w.executor, w.transcriber.close)
            w.executor.shutdown(wait=False)

    def _schedule(self, worker: _ChannelWorker) -> None:
        worker.busy = True
        self._track(asyncio.create_task(self._drain(worker)))

    def _track(self, task: asyncio.Future) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _drain(self, worker: _ChannelWorker) -> None:
        loop = asyncio.get_running_loop()
        try:
            while worker.pending:
                pcm = np.concatenate(worker.pending)
                arrival = worker.oldest_arrival or time.monotonic()
                worker.pending.clear()
                worker.oldest_arrival = None
                events = await loop.run_in_executor(worker.executor, worker.transcriber.process, pcm)
                if self._monitor:
                    t = worker.transcriber
                    # Lag = how long the oldest sample in this batch waited + was processed.
                    self._monitor(t.speaker, (time.monotonic() - arrival) * 1000,
                                  len(pcm) * 1000 / SAMPLE_RATE, t.in_utterance or bool(events))
                for ev in events:
                    await self._sink(ev)
        except Exception:
            logger.exception("ASR channel %s failed", worker.transcriber.speaker)
        finally:
            worker.busy = False
