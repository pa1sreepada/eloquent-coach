# Policy + governor tests (no model needed). Run: python tests/test_adaptive.py
# Set ASR_E2E=1 to also run a real-audio engine swap (needs cached models).
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from adaptive import AdaptiveController, Calibration, recommend, validate
from hardware import ComputeDevice, HardwareInfo, PowerState


def table(ultra, low, bal, acc, pair=1.6):
    return {p: {"solo": d, "pair": round(d * pair, 3)} for p, d in
            (("ultra", ultra), ("low", low), ("balanced", bal), ("accurate", acc))}


def hw(gpu=True, chip="Apple M3"):
    devs = ([ComputeDevice("metal", chip, 12)] if gpu else []) + [ComputeDevice("cpu", chip, 16)]
    return HardwareInfo("Darwin", "arm64", chip, 4, 8, 16, devs, "0.4.1")


# Measured on an M3 (16 GB) with transcribe-cpp 0.4.1 — see REFACTOR_PLAN §11.2.
def measured(**kv):
    return {p: {"solo": s, "pair": d} for p, (s, d) in kv.items()}


M3 = Calibration("m3", {
    "gpu": measured(ultra=(.460, .694), low=(.223, .355), balanced=(.058, .094), accurate=(.016, .033)),
    "cpu": measured(ultra=(1.07, 2.144), low=(.504, 1.367), balanced=(.157, .260), accurate=(.040, .103))}, 0)
MMAX = Calibration("mmax", {"gpu": table(.12, .06, .02, .01), "cpu": table(.5, .25, .08, .02)}, 0)
INTEL = Calibration("intel", {"cpu": table(9.99, 1.4, .25, .08)}, 0)
AC, BATT, LOWPWR = PowerState(), PowerState(on_battery=True), PowerState(low_power_mode=True)


def plan_of(p):
    return {s: (c.device, c.profile) for s, c in p.channels.items()}


# --- policy ---------------------------------------------------------------
# Remote LLM: the GPU is ours → ultra for Me, room offloaded to CPU.
assert plan_of(recommend(M3, hw(), AC, False)) == {"Me": ("gpu", "ultra"), "Participant": ("cpu", "balanced")}
# Local LLM shares the GPU → Me steps down to low (ultra's 0.46 duty > 0.35 budget).
p = recommend(M3, hw(), AC, True)
assert plan_of(p) == {"Me": ("gpu", "low"), "Participant": ("cpu", "balanced")}, plan_of(p)
assert any("ultra" in r for r in p.reasons)
# Low-power mode halves budgets → balanced.
assert plan_of(recommend(M3, hw(), LOWPWR, True))["Me"] == ("gpu", "balanced")
# Big GPU: ultra even with a local LLM.
assert plan_of(recommend(MMAX, hw(chip="Apple M3 Max"), AC, True))["Me"] == ("gpu", "ultra")
# CPU-only: only balanced fits; nothing on a GPU that isn't there.
assert plan_of(recommend(INTEL, hw(gpu=False), AC, False)) == {"Me": ("cpu", "balanced"), "Participant": ("cpu", "balanced")}
# Machine too slow for anything → accurate + an honest warning.
SLOW = Calibration("slow", {"cpu": table(9.99, 9.99, 2.0, 0.9)}, 0)
p = recommend(SLOW, hw(gpu=False), BATT, False)
assert plan_of(p)["Me"] == ("cpu", "accurate") and p.warnings
# Uncalibrated: conservative heuristic, never ultra.
p = recommend(None, hw(), AC, True)
assert p.source == "heuristic" and plan_of(p)["Me"] == ("gpu", "balanced")
assert plan_of(recommend(None, hw(), AC, False))["Me"] == ("gpu", "low")

# --- guardrails -----------------------------------------------------------
p = validate(M3, hw(), BATT, True, "gpu", "ultra")
assert plan_of(p)["Me"] == ("gpu", "ultra"), "manual pin must be honoured"
assert p.source == "manual" and "budget" in p.warnings[0]
p = validate(M3, hw(), AC, False, "cpu", "low")
assert "can't keep up" in p.warnings[0], p.warnings
p = validate(M3, hw(), AC, True, "auto", "balanced")
assert plan_of(p)["Me"] == ("gpu", "balanced") and not p.warnings
p = validate(INTEL, hw(gpu=False), AC, False, "gpu", "balanced")
assert any("No GPU" in w for w in p.warnings)
print("policy ok")


# --- governor (fake clock + fake control) ---------------------------------
class Ctl:
    def __init__(s): s.log = []
    def set_profile(s, p, speaker=None): s.log.append(("profile", speaker, p))
    def request_split(s, speaker): s.log.append(("split", speaker))
    def switch_device(s, speaker, d): s.log.append(("device", speaker, d))


class Clock:
    t = 1000.0
    def __call__(s): return s.t


def feed(g, clk, speaker, lag, n, dt=0.08):
    for _ in range(n):
        g.observe(speaker, lag, 80, True)
        clk.t += dt


