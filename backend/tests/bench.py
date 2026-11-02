# Real-time-paced 2-channel ASR benchmark. Usage: python tests/bench.py <ultra|low|balanced|accurate> [auto|cpu]
# Needs tests/me.wav + tests/them.wav (16 kHz mono s16). Generate on macOS:
#   say -o me.wav --data-format=LEI16@16000 "Let's align on the Q3 roadmap..."

import asyncio, sys, time, wave, statistics, numpy as np
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from asr_service import StreamingTranscriptionService, resolve_model_paths

def load(p):
    with wave.open(p) as w: return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32)/32768
me, them = load(os.path.join(os.path.dirname(__file__), "me.wav")), load(os.path.join(os.path.dirname(__file__), "them.wav"))
sr=16000; sil=np.zeros(sr, np.float32)
# Me speaks, 1s gap, Participant answers, 1.5s trailing silence
L = np.concatenate([sil*0, me, sil, np.zeros(len(them),np.float32), sil, sil])
R = np.concatenate([np.zeros(len(me),np.float32), sil, them, sil, sil])
R = np.pad(R,(0,len(L)-len(R)))
profile = sys.argv[1]
events=[]; t_start=None
async def sink(ev):
    wall_audio_ms = (time.perf_counter()-t_start)*1000
    events.append((ev, wall_audio_ms))
async def main():
    global t_start
    asr, vad = resolve_model_paths()
    t=time.perf_counter(); svc = StreamingTranscriptionService(asr, vad, sink, profile=profile, backend=(sys.argv[2] if len(sys.argv)>2 else "auto")); load_s=time.perf_counter()-t
    frame=1280  # 80ms frames, like the AudioWorklet
    t_start=time.perf_counter()
    for i in range(0, len(L), frame):
        inter=np.empty(2*len(L[i:i+frame]),np.float32); inter[0::2]=L[i:i+frame]; inter[1::2]=R[i:i+frame]
        svc.push_interleaved(inter.tobytes())
        # real-time pacing
        target=t_start+(i+frame)/sr; await asyncio.sleep(max(0,target-time.perf_counter()))
    await svc.close()
    print(f"\n=== profile={profile} load={load_s:.1f}s")
    comp=[e.compute_ms for e,_ in events if e.type=="partial"]
    for e,w in events:
        if e.type=="final": print(f"FINAL {e.speaker:11s} audio[{e.t0_ms}-{e.t1_ms}ms] finalize={e.compute_ms}ms emitted@{w:.0f}ms :: {e.text}")
    # partial lag = wall time of emission minus audio time consumed
    lags=[w-e.t1_ms for e,w in events if e.type=="partial"]
    if comp: print(f"partials={len(comp)} feed compute ms p50={statistics.median(comp):.0f} p95={sorted(comp)[int(.95*len(comp))-1]:.0f} | emit lag behind audio p50={statistics.median(lags):.0f}ms max={max(lags):.0f}ms")
asyncio.run(main())
