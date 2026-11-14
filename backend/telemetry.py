"""Deterministic, per-utterance conversation telemetry (fast path, no LLM).

Fed only by ASR `final` events, which carry real audio timestamps, so talk
time, pacing and wait-time come from measured speech rather than word-count
estimates.
"""
from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

ME = "Me"

DEFAULT_FILLERS = ["um", "uh", "ah", "er", "like", "you know", "i mean", "kind of",
                   "sort of", "basically", "literally", "actually"]
HEDGES = ["i think", "i guess", "maybe", "probably", "just", "i feel like",
          "hopefully", "a little bit", "does that make sense"]
OBJECTION_MARKERS = re.compile(
    r"\b(but|however|not sure|concern(ed)?|disagree|push back|risk|worried|can't|won't|don't think)\b", re.I)
COMMITMENT_MARKERS = re.compile(r"\b(we should|let's|we need to|we will|going to|action item|next step)\b", re.I)
OWNER_MARKERS = re.compile(r"\b(i'll|i will|owner|owns|by (monday|tuesday|wednesday|thursday|friday|eod|next week))\b", re.I)
WORD_RE = re.compile(r"[a-z0-9']+")


def _phrase_regex(phrases: list[str]) -> re.Pattern:
    alts = sorted((re.escape(p.strip().lower()) for p in phrases if p.strip()), key=len, reverse=True)
    return re.compile(r"(?<![a-z'])(" + "|".join(alts) + r")(?![a-z'])")


@dataclass
class Utterance:
    speaker: str
    text: str
    t0_ms: int
    t1_ms: int
    words: int
    fillers: int
    hedges: int
    sentiment: float
    is_question: bool

    @property
    def duration_ms(self) -> int:
        return max(1, self.t1_ms - self.t0_ms)


@dataclass
class TelemetrySnapshot:
    talk_share_pct: float           # my voiced time / total voiced time, whole meeting
    talk_share_recent_pct: float    # same, rolling window
    my_wpm: float                   # rolling, from real voiced duration
    filler_per_min: float           # rolling, per minute of my speech
    fillers_total: int
    hedges_total: int
    hedges_recent: int              # my hedges in the rolling window
    monologue_s: float              # my current uninterrupted run
    questions_asked: int
    avg_wait_after_question_s: float
    interruptions_by_me: int
    room_sentiment: float           # EMA of participants' VADER compound, -1..1
    my_voiced_s: float
    others_voiced_s: float
    alerts: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        d = self.__dict__.copy()
        return {"type": "telemetry", **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}}


class SpeechTelemetry:
    def __init__(self, fillers: list[str] | None = None, window_s: int = 300,
                 target_talk_share: float = 40.0):
        self._filler_re = _phrase_regex(fillers or DEFAULT_FILLERS)
        self._hedge_re = _phrase_regex(HEDGES)
        self._sia = SentimentIntensityAnalyzer()
        self.window_ms = window_s * 1000
        self.target_talk_share = target_talk_share
        self.history: deque[Utterance] = deque()
        self._voiced = {ME: 0, "others": 0}
        self._fillers_total = 0
        self._hedges_total = 0
        self._questions = 0
        self._waits: list[float] = []
        self._interruptions = 0
        self._sentiment_ema = 0.0
        self._monologue_start: int | None = None
        self._awaiting_answer_since: int | None = None
        self._last_t1 = 0

    def ingest(self, speaker: str, text: str, t0_ms: int, t1_ms: int) -> Utterance:
        low = text.lower()
        u = Utterance(
            speaker=speaker, text=text, t0_ms=t0_ms, t1_ms=t1_ms,
            words=len(WORD_RE.findall(low)),
            fillers=len(self._filler_re.findall(low)),
            hedges=len(self._hedge_re.findall(low)),
            sentiment=self._sia.polarity_scores(text)["compound"],
            is_question=text.rstrip().endswith("?"),
        )
        prev_other = next((h for h in reversed(self.history) if h.speaker != speaker), None)
        if speaker == ME:
            self._voiced[ME] += u.duration_ms
            self._fillers_total += u.fillers
            self._hedges_total += u.hedges
            self._questions += int(u.is_question)
            if u.is_question or self._awaiting_answer_since is not None:
                self._awaiting_answer_since = t1_ms
            if prev_other and t0_ms < prev_other.t1_ms - 300:
                self._interruptions += 1
            if self._monologue_start is None:
                self._monologue_start = t0_ms
        else:
            self._voiced["others"] += u.duration_ms
            self._sentiment_ema = 0.7 * self._sentiment_ema + 0.3 * u.sentiment
            if self._awaiting_answer_since is not None and 0 < t0_ms - self._awaiting_answer_since < 15_000:
                self._waits.append((t0_ms - self._awaiting_answer_since) / 1000)
            self._awaiting_answer_since = None
            self._monologue_start = None
        self.history.append(u)
        self._last_t1 = max(self._last_t1, t1_ms)
        while self.history and self.history[0].t1_ms < self._last_t1 - self.window_ms:
            self.history.popleft()
        return u

    def snapshot(self) -> TelemetrySnapshot:
        mine = [u for u in self.history if u.speaker == ME]
        others = [u for u in self.history if u.speaker != ME]
        my_ms = sum(u.duration_ms for u in mine)
        other_ms = sum(u.duration_ms for u in others)
        total_all = self._voiced[ME] + self._voiced["others"]
        my_min = my_ms / 60_000
        snap = TelemetrySnapshot(
            talk_share_pct=100 * self._voiced[ME] / total_all if total_all else 0.0,
            talk_share_recent_pct=100 * my_ms / (my_ms + other_ms) if my_ms + other_ms else 0.0,
            my_wpm=sum(u.words for u in mine) / my_min if my_min else 0.0,
            filler_per_min=sum(u.fillers for u in mine) / my_min if my_min else 0.0,
            fillers_total=self._fillers_total,
            hedges_total=self._hedges_total,
            hedges_recent=sum(u.hedges for u in mine),
            monologue_s=(self._last_t1 - self._monologue_start) / 1000 if self._monologue_start is not None else 0.0,
            questions_asked=self._questions,
            avg_wait_after_question_s=sum(self._waits) / len(self._waits) if self._waits else 0.0,
            interruptions_by_me=self._interruptions,
            room_sentiment=self._sentiment_ema,
            my_voiced_s=self._voiced[ME] / 1000,
            others_voiced_s=self._voiced["others"] / 1000,
        )
        if snap.talk_share_recent_pct > self.target_talk_share + 15 and my_ms > 60_000:
            # Executive presence: draw others in rather than just stopping.
            asked = any(u.is_question for u in mine)
            snap.alerts.append("PAUSE & LISTEN" if asked or snap.talk_share_recent_pct < 70 else "INVITE THE ROOM")
        if snap.hedges_recent >= 4 and my_ms > 30_000:
            snap.alerts.append("COMMIT TO A POSITION")
        if snap.monologue_s > 90:
            snap.alerts.append("LAND THE POINT")
        if snap.my_wpm > 175 and my_ms > 20_000:
            snap.alerts.append("SLOW DOWN")
        if snap.filler_per_min > 6 and my_ms > 30_000:
            snap.alerts.append("CUT FILLERS")
        if snap.room_sentiment < -0.25:
            snap.alerts.append("ROOM COOLING")
        return snap
