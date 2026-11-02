"""Hardware-adaptive ASR: calibrate once, plan per channel, govern at runtime.

1. calibrate()   – measures real compute cost (seconds of compute per second of audio,
                   "duty") for every device × profile on *this* machine, solo and with
                   both channels running. Cached per hardware/engine fingerprint.
2. recommend()   – picks (device, profile) per channel under a duty budget derived from
                   power state and whether a local LLM shares the GPU.
   validate()    – explains why a manual choice will or won't keep up (Settings guardrail).
3. AdaptiveController – watches live lag per channel; degrades/splits/moves to another
                   device when the machine can't keep up, recovers with hysteresis.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import numpy as np
import transcribe_cpp

from asr_service import LATENCY_ORDER, SAMPLE_RATE, STREAM_PROFILES, engine_backend
from hardware import HardwareInfo, PowerState

logger = logging.getLogger(__name__)

INFEASIBLE = 9.99
CACHE_PATH = Path(os.environ.get("ELOQUENT_STATE_DIR", Path.home() / ".eloquent-coach")) / "asr_calibration.json"
SPEAKERS = ("Me", "Participant")


# ============================================================ calibration
@dataclass
class Calibration:
    fingerprint: str
    # duty[device][profile] = {"solo": x, "pair": y}; device ∈ {"gpu", "cpu"}
    duty: dict[str, dict[str, dict[str, float]]]
    created_at: float
    seconds_taken: float = 0.0

    def get(self, device: str, profile: str, pair: bool) -> float:
        return self.duty.get(device, {}).get(profile, {}).get("pair" if pair else "solo", INFEASIBLE)


def synthetic_speech(seconds: float, seed: int = 7) -> np.ndarray:
    """Speech-like test signal: band-limited noise with a ~4 Hz syllable envelope."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SAMPLE_RATE)
    noise = np.convolve(rng.standard_normal(n), np.ones(6) / 6, mode="same")
    t = np.arange(n) / SAMPLE_RATE
    env = np.clip(np.sin(2 * np.pi * 4 * t) + 0.3, 0, None)
    return (0.1 * noise * env).astype(np.float32)


def _measure(sessions: list, profile: str, audio: np.ndarray, give_up_duty: float) -> float:
    left, chunk, right = STREAM_PROFILES[profile]
    opts = transcribe_cpp.ParakeetBufferedStreamOptions(left_ms=left, chunk_ms=chunk, right_ms=right)
    frame = SAMPLE_RATE * 80 // 1000          # same 80 ms frames the app sends
    audio_s = len(audio) / SAMPLE_RATE
    duties = [INFEASIBLE] * len(sessions)

    def run(i: int) -> None:
        stream = sessions[i].stream(family=opts)
        t0 = time.perf_counter()
        fed = 0
        try:
            for off in range(0, len(audio), frame):
                stream.feed(audio[off:off + frame])
                fed += min(frame, len(audio) - off)
                if time.perf_counter() - t0 > give_up_duty * audio_s:
                    break
            duties[i] = (time.perf_counter() - t0) / (fed / SAMPLE_RATE)
        finally:
            stream.reset()

    threads = [threading.Thread(target=run, args=(i,)) for i in range(len(sessions))]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    return round(max(duties), 3)