def make(cal=M3, local=True):
    ctl, clk, emitted, severe = Ctl(), Clock(), [], []
    g = AdaptiveController(recommend(cal, hw(), AC, local), ctl, cal=cal, emit=emitted.append,
                           on_severe=lambda: severe.append(clk.t), clock=clk)
    g.ch["Me"].last_change = -1e9
    return g, ctl, clk, emitted, severe


# 1. Healthy lag → no changes; silence never counts.
g, ctl, clk, em, sev = make()
feed(g, clk, "Me", 120, 200)
g.observe("Me", 5000, 80, False)
assert ctl.log == [] and not g.under_pressure()

# 2. Sustained lag over 300 ms → one step down, then cooldown holds further changes for 8 s.
feed(g, clk, "Me", 450, 12)
assert ctl.log == [("profile", "Me", "balanced")], ctl.log
assert g.ch["Me"].degraded and g.under_pressure() and em[-1]["channels"]["Me"]["profile"] == "balanced"
feed(g, clk, "Me", 450, 50)                   # 4 s later: still cooling down
assert len(ctl.log) == 1

# 3. Recovery only after 60 s calm and never while the LLM is generating.
clk.t += 30; feed(g, clk, "Me", 100, 5)
assert len(ctl.log) == 1
g.external_load = True
clk.t += 60; feed(g, clk, "Me", 100, 5)
assert len(ctl.log) == 1
g.external_load = False
feed(g, clk, "Me", 100, 1)
assert ctl.log[-1] == ("profile", "Me", "low") and not g.ch["Me"].degraded

# 4. Flapping: degrade within 120 s of a recovery doubles the calm requirement.
clk.t += 9; feed(g, clk, "Me", 450, 12)
assert ctl.log[-1] == ("profile", "Me", "balanced") and g.ch["Me"].calm_required_s == 120
n = len(ctl.log); clk.t += 70; feed(g, clk, "Me", 100, 5)
assert len(ctl.log) == n, "must wait the doubled calm period"

# 5. Severe lag → split the utterance now + yield the LLM.
g, ctl, clk, em, sev = make()
g.observe("Participant", 2000, 80, True)
assert ("split", "Participant") in ctl.log and ("profile", "Participant", "accurate") in ctl.log and sev

# 6. At the slowest GPU profile: fall back to CPU (if calibration says it fits), then come home.
g, ctl, clk, em, sev = make()
c = g.ch["Participant"]; c.device = c.home_device = "gpu"; c.profile = "accurate"
feed(g, clk, "Participant", 1000, 12)
assert ("device", "Participant", "cpu") in ctl.log and c.device == "cpu" and c.profile == "balanced"
clk.t += 61; feed(g, clk, "Participant", 100, 1)
assert ctl.log[-1] == ("device", "Participant", "gpu") and c.profile == "accurate"

# 7. Power change lowers the ceiling immediately; disabled controller does nothing.
g, ctl, clk, em, sev = make(local=False)
assert g.ch["Me"].profile == "ultra"
g.update_plan(recommend(M3, hw(), LOWPWR, False))
assert ctl.log[-1] == ("profile", "Me", "low") and not g.ch["Me"].degraded
g.enabled = False; n = len(ctl.log); feed(g, clk, "Me", 5000, 30)
assert len(ctl.log) == n
print("governor ok")


# --- optional: live engine swap on real audio -----------------------------
if os.environ.get("ASR_E2E"):
    import asyncio, time, wave, numpy as np
    from asr_service import StreamingTranscriptionService, resolve_model_paths

    def load(path):
        with wave.open(path) as w:
            return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768

    async def e2e():
        here = os.path.dirname(__file__)
        me, them = load(os.path.join(here, "me.wav")), load(os.path.join(here, "them.wav"))
        L = np.concatenate([me, np.zeros(len(them) + 32000, np.float32)])
        R = np.concatenate([np.zeros(len(me), np.float32), them, np.zeros(32000, np.float32)])
        finals, lags = [], []
        async def sink(ev):
            if ev.type == "final": finals.append(ev)
        asr, vad = resolve_model_paths()
        svc = StreamingTranscriptionService(asr, vad, sink, channels={"Me": ("gpu", "low"), "Participant": ("gpu", "balanced")},
                                            monitor=lambda s, lag, a, u: lags.append((s, lag)))
        svc.switch_device("Participant", "cpu")      # while the room is silent → swapped before it speaks
        t0 = time.perf_counter()
        for i in range(0, len(L), 1280):
            inter = np.empty(2 * len(L[i:i + 1280]), np.float32); inter[0::2] = L[i:i + 1280]; inter[1::2] = R[i:i + 1280]
            svc.push_interleaved(inter.tobytes())
            await asyncio.sleep(max(0, t0 + (i + 1280) / 16000 - time.perf_counter()))
        state = svc.channel_state()
        await svc.close()
        assert state["Participant"]["device"] == "cpu", state
        assert [f.speaker for f in finals] == ["Me", "Participant"] and "capacity" in finals[1].text, finals
        print("e2e swap ok", state, "max lag ms", {s: round(max(l for sp, l in lags if sp == s)) for s in ("Me", "Participant")})
    asyncio.run(e2e())
