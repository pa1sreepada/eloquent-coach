"""Tell the leader's voice apart from everyone else on the mic, without changing how audio is captured.

The mic channel ("Me") hears the leader, but on speakers or in a room it also hears other people.
Each finished mic utterance gets one label:

  me        - matches the enrolled voice profile
  room      - clearly someone else (another person in the room)
  echo      - the mic re-hearing the loopback channel (remote voices through the speakers)
  uncertain - too short or too ambiguous to call

Two independent checks, both local:
  * speaker verification: a TitaNet-small embedding (sherpa-onnx) compared with the enrolled voiceprint;
  * acoustic bleed: spectro-temporal correlation of the mic against the time-aligned loopback audio.
The bleed check needs no enrollment. Only the voiceprint (an embedding) is stored, never audio.
"""
from __future__ import annotations

import json
import logging
import threading

import numpy as np

from model_files import SPK_FILE, SPK_REPO

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
# Cosine similarity to the profile. Measured on LibriSpeech (14 speakers): same speaker p5 = 0.39 at 1 s
# and 0.52 at 1.5 s; different speakers max 0.41, p99 0.28-0.34.
ME_THRESHOLD = 0.40
ROOM_THRESHOLD = 0.25
MIN_VERIFY_S = 1.0          # shorter utterances ("yes", "okay") are not scored
BLEED_THRESHOLD = 0.5       # own voice vs independent loopback p99 = 0.35; simulated bleed median 0.7
MIN_ENROLL_S = 20.0
MAX_ENROLL_S = 120.0
VOICES = ("me", "room", "echo", "uncertain")

_extractor = None
_extractor_lock = threading.Lock()


def _get_extractor():
    global _extractor
    with _extractor_lock:
        if _extractor is None:
            import sherpa_onnx

            from asr_service import fetch_model
            path = fetch_model(SPK_REPO, SPK_FILE)
            _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
                sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=path, num_threads=2))
            logger.info("voice model loaded: %s", path)
        return _extractor


def embed(pcm: np.ndarray) -> np.ndarray:
    """Unit-length speaker embedding of 16 kHz mono float audio."""
    ex = _get_extractor()
    with _extractor_lock:   # one stream at a time; the extractor isn't documented as thread-safe
        s = ex.create_stream()
        s.accept_waveform(SAMPLE_RATE, np.ascontiguousarray(pcm, dtype=np.float32))
        s.input_finished()
        e = np.asarray(ex.compute(s), dtype=np.float32)
    n = float(np.linalg.norm(e))
    return e / n if n else e


def speech_only(pcm: np.ndarray, frame: int = 480) -> np.ndarray:
    """Drop silent 30 ms frames (energy 35 dB below the loud frames) so pauses don't dilute a voiceprint."""
    n = len(pcm) // frame
    if n == 0:
        return pcm
    frames = pcm[: n * frame].reshape(n, frame)
    db = 10 * np.log10(np.mean(frames ** 2, axis=1) + 1e-10)
    keep = db > np.percentile(db, 95) - 35
    return frames[keep].reshape(-1) if keep.any() else pcm


# ---------------------------------------------------------------- acoustic bleed
_HOP, _NFFT, _BANDS = 160, 512, 24
_window = np.hanning(_NFFT).astype(np.float32)


def _band_edges() -> np.ndarray:
    mel = lambda f: 2595 * np.log10(1 + f / 700)        # noqa: E731
    imel = lambda m: 700 * (10 ** (m / 2595) - 1)        # noqa: E731
    hz = imel(np.linspace(mel(100), mel(7000), _BANDS + 1))
    return np.clip((hz / (SAMPLE_RATE / 2) * (_NFFT // 2)).astype(int), 1, _NFFT // 2)


_EDGES = _band_edges()


def _bands(x: np.ndarray) -> np.ndarray:
    """Log energy in 24 mel-spaced bands, 10 ms hop: shape (frames, bands)."""
    n = (len(x) - _NFFT) // _HOP + 1
    if n <= 0:
        return np.zeros((0, _BANDS), dtype=np.float32)
    idx = np.arange(_NFFT)[None, :] + _HOP * np.arange(n)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * _window, axis=1)) ** 2
    out = np.stack([spec[:, _EDGES[i]:max(_EDGES[i + 1], _EDGES[i] + 1)].sum(1) for i in range(_BANDS)], 1)
    return np.log10(out + 1e-9)


def bleed_score(mic: np.ndarray | None, loop: np.ndarray | None, max_lag_ms: int = 500) -> float:
    """0-1: how much the mic audio looks like a delayed, room-filtered copy of the loopback audio."""
    if mic is None or loop is None:
        return 0.0
    m, lp = _bands(mic), _bands(loop)
    n = min(len(m), len(lp))
    if n < 60:
        return 0.0
    m, lp = m[:n], lp[:n]
    loud = lp.max(1)
    if loud.max() - np.median(loud) < 1.0:      # loopback silent (or flat noise)
        return 0.0
    best = 0.0
    for lag in range(0, max_lag_ms // 10 + 1):
        a, b = m[lag:], lp[:n - lag]
        live = b.max(1) > np.percentile(b.max(1), 40)   # frames where the loopback is speaking
        if live.sum() < 30:
            break
        a = a[live] - a[live].mean(0)
        b = b[live] - b[live].mean(0)
        c = float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum() + 1e-9))
        best = max(best, c)
    return round(best, 3)