def calibrate(asr_path: str, hw: HardwareInfo, *, seconds: float = 3.0,
              cancel: threading.Event | None = None, audio: np.ndarray | None = None) -> Calibration | None:
    """~15–40 s once per machine. Cheapest profile first; stops once a profile can't keep up."""
    t_start = time.perf_counter()
    audio = synthetic_speech(seconds) if audio is None else audio
    devices = (["gpu"] if hw.gpu else []) + ["cpu"]
    duty: dict[str, dict[str, dict[str, float]]] = {}
    for device in devices:
        models = [transcribe_cpp.Model(asr_path, backend=engine_backend(device)) for _ in SPEAKERS]
        sessions = [m.session() for m in models]
        try:
            _measure(sessions[:1], "low", audio[: SAMPLE_RATE], INFEASIBLE)   # warm-up / shader compile
            table: dict[str, dict[str, float]] = {}
            infeasible = False
            for profile in reversed(LATENCY_ORDER):                          # accurate → ultra
                if cancel and cancel.is_set():
                    return None
                if infeasible:
                    table[profile] = {"solo": INFEASIBLE, "pair": INFEASIBLE}
                    continue
                solo = _measure(sessions[:1], profile, audio, 2.0)
                pair = _measure(sessions, profile, audio, 2.0)
                table[profile] = {"solo": solo, "pair": pair}
                infeasible = solo > 1.2
            duty[device] = table
        finally:
            for obj in (*sessions, *models):
                obj.close()
    return Calibration(hw.fingerprint(), duty, time.time(), round(time.perf_counter() - t_start, 1))


def load_cached(hw: HardwareInfo, path: Path = CACHE_PATH, max_age_days: int = 30) -> Calibration | None:
    try:
        data = json.loads(path.read_text()).get(hw.fingerprint())
    except (OSError, ValueError):
        return None
    if not data or time.time() - data["created_at"] > max_age_days * 86400:
        return None
    return Calibration(**data)


