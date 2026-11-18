"""Voice profile: audio ring, acoustic bleed, labelling, voice-aware attribution, API and the live path.

The speaker model is stubbed (no download); bleed detection runs for real on synthetic speech-like audio.
Uses a throwaway database (never the real one)."""
import asyncio, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(tempfile.mkdtemp())
os.environ["ELOQUENT_STATE_DIR"] = os.getcwd()
os.environ["ELOQUENT_API_TOKEN"] = TOKEN = "v" * 64

import numpy as np
from fastapi.testclient import TestClient

import leadership_analysis as la
import main
import realtime
import voiceprint as vp
from asr_service import AsrEvent, AudioRing
from database import Base, Meeting, SessionLocal, Transcript, VoiceProfile, engine

SR = 16000
rng = np.random.default_rng(7)


def speechlike(seconds: float, seed: int) -> np.ndarray:
    """Noise shaped by a few moving formants and a syllable-rate envelope (enough for band correlation)."""
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for _ in range(3):
        f = r.uniform(300, 3000) * (1 + 0.3 * np.sin(2 * np.pi * r.uniform(0.5, 3) * t))
        x += np.sin(2 * np.pi * np.cumsum(f) / SR) * r.uniform(0.3, 1)
    x += r.standard_normal(n) * 0.3
    syll = np.clip(np.sin(2 * np.pi * r.uniform(3, 5) * t + r.uniform(0, 6)), 0, None) ** 2
    pauses = np.repeat(r.random(int(seconds * 3) + 1) > 0.25, SR // 3 + 1)[:n]
    return (x * syll * pauses * 0.1).astype(np.float32)


def through_speakers(x: np.ndarray, delay_ms: int, gain: float) -> np.ndarray:
    ir = rng.standard_normal(SR // 4) * np.exp(-np.arange(SR // 4) / (0.04 * SR))
    ir[0] = 3
    y = np.convolve(x, ir / np.linalg.norm(ir))[:len(x)] * gain
    return np.concatenate([np.zeros(delay_ms * SR // 1000), y])[:len(x)].astype(np.float32)


# ---------------------------------------------------------------- audio ring
ring = AudioRing(seconds=2)
ring.append(np.arange(SR, dtype=np.float32))
ring.append(np.arange(SR, 2 * SR + SR // 2, dtype=np.float32))   # wraps; first 0.5 s now gone
assert ring.slice_ms(0, 100) is None
got = ring.slice_ms(1000, 1500)
assert got is not None and got[0] == SR and len(got) == SR // 2
assert ring.slice_ms(2400, 9000)[-1] == 2 * SR + SR // 2 - 1          # clipped to what was written

# ---------------------------------------------------------------- acoustic bleed
remote, mine = speechlike(4, 1), speechlike(4, 2)
floor = lambda n: rng.standard_normal(n).astype(np.float32) * 1e-3   # noqa: E731
assert vp.bleed_score(through_speakers(remote, 120, 0.3) + floor(len(remote)), remote) >= vp.BLEED_THRESHOLD
assert vp.bleed_score(mine + floor(len(mine)), remote) < vp.BLEED_THRESHOLD
assert vp.bleed_score(mine, np.zeros_like(remote)) == 0.0              # silent loopback
assert vp.bleed_score(mine, None) == 0.0

# ---------------------------------------------------------------- labelling
assert vp.classify(0.62, 0.9, 3) == "me"          # my voice wins even over speaker bleed
assert vp.classify(0.10, 0.8, 3) == "echo"
assert vp.classify(0.10, 0.1, 3) == "room"
assert vp.classify(0.32, 0.1, 3) == "uncertain"
assert vp.classify(0.10, 0.1, 0.6) == "uncertain"  # too short to call someone else
assert vp.classify(None, 0.8, 3) == "echo"         # bleed works without a profile
assert vp.classify(None, 0.1, 3) is None

# Stub speaker model: the "voice" is which synthetic seed made the audio (via a spectral fingerprint).
def fake_embed(pcm):
    spec = np.abs(np.fft.rfft(pcm[: SR]))[:2000]
    v = np.add.reduceat(spec, np.arange(0, 2000, 50)).astype(np.float32)
    v = np.log(v + 1e-6)
    v -= v.mean()
    return v / np.linalg.norm(v)


vp.embed = fake_embed
vp._get_extractor = lambda: None
me_print = fake_embed(vp.speech_only(mine))
checker = vp.VoiceChecker(me_print)
assert checker.check(mine, None)[0] == "me"
assert checker.check(mine[: SR // 2], None) == ("uncertain", None)

# ---------------------------------------------------------------- voice-aware attribution
L = la.Line
lines = [L("Participant", "can you walk us through the plan for next quarter", 0, 2000),
         L("Me", "yes the plan is to ship the migration first and then expand to the enterprise tier", 2500, 6000, voice="me"),
         L("Me", "I think we should also talk about the budget for this one", 6500, 9000, voice="room"),
         L("Me", "can you walk us through the plan for next quarter", 300, 2200, voice="echo"),
         L("Me", "okay sure", 9500, 9900, voice="uncertain")]
a = la.analyze_meeting(lines)
assert a["attribution"] == "verified" and a["voice_checked"] == 1.0, a
assert a["stats"]["me_words"] == 16 and a["other_words"] == 22, a        # room line counts as someone else
assert a["echo_lines"] == 1
assert la.analyze_meeting(lines, override="exclude")["attribution"] == "exclude"
# Mostly uncertain → not trusted.
assert la.analyze_meeting([L("Me", "a b c d e f g h", voice="uncertain")] * 5 + [lines[1]])["attribution"] == "mixed"

# ---------------------------------------------------------------- API
Base.metadata.create_all(engine)
client = TestClient(main.app, base_url="http://127.0.0.1:8000", headers={"Authorization": f"Bearer {TOKEN}"})
assert client.get("/voice/profile").json()["enrolled"] is False
octet = {"Content-Type": "application/octet-stream"}
assert client.post("/voice/enroll", content=b"\0" * 64).status_code == 415
assert client.post("/voice/enroll", content=b"\0" * 7, headers=octet).status_code == 400
too_long = np.zeros(int((vp.MAX_ENROLL_S + 1) * SR), np.float32).tobytes()
assert client.post("/voice/enroll", content=too_long, headers=octet).status_code == 413
r = client.post("/voice/enroll", content=mine.tobytes(), headers=octet)
assert r.status_code == 400 and "at least" in r.json()["detail"], r.text    # 4 s isn't enough
assert client.post("/voice/test", content=mine.tobytes(), headers=octet).status_code == 409
enroll = np.concatenate([speechlike(8, 2)] * 9)
r = client.post("/voice/enroll", content=enroll.tobytes(), headers=octet)
assert r.status_code == 200 and r.json()["enrolled"], r.text
assert client.post("/voice/test", content=speechlike(4, 2).tobytes(), headers=octet).json()["voice"] == "me"
assert client.post("/voice/test", content=speechlike(4, 3).tobytes(), headers=octet).json()["voice"] in ("room", "uncertain")
profile = client.get("/voice/profile").json()
assert profile["enrolled"] and profile["seconds"] >= vp.MIN_ENROLL_S

# ---------------------------------------------------------------- live path
db = SessionLocal()
m = Meeting(title="Voice test")
db.add(m)
db.commit()
mid = m.id
db.close()


class FakeAsr:
    def __init__(self, me, loop):
        self.rings = {"Me": me, "Participant": loop}

    def audio(self, speaker, t0, t1):
        return self.rings[speaker][t0 * SR // 1000: t1 * SR // 1000]


class FakeCoach:
    def __init__(self):
        self.calls = []

    async def on_final(self, speaker, text, t0, t1):
        self.calls.append((speaker, text))


async def live():
    s = realtime.MeetingSession.__new__(realtime.MeetingSession)
    other = speechlike(3, 3)
    s.meeting_id, s.meta, s._bg = mid, {"start": None}, set()
    s.voice = vp.VoiceChecker(vp.load_profile_vector())
    s._voice_order, s._voice_counts = asyncio.Lock(), realtime.Counter()
    s.tracker = la.DecisionTracker()
    s.coach = FakeCoach()
    remote = speechlike(3, 4)
    mic = np.concatenate([speechlike(3, 2), other, through_speakers(remote, 100, 0.3)])
    loop = np.concatenate([np.zeros(6 * SR, np.float32), remote])
    s.asr = FakeAsr(mic + floor(len(mic)), loop)
    for i, (spk, text, t0) in enumerate([("Me", "we will ship on friday", 0), ("Me", "I disagree with that", 3000),
                                         ("Me", "remote words", 6000), ("Participant", "remote words", 6000)]):
        await s._on_asr(AsrEvent("final", spk, f"u{i}", text, t0, t0 + 3000, 1.0))
    while s._bg:
        await asyncio.gather(*list(s._bg))
    return s.coach.calls, s._voice_counts


calls, s_counts = asyncio.run(live())
assert calls == [("Participant", "remote words"), ("Me", "we will ship on friday"),
                 ("Participant", "I disagree with that")], calls        # the echo never reaches the coach
assert dict(s_counts) == {"me": 1, "room": 1, "echo": 1}, s_counts   # logged at meeting end
db = SessionLocal()
rows = {(t.text, t.speaker, t.voice) for t in db.query(Transcript).filter(Transcript.meeting_id == mid)}
db.close()
assert rows == {("we will ship on friday", "Me", "me"), ("I disagree with that", "Me", "room"),
                ("remote words", "Me", "echo"), ("remote words", "Participant", None)}, rows
detail = client.get(f"/meetings/{mid}").json()
assert {t["voice"] for t in detail["transcripts"]} >= {"me", "room"}, detail["transcripts"]

assert client.delete("/voice/profile").json()["deleted"] == 1
db = SessionLocal()
assert db.query(VoiceProfile).count() == 0
db.close()
print("test_voice: OK")