# ---------------------------------------------------------------- decision
def classify(similarity: float | None, bleed: float, seconds: float) -> str | None:
    """Label one mic utterance. similarity is None when there is no profile (or the clip is too short)."""
    if similarity is not None and similarity >= ME_THRESHOLD:
        return "me"
    if bleed >= BLEED_THRESHOLD:
        return "echo"
    if similarity is None:
        return None
    if similarity < ROOM_THRESHOLD and seconds >= MIN_VERIFY_S:
        return "room"
    return "uncertain"


class VoiceChecker:
    """Per-meeting checker: holds the enrolled voiceprint (if any)."""

    def __init__(self, profile: np.ndarray | None):
        self.profile = profile

    @classmethod
    def load(cls) -> "VoiceChecker":
        profile = load_profile_vector()
        if profile is not None:
            try:
                _get_extractor()
            except Exception:   # noqa: BLE001 - model missing/offline: fall back to the bleed check only
                logger.exception("voice model unavailable; voice verification is off for this meeting")
                profile = None
        return cls(profile)

    @property
    def verifying(self) -> bool:
        return self.profile is not None

    def check(self, mic: np.ndarray | None, loop: np.ndarray | None) -> tuple[str | None, float | None]:
        """(voice label or None, similarity or None) for one finished mic utterance."""
        if mic is None or len(mic) == 0:
            return None, None
        seconds = len(mic) / SAMPLE_RATE
        bleed = bleed_score(mic, loop)
        sim = None
        if self.profile is not None:
            speech = speech_only(mic)
            if len(speech) / SAMPLE_RATE >= MIN_VERIFY_S:
                sim = round(float(embed(speech) @ self.profile), 3)
        voice = classify(sim, bleed, seconds)
        if voice is None and self.profile is not None:
            voice = "uncertain"
        return voice, sim


# ---------------------------------------------------------------- profile storage
def load_profile_vector() -> np.ndarray | None:
    from database import SessionLocal, VoiceProfile
    db = SessionLocal()
    try:
        row = db.query(VoiceProfile).order_by(VoiceProfile.id.desc()).first()
        if not row or row.model != SPK_FILE:
            return None
        v = np.asarray(json.loads(row.embedding), dtype=np.float32)
        return v / (np.linalg.norm(v) or 1)
    finally:
        db.close()


def build_profile(pcm: np.ndarray) -> dict:
    """Voiceprint from an enrollment recording: mean of per-chunk embeddings, plus a consistency score."""
    speech = speech_only(pcm)
    seconds = len(speech) / SAMPLE_RATE
    if seconds < MIN_ENROLL_S:
        raise ValueError(f"Only {seconds:.0f} s of speech was heard. Read for at least {MIN_ENROLL_S:.0f} s.")
    chunk = int(8 * SAMPLE_RATE)
    parts = [speech[i:i + chunk] for i in range(0, len(speech) - chunk // 2, chunk)]
    embs = [embed(p) for p in parts if len(p) >= SAMPLE_RATE * 3]
    mean = np.mean(embs, axis=0)
    mean = mean / (np.linalg.norm(mean) or 1)
    sims = [float(e @ mean) for e in embs]
    return {"embedding": mean, "seconds": round(seconds, 1), "quality": round(float(np.mean(sims)), 3),
            "worst": round(min(sims), 3)}