def save_cached(cal: Calibration, path: Path = CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        allc = json.loads(path.read_text())
    except (OSError, ValueError):
        allc = {}
    allc[cal.fingerprint] = asdict(cal)
    path.write_text(json.dumps(allc, indent=1))


# ============================================================ planning
@dataclass
class ChannelPlan:
    device: str          # gpu | cpu
    profile: str
    duty: float | None   # None = not calibrated yet
    est_latency_ms: int


@dataclass
class AsrPlan:
    channels: dict[str, ChannelPlan]
    budgets: dict[str, float]
    source: str                       # calibrated | heuristic | manual
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return asdict(self)


# Text latency budget for each role: the room's words only feed the LLM (3–5 s), so
# Participant never needs better than "balanced"; Me drives the teleprompter + live caption.
ROLE_PROFILES = {"Me": LATENCY_ORDER, "Participant": ["balanced", "accurate"]}


def est_latency_ms(profile: str, duty: float | None) -> int:
    _, chunk, right = STREAM_PROFILES[profile]
    if duty is not None and duty >= 1.0:
        return -1                              # falls behind: latency grows without bound
    return int(chunk + right + (duty if duty is not None else 0.5) * chunk + 40)


def channel_budget(device: str, power: PowerState, llm_shares_gpu: bool) -> float:
    """Max sustainable duty for one channel. Headroom absorbs bursts, UI, the call app itself."""
    budget = 0.6 if device == "gpu" else 0.5
    if device == "gpu" and llm_shares_gpu:
        budget = 0.35                          # LLM bursts take most of the GPU for 3–5 s
    if power.on_battery:
        budget *= 0.8
    if power.constrained:
        budget *= 0.5
    return round(budget, 3)


def recommend(cal: Calibration | None, hw: HardwareInfo, power: PowerState, llm_local: bool, *,
              pin_device: str = "auto", pin_profile: str = "auto") -> AsrPlan:
    has_gpu = hw.gpu is not None
    llm_shares_gpu = llm_local and has_gpu
    budgets = {d: channel_budget(d, power, llm_shares_gpu) for d in (["gpu"] if has_gpu else []) + ["cpu"]}
    reasons = [f"{hw.chip}, {hw.gpu.kind if hw.gpu else 'no GPU'} · "
               f"{'local LLM shares the GPU' if llm_shares_gpu else 'LLM not on this GPU'}"
               f"{' · on battery' if power.on_battery else ''}{' · low-power/thermal' if power.constrained else ''}"]
    devices = [pin_device] if pin_device in budgets else list(budgets)

    if cal is None:
        dev = devices[0]
        me = "balanced" if (llm_shares_gpu or dev == "cpu" or power.constrained) else "low"
        me = pin_profile if pin_profile in STREAM_PROFILES else me
        reasons.append("not calibrated yet → conservative defaults")
        return AsrPlan({"Me": ChannelPlan(dev, me, None, est_latency_ms(me, None)),
                        "Participant": ChannelPlan(dev, "balanced", None, est_latency_ms("balanced", None))},
                       budgets, "heuristic", reasons)

    me_profiles = [pin_profile] if pin_profile in STREAM_PROFILES else ROLE_PROFILES["Me"]
    best: tuple | None = None
    for me_dev in devices:
        for me_prof in me_profiles:
            for p_dev in devices:
                for p_prof in ROLE_PROFILES["Participant"]:
                    shared = me_dev == p_dev
                    d_me = cal.get(me_dev, me_prof, shared)
                    d_p = cal.get(p_dev, p_prof, shared)
                    # A manual profile pin is honoured even over budget (validate() warns instead).
                    if (d_me > budgets[me_dev] and pin_profile == "auto") or d_p > budgets[p_dev]:
                        continue
                    gpu_load = (d_me if me_dev == "gpu" else 0) + (d_p if p_dev == "gpu" else 0)
                    # Lexicographic: fastest Me → balanced for room → Me on GPU → least GPU load (leave it to the LLM).
                    key = (LATENCY_ORDER.index(me_prof), ROLE_PROFILES["Participant"].index(p_prof),
                           me_dev != "gpu", round(gpu_load if llm_shares_gpu else 0, 2))
                    if best is None or key < best[0]:
                        best = (key, me_dev, me_prof, d_me, p_dev, p_prof, d_p)
    if best is None:
        # Nothing fits the budget: cheapest config on the least-loaded device and say so.
        dev = min(devices, key=lambda d: cal.get(d, "accurate", True))
        d = cal.get(dev, "accurate", True)
        plan = AsrPlan({s: ChannelPlan(dev, "accurate", d, est_latency_ms("accurate", d)) for s in SPEAKERS},
                       budgets, "calibrated", reasons)
        plan.warnings.append("This machine can't run live transcription within its budget; expect lag. "
                             "Close GPU-heavy apps, plug in power, or use a remote LLM.")
        return plan
    _, me_dev, me_prof, d_me, p_dev, p_prof, d_p = best
    if me_dev != p_dev:
        reasons.append(f"room audio on {p_dev} to keep {me_dev} free for you" +
                       (" and the LLM" if llm_shares_gpu else ""))
    faster = LATENCY_ORDER[: LATENCY_ORDER.index(me_prof)]
    if faster:
        f = faster[-1]
        reasons.append(f"'{f}' would need {cal.get(me_dev, f, me_dev == p_dev):.2f} duty on {me_dev} "
                       f"> budget {budgets[me_dev]:.2f}")
    return AsrPlan({"Me": ChannelPlan(me_dev, me_prof, d_me, est_latency_ms(me_prof, d_me)),
                    "Participant": ChannelPlan(p_dev, p_prof, d_p, est_latency_ms(p_prof, d_p))},
                   budgets, "manual" if pin_profile != "auto" or pin_device != "auto" else "calibrated", reasons)


def validate(cal: Calibration | None, hw: HardwareInfo, power: PowerState, llm_local: bool,
             device: str, profile: str) -> AsrPlan:
    """Settings guardrail: plan for a manual pin, with plain-language warnings. Never blocks."""
    plan = recommend(cal, hw, power, llm_local, pin_device=device, pin_profile=profile)
    if device == "gpu" and hw.gpu is None:
        plan.warnings.append("No GPU backend available here; CPU will be used.")
    me = plan.channels["Me"]
    if cal is not None and profile in STREAM_PROFILES and me.profile == profile:
        dev = me.device
        duty = cal.get(dev, profile, plan.channels["Participant"].device == dev)
        if duty >= 1.0:
            plan.warnings.append(f"'{profile}' on {dev} can't keep up on this machine "
                                 f"(needs {duty:.2f}s compute per 1s of audio). Transcripts will fall behind.")
        elif duty > plan.budgets[dev]:
            plan.warnings.append(f"'{profile}' on {dev} uses {duty:.0%} of {dev} time per channel "
                                 f"(budget {plan.budgets[dev]:.0%}); expect lag spikes while the LLM generates. "
                                 "Adaptive mode will step it down if needed.")
    return plan


def options(cal: Calibration | None, hw: HardwareInfo, power: PowerState, llm_local: bool) -> list[dict]:
    """Every device × profile for the Settings picker: est. latency for 'Me' and whether it fits the budget."""
    llm_shares_gpu = llm_local and hw.gpu is not None
    out = []
    for device in (["gpu"] if hw.gpu else []) + ["cpu"]:
        budget = channel_budget(device, power, llm_shares_gpu)
        for profile in LATENCY_ORDER:
            duty = cal.get(device, profile, False) if cal else None
            out.append({"device": device, "profile": profile, "duty": duty,
                        "est_latency_ms": est_latency_ms(profile, duty),
                        "within_budget": None if duty is None else duty <= budget})
    return out


# ============================================================ runtime governor
class AsrControl(Protocol):
    def set_profile(self, profile: str, speaker: str | None = None) -> None: ...
    def request_split(self, speaker: str) -> None: ...
    def switch_device(self, speaker: str, device: str) -> None: ...


LAG_LIMIT_MS = {"Me": 300.0, "Participant": 900.0}
SEVERE_LAG_MS = 1500.0


@dataclass
class _Channel:
    speaker: str
    device: str
    profile: str
    ceiling: str                                   # best profile the plan allows
    home_device: str = ""                          # device the plan chose (return here after CPU fallback)
    lags: deque = field(default_factory=lambda: deque(maxlen=20))
    last_change: float = -1e9
    last_bad: float = -1e9
    last_recover: float = -1e9
    calm_required_s: float = 60.0
    events: list[str] = field(default_factory=list)

    @property
    def degraded(self) -> bool:
        return LATENCY_ORDER.index(self.profile) > LATENCY_ORDER.index(self.ceiling)


class AdaptiveController:
    def __init__(self, plan: AsrPlan, control: AsrControl, *, cal: Calibration | None,
                 budgets: dict[str, float] | None = None, emit: Callable[[dict], None] | None = None,
                 on_severe: Callable[[], None] | None = None, enabled: bool = True,
                 clock: Callable[[], float] = time.monotonic):
        self.control = control
        self.cal = cal
        self.budgets = budgets or plan.budgets
        self.emit = emit
        self.on_severe = on_severe
        self.enabled = enabled
        self.clock = clock
        self.external_load = False                 # set True while an LLM call is in flight
        self.ch = {s: _Channel(s, c.device, c.profile, c.profile, c.device) for s, c in plan.channels.items()}

    # --- inputs -------------------------------------------------------
    def observe(self, speaker: str, lag_ms: float, audio_ms: float, in_utterance: bool) -> None:
        c = self.ch.get(speaker)
        if c is None or not in_utterance or not self.enabled:
            return
        now = self.clock()
        limit = LAG_LIMIT_MS.get(speaker, 600.0)
        if lag_ms > limit:
            c.last_bad = now
        if now - c.last_change < 8.0:              # let the last change take effect; samples here are stale
            return
        c.lags.append(lag_ms)
        if lag_ms > SEVERE_LAG_MS:
            if self.on_severe:
                self.on_severe()                   # e.g. cancel a low-priority LLM call
            self._degrade(c, now, f"severe lag {lag_ms:.0f} ms", split=True)
        elif len(c.lags) >= 10 and sum(lag > limit for lag in c.lags) >= 6:
            self._degrade(c, now, f"p70 lag > {limit:.0f} ms")
        elif (c.degraded or c.device != c.home_device) and self._calm(c, now):
            self._recover(c, now)

    def update_plan(self, plan: AsrPlan) -> None:
        """Power/thermal or LLM-location change: move ceilings; degrade immediately if needed."""
        self.budgets = plan.budgets
        for s, cp in plan.channels.items():
            c = self.ch[s]
            c.ceiling, c.home_device = cp.profile, cp.device
            if LATENCY_ORDER.index(c.profile) < LATENCY_ORDER.index(cp.profile):
                self._apply(c, cp.profile, self.clock(), "plan ceiling lowered (power/thermal)")

    def under_pressure(self) -> bool:
        now = self.clock()
        return any(now - c.last_bad < 5.0 or now - c.last_change < 15.0 and c.degraded for c in self.ch.values())

    def status(self) -> dict:
        return {"type": "asr_status", "pressure": self.under_pressure(), "channels": {
            s: {"device": c.device, "profile": c.profile, "ceiling": c.ceiling, "degraded": c.degraded,
                "lag_p50_ms": round(float(np.median(c.lags)), 0) if c.lags else None,
                "last_event": c.events[-1] if c.events else None}
            for s, c in self.ch.items()}}

    # --- actions ------------------------------------------------------
    def _calm(self, c: _Channel, now: float) -> bool:
        return (not self.external_load and now - c.last_bad >= c.calm_required_s
                and now - c.last_change >= c.calm_required_s)

    def _degrade(self, c: _Channel, now: float, why: str, split: bool = False) -> None:
        idx = LATENCY_ORDER.index(c.profile)
        if now - c.last_recover < 120.0:           # flapping → wait longer before next recovery
            c.calm_required_s = min(600.0, c.calm_required_s * 2)
        if idx + 1 < len(LATENCY_ORDER):
            self._apply(c, LATENCY_ORDER[idx + 1], now, why)
        elif c.device == "gpu" and self._cpu_fits():
            prof = self._cpu_profile()
            c.events.append(f"{why}: moving to CPU/{prof}")
            logger.warning("ASR %s: %s at slowest GPU profile → CPU/%s", c.speaker, why, prof)
            c.device, c.last_change = "cpu", now
            c.lags.clear()
            self.control.set_profile(prof, c.speaker)
            c.profile = prof
            self.control.switch_device(c.speaker, "cpu")
            self._publish()
        else:
            c.last_change = now
            return
        if split:
            self.control.request_split(c.speaker)

    def _recover(self, c: _Channel, now: float) -> None:
        if c.device != c.home_device:              # first step back: return to the planned device, slowest profile
            c.last_recover = now
            c.events.append(f"calm for {c.calm_required_s:.0f}s: back to {c.home_device}/accurate")
            c.device, c.last_change = c.home_device, now
            c.lags.clear()
            self.control.set_profile("accurate", c.speaker)
            c.profile = "accurate"
            self.control.switch_device(c.speaker, c.home_device)
            self._publish()
            return
        idx = LATENCY_ORDER.index(c.profile)
        target = LATENCY_ORDER[idx - 1]
        shared = any(o is not c and o.device == c.device for o in self.ch.values())
        if self.cal is not None and self.cal.get(c.device, target, shared) > self.budgets.get(c.device, 0.5):
            return
        c.last_recover = now
        self._apply(c, target, now, f"calm for {c.calm_required_s:.0f}s")

    def _apply(self, c: _Channel, profile: str, now: float, why: str) -> None:
        logger.info("ASR %s: %s → %s (%s)", c.speaker, c.profile, profile, why)
        c.events.append(f"{c.profile}→{profile}: {why}")
        c.profile, c.last_change = profile, now
        c.lags.clear()
        self.control.set_profile(profile, c.speaker)
        self._publish()

    def _cpu_fits(self) -> bool:
        return self.cal is not None and self.cal.get("cpu", "accurate", self._cpu_shared()) <= self.budgets.get("cpu", 0.5)

    def _cpu_shared(self) -> bool:
        return any(o.device == "cpu" for o in self.ch.values())

    def _cpu_profile(self) -> str:
        assert self.cal is not None
        for p in ("balanced", "accurate"):
            if self.cal.get("cpu", p, self._cpu_shared()) <= self.budgets.get("cpu", 0.5):
                return p
        return "accurate"

    def _publish(self) -> None:
        if self.emit:
            self.emit(self.status())
