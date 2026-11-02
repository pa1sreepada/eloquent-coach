# End-to-end check over the real WebSocket API: streams tests/me.wav + them.wav in real time
# (L=Me, R=Participant) and reports finals, cards, asr_status changes and partial lag per speaker.
# usage: python tests/e2e_ws.py <meeting_id> [repeat] [port]     (meeting must exist in the DB)
import asyncio, json, sys, time, wave, numpy as np, websockets
def load(p):
    with wave.open(p) as w: return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32)/32768
import os; B=os.path.dirname(os.path.abspath(__file__))+"/"; me, them = load(B+"me.wav"), load(B+"them.wav")
rep = int(sys.argv[2]) if len(sys.argv) > 2 else 1
PORT = sys.argv[3] if len(sys.argv) > 3 else "8000"
gap = np.zeros(16000, np.float32)
L = np.concatenate([np.concatenate([me, gap, np.zeros(len(them), np.float32), gap]) for _ in range(rep)] + [gap, gap])
R = np.concatenate([np.concatenate([np.zeros(len(me), np.float32), gap, them, gap]) for _ in range(rep)] + [gap, gap])
async def main():
    mid = sys.argv[1]; events = []
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/events/{mid}") as ev, \
               websockets.connect(f"ws://127.0.0.1:{PORT}/ws/audio/{mid}", max_size=None) as au:
        t0 = time.perf_counter()
        async def rx():
            async for m in ev: events.append((time.perf_counter() - t0, json.loads(m)))
        r = asyncio.create_task(rx())
        async def drain():                       # /ws/audio echoes events too; must be read
            async for _ in au: pass
        d = asyncio.create_task(drain())
        await asyncio.sleep(1.5)  # session/model load
        t0 = time.perf_counter()
        for i in range(0, len(L), 1280):
            inter = np.empty(2 * len(L[i:i+1280]), np.float32); inter[0::2] = L[i:i+1280]; inter[1::2] = R[i:i+1280]
            await au.send(inter.tobytes())
            await asyncio.sleep(max(0, t0 + (i + 1280) / 16000 - time.perf_counter()))
        await asyncio.sleep(6); r.cancel(); d.cancel()
    for t, e in events:
        k = e["type"]
        if k == "transcript" and e["kind"] == "final": print(f"{t:6.1f}s FINAL {e['speaker']}: {e['text'][:70]}")
        elif k == "card": print(f"{t:6.1f}s CARD [{e['kind']}] {e['headline']}")
        elif k == "asr_status": print(f"{t:6.1f}s ASR pressure={e['pressure']} " + str({s: (c['device'], c['profile'], c['lag_p50_ms'], c['last_event']) for s, c in e['channels'].items()}) + (f" warnings={e['warnings']}" if e.get('warnings') else ""))
    parts = [(t, e) for t, e in events if e["type"] == "transcript"]
    lag = [t*1000 - e["t1_ms"] for t, e in parts]
    for sp in ("Me", "Participant"):
        l = [t*1000 - e["t1_ms"] for t, e in parts if e["speaker"] == sp]
        if l: print(f"  {sp}: n={len(l)} emit-lag p50={np.median(l):.0f}ms p95={np.percentile(l,95):.0f}ms max={max(l):.0f}ms")
    if lag: print(f"partials={len(lag)} emit-lag p50={np.median(lag):.0f}ms p95={np.percentile(lag,95):.0f}ms max={max(lag):.0f}ms")
asyncio.run(main())
