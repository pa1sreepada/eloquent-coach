"""Deterministic leadership analytics (no LLM, no database): pure functions over transcript lines.

Speaker attribution: "Me" is whatever the microphone heard. On speakers or in a room the mic also picks
up other people, so every meeting gets an attribution rating:
  verified - the other channel carried the other side; echoed lines (the mic repeating the other
             channel) are removed, the rest is the leader.
  mixed    - the mic heard (almost) everyone; "Me" lines can't be trusted as the leader's own words.
Growth trends use verified meetings (plus rehearsals/teleprompter runs, which are the leader alone) unless
the leader includes mixed ones. The leader can override the rating per meeting.
"""
from __future__ import annotations

import calendar
import datetime as dt
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from statistics import mean

from telemetry import COMMITMENT_MARKERS, DEFAULT_FILLERS, HEDGES, OBJECTION_MARKERS, WORD_RE, _phrase_regex

ANALYSIS_VERSION = "3"
ME_SPEAKERS = {"Me", "User"}   # "User" = transcripts from older versions

# ---------------------------------------------------------------- meeting categories
# (id, label, keywords). Matched against the meeting type first, then the title.
CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    ("learning", "Learning (not you speaking)", ("youtube", "learning", "webinar", "training", "course")),
    ("one_on_one", "1:1s", ("1:1", "1-1", "one-on-one", "one on one", "1on1", "skip level", "skip-level", "coaching & feedback")),
    ("all_hands", "All-hands & town halls", ("all hands", "all-hands", "allhands", "town hall", "townhall", "kickoff", "kick-off")),
    ("board", "Board, investors & execs", ("board", "investor", "steerco", "steering", "exec review", "qbr")),
    ("vendor", "Vendors, partners & customers", ("vendor", "supplier", "partner", "customer", "procurement", "negotiation", "deal")),
    ("presenting", "Presenting & hosting", ("fireside", "guest", "keynote", "presentation", "talk", "panel")),
    ("updates", "Updates & reviews", ("update", "status", "standup", "stand-up", "sync", "delivery", "okr", "review", "retro", "incident")),
    ("decisions", "Decisions & conflict", ("decision", "conflict", "escalation")),
]
CATEGORY_LABELS = {c: label for c, label, _ in CATEGORIES} | {"general": "General meetings", "practice": "Practice (rehearsals & teleprompter)"}


def meeting_category(mode: str | None, title: str | None = "") -> str:
    for text in ((mode or "").lower(), (title or "").lower()):
        for cid, _label, keys in CATEGORIES:
            if any(k in text for k in keys):
                return cid
    return "general"


# ---------------------------------------------------------------- language markers
DECISIVE = re.compile(r"\b(i recommend|my recommendation|we will|we'll|i will|i'll|the decision is|i've decided|we've decided|"
                      r"let's|my view is|i propose|i'm confident|the answer is|bottom line|we're going to|my ask is)\b", re.I)
PREAMBLE = re.compile(r"^\s*(so|well|um+|uh+|yeah|okay|ok|great question|good question|that's a (good|great) question|"
                      r"i mean|honestly|let me (think|see)|you know)\b", re.I)
OPEN_Q = re.compile(r"^\s*(what|how|why|which|tell me|walk me|help me|talk me|describe|explain|what's|how's)\b", re.I)
SENTENCE = re.compile(r"[^.?!]+[.?!]?")
_WE = {"we", "us", "our", "ours", "team"}
_I = {"i", "me", "my", "mine"}
_HEDGE_RE = _phrase_regex(HEDGES)
_STOP = set("""about above after again against also because been before being below between both could does doing down
during each from further have having here hers herself himself into itself just like more most other ours ourselves
over same should some such than that their theirs them themselves then there these they this those through under until
very were what when where which while whom will with would your yours yourself yourselves really think know going yeah
okay right sure thing things want need make sort kind actually basically literally maybe probably mean said says
something someone anything everything nothing gonna wanna gotta still even much many well good great work working
time people because there's that's it's we're they're don't can't won't i'm you're let's honestly worried worry
concern concerns concerned disagree push back risk risks however sure though""".split())

METRICS: dict[str, dict] = {
    # direction: lower/higher is better; target: what "good" looks like for an executive.
    "filler_rate": {"label": "Fillers per 100 words", "better": "lower", "target": 2.0},
    "hedge_rate": {"label": "Hedges per 100 words", "better": "lower", "target": 1.0},
    "answer_first_pct": {"label": "Answer-first replies", "better": "higher", "target": 60.0, "unit": "%"},
    "open_question_pct": {"label": "Open questions", "better": "higher", "target": 50.0, "unit": "%"},
    "decisive_rate": {"label": "Decisive statements per 100 words", "better": "higher", "target": 1.5},
    "avg_turn_words": {"label": "Words per turn", "better": "lower", "target": 70.0},
    "we_ratio": {"label": "'We' over 'I'", "better": "higher", "target": 50.0, "unit": "%"},
    "talk_share": {"label": "Your talk share", "better": "lower", "target": 40.0, "unit": "%"},
    "wpm": {"label": "Pace (words/min)", "better": "range", "target": 145.0, "range": (130.0, 165.0)},
}


@dataclass
class Line:
    speaker: str
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    ts: dt.datetime | None = None

    @property
    def mine(self) -> bool:
        return self.speaker in ME_SPEAKERS


def _words(text: str) -> list[str]:
    return WORD_RE.findall((text or "").lower())


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in SENTENCE.findall(text or "") if s.strip()]


def _secs(line: Line) -> float | None:
    if line.start_ms is not None:
        return line.start_ms / 1000
    return line.ts.timestamp() if line.ts else None


def find_echoes(lines: list[Line], window: int = 4, max_gap_s: float = 8.0) -> set[int]:
    """Indices of "Me" lines that repeat a nearby other-channel line (speaker bleed into the mic)."""
    echoes = set()
    for i, ln in enumerate(lines):
        if not ln.mine:
            continue
        mine = set(_words(ln.text))
        if len(mine) < 3:
            continue
        for j in range(max(0, i - window), min(len(lines), i + window + 1)):
            other = lines[j]
            if other.mine:
                continue
            a, b = _secs(ln), _secs(other)
            if a is not None and b is not None and abs(a - b) > max_gap_s:
                continue
            theirs = set(_words(other.text))
            if theirs and len(mine & theirs) / min(len(mine), len(theirs)) >= 0.6:
                echoes.add(i)
                break
    return echoes


def attribution(me_words: int, other_words: int, echo_words: int, override: str | None = None) -> tuple[str, float]:
    """(rating, confidence 0-1) that the "Me" lines are really the leader."""
    if override in ("verified", "mixed", "exclude"):
        return override, {"verified": 1.0, "mixed": 0.3, "exclude": 0.0}[override]
    total = me_words + other_words + echo_words
    if total == 0:
        return "mixed", 0.0
    if other_words == 0 and me_words > 400:
        return "mixed", 0.3        # one mic heard the whole room
    if other_words / total < 0.08 and me_words > 1500:
        return "mixed", 0.4
    conf = 1 - echo_words / max(1, me_words + echo_words)
    return ("verified" if conf >= 0.6 else "mixed"), round(conf, 2)


_SIA = None


def _sentiment(texts: list[str]) -> float | None:
    global _SIA
    texts = [t for t in texts if len(t.split()) >= 3]
    if not texts:
        return None
    if _SIA is None:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        _SIA = SentimentIntensityAnalyzer()
    return round(mean(_SIA.polarity_scores(t)["compound"] for t in texts[-400:]), 3)


def content_terms(text: str, extra: set[str] = frozenset()) -> list[str]:
    return [w for w in _words(text) if (len(w) >= 4 and w not in _STOP and not w.isdigit()) or w in extra]


TURN_PAUSE_S = 4.0


def analyze_meeting(lines: list[Line], fillers: list[str] | None = None, override: str | None = None,
                    jargon: set[str] = frozenset()) -> dict:
    """Per-meeting communication stats for the leader, plus room signals for the team radar."""
    filler_re = _phrase_regex(list(dict.fromkeys((fillers or []) + DEFAULT_FILLERS)))
    echoes = find_echoes(lines)
    kept = [ln for i, ln in enumerate(lines) if i not in echoes]
    me_words = sum(len(_words(ln.text)) for ln in kept if ln.mine)
    other_words = sum(len(_words(ln.text)) for ln in kept if not ln.mine)
    echo_words = sum(len(_words(lines[i].text)) for i in echoes)
    rating, conf = attribution(me_words, other_words, echo_words, override)

    # Turns: consecutive lines from the same side, split at pauses (a mic that hears the whole room
    # never switches side, so without the split one "turn" would be the entire meeting).
    turns: list[tuple[bool, str]] = []
    prev_ts = None
    for ln in kept:
        paused = prev_ts is not None and ln.ts is not None and (ln.ts - prev_ts).total_seconds() > TURN_PAUSE_S
        prev_ts = ln.ts or prev_ts
        if turns and turns[-1][0] == ln.mine and not paused:
            turns[-1] = (ln.mine, f"{turns[-1][1]} {ln.text}")
        else:
            turns.append((ln.mine, ln.text))
    my_turns = [t for m, t in turns if m]

    fillers_n = hedges_n = decisive_n = we = i_n = 0
    questions = open_qs = 0
    for _m, text in [(m, t) for m, t in turns if m]:
        low = text.lower()
        fillers_n += len(filler_re.findall(low))
        hedges_n += len(_HEDGE_RE.findall(low))
        decisive_n += len(DECISIVE.findall(low))
        for w in _words(low):
            we += w in _WE
            i_n += w in _I
        for s in _sentences(text):
            if s.endswith("?"):
                questions += 1
                open_qs += bool(OPEN_Q.match(s))

    replies = answer_first = 0
    for (prev_mine, prev), (mine, text) in zip(turns, turns[1:]):
        if mine and not prev_mine and prev.rstrip().endswith("?"):
            replies += 1
            first = (_sentences(text) or [text])[0]
            if len(_words(first)) <= 25 and not _HEDGE_RE.search(first.lower()) and not PREAMBLE.match(first):
                answer_first += 1

    timed = [ln for ln in kept if ln.mine and ln.start_ms is not None and ln.end_ms is not None and ln.end_ms > ln.start_ms]
    timed_min = sum(ln.end_ms - ln.start_ms for ln in timed) / 60000
    timed_words = sum(len(_words(ln.text)) for ln in timed)

    pct = lambda a, b: round(100 * a / b, 1) if b else None   # noqa: E731
    per100 = lambda n: round(100 * n / me_words, 2) if me_words else None   # noqa: E731
    stats = {
        "me_words": me_words,
        "filler_rate": per100(fillers_n),
        "hedge_rate": per100(hedges_n),
        "decisive_rate": per100(decisive_n),
        "answer_first_pct": pct(answer_first, replies) if replies >= 2 else None,
        "open_question_pct": pct(open_qs, questions) if questions >= 2 else None,
        "avg_turn_words": round(me_words / len(my_turns), 1) if my_turns and rating == "verified" and len(turns) - len(my_turns) >= 3 else None,
        "we_ratio": pct(we, we + i_n) if we + i_n >= 5 else None,
        "talk_share": pct(me_words, me_words + other_words) if rating == "verified" and other_words else None,
        "wpm": round(timed_words / timed_min, 1) if timed_min >= 0.5 else None,
        "questions": questions,
        "replies": replies,
    }

    # The leader's weakest substantive lines, for "say it better" practice.
    weak = []
    for ln in kept:
        if not ln.mine:
            continue
        w = _words(ln.text)
        if len(w) < 12:
            continue
        low = ln.text.lower()
        score = 2 * len(_HEDGE_RE.findall(low)) + len(filler_re.findall(low)) + (len(w) > 45) + bool(PREAMBLE.match(ln.text))
        if score >= 2:
            weak.append({"text": ln.text.strip()[:400], "score": score})
    weak.sort(key=lambda x: -x["score"])

    room = [ln.text for ln in kept if not ln.mine] or ([ln.text for ln in kept] if rating == "mixed" else [])
    concerns: Counter = Counter()
    for text in room:
        for s in _sentences(text):
            if OBJECTION_MARKERS.search(s):
                concerns.update(set(content_terms(s, jargon)))
    return {
        "version": ANALYSIS_VERSION,
        "attribution": rating,
        "confidence": conf,
        "echo_lines": len(echoes),
        "other_words": other_words,
        "stats": stats,
        "weakest": weak[:3],
        "room_sentiment": _sentiment(room),
        "room_questions": sum(t.rstrip().endswith("?") for t in room),
        "room_share": pct(other_words, me_words + other_words) if rating == "verified" else None,
        "concerns": [t for t, _ in concerns.most_common(8)],
    }


def utterance_stats(texts: list[str], fillers: list[str] | None = None) -> dict:
    """Stats for speech that is certainly the leader's (rehearsal answers, teleprompter ad-libs)."""
    return analyze_meeting([Line("Me", t) for t in texts if t.strip()], fillers, override="verified")["stats"]


# ---------------------------------------------------------------- growth
def _direction_good(metric: str, before: float, after: float) -> bool | None:
    m = METRICS[metric]
    if before == after:
        return None
    if m["better"] == "range":
        lo, hi = m["range"]
        dist = lambda v: 0 if lo <= v <= hi else min(abs(v - lo), abs(v - hi))   # noqa: E731
        return dist(after) < dist(before) if dist(after) != dist(before) else None
    return (after < before) if m["better"] == "lower" else (after > before)


def _avg(rows: list[dict], metric: str) -> float | None:
    vals = [r["stats"][metric] for r in rows if r["stats"].get(metric) is not None]
    return round(mean(vals), 2) if vals else None


def _gap(metric: str, value: float) -> float:
    """How far from good, normalised (0 = at or beyond target)."""
    m = METRICS[metric]
    t = m["target"]
    if m["better"] == "range":
        lo, hi = m["range"]
        return 0.0 if lo <= value <= hi else min(abs(value - lo), abs(value - hi)) / t
    off = (value - t) if m["better"] == "lower" else (t - value)
    return max(0.0, off / t)


def growth_report(meetings: list[dict], include_mixed: bool = False) -> dict:
    """meetings: [{id, title, date (datetime), category, attribution, confidence, stats}], any order.
    Compares your first sessions with your latest ones, within each kind of meeting."""
    usable = [m for m in meetings if m["category"] != "learning" and m["attribution"] != "exclude"
              and (m["attribution"] == "verified" or include_mixed) and m["stats"].get("me_words", 0) >= 80]
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for m in sorted(usable, key=lambda m: m["date"]):
        by_cat[m["category"]].append(m)

    categories = {}
    for cat, rows in by_cat.items():
        k = max(1, min(3, len(rows) // 3))
        base, recent = rows[:k], rows[-k:]
        metrics = {}
        for metric in METRICS:
            b, r = _avg(base, metric), _avg(recent, metric)
            if b is None and r is None:
                continue
            metrics[metric] = {"baseline": b, "recent": r,
                               "improving": _direction_good(metric, b, r) if len(rows) > 1 and None not in (b, r) else None,
                               "series": [{"meeting_id": x["id"], "date": x["date"].date().isoformat(),
                                           "value": x["stats"].get(metric)} for x in rows if x["stats"].get(metric) is not None]}
        categories[cat] = {"label": CATEGORY_LABELS.get(cat, cat), "meetings": len(rows), "metrics": metrics}

    # Weekly trend across every usable meeting.
    weeks: dict[str, list[dict]] = defaultdict(list)
    for m in usable:
        y, w, _ = m["date"].isocalendar()
        weeks[f"{y}-W{w:02d}"].append(m)
    weekly = [{"week": wk, "meetings": len(rows), **{k: _avg(rows, k) for k in METRICS}} for wk, rows in sorted(weeks.items())]

    recent = sorted(usable, key=lambda m: m["date"])[-5:]
    focus = []
    for metric in ("filler_rate", "hedge_rate", "answer_first_pct", "open_question_pct", "decisive_rate", "avg_turn_words"):
        v = _avg(recent, metric)
        if v is not None and _gap(metric, v) > 0.15:
            focus.append({"metric": metric, "label": METRICS[metric]["label"], "recent": v,
                          "target": METRICS[metric]["target"], "gap": round(_gap(metric, v), 2)})
    focus.sort(key=lambda f: -f["gap"])

    counted = [m for m in meetings if m["category"] != "learning"]
    return {
        "metrics": METRICS,
        "categories": categories,
        "weekly": weekly,
        "focus": focus[:2],
        "attribution": {
            "verified": sum(m["attribution"] == "verified" for m in counted),
            "mixed": sum(m["attribution"] == "mixed" for m in counted),
            "excluded": sum(m["attribution"] == "exclude" for m in counted),
            "used": len(usable),
        },
    }


# ---------------------------------------------------------------- commitments
_WEEKDAYS = {d.lower(): i for i, d in enumerate(calendar.day_name)} | {d.lower(): i for i, d in enumerate(calendar.day_abbr)}
_MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m} | {m.lower(): i for i, m in enumerate(calendar.month_abbr) if m}
_MONTHS["sept"] = 9


def _month_end(d: dt.date) -> dt.date:
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])


def resolve_due(text: str | None, base: dt.date) -> dt.date | None:
    """Turn "Friday", "EOD", "next week", "Nov 20", "2026-11-20", "in 2 weeks", "Q1" into a date (None if unknown)."""
    t = (text or "").strip().lower()
    if not t or t in ("no date", "none", "n/a", "tbd", "unassigned"):
        return None
    if m := re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", t):
        try:
            return dt.date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    if re.search(r"\b(today|eod|end of (the )?day|tonight|asap|immediately)\b", t):
        return base
    if "tomorrow" in t:
        return base + dt.timedelta(days=1)
    if m := re.search(r"\bin (\d+|a|one|two|three) (day|week|month)s?\b", t):
        n = {"a": 1, "one": 1, "two": 2, "three": 3}.get(m[1]) or int(m[1])
        return base + dt.timedelta(days=n * {"day": 1, "week": 7, "month": 30}[m[2]])
    if m := re.search(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b", t):
        year = int(m[3]) + (2000 if len(m[3]) == 2 else 0) if m[3] else base.year
        try:
            d = dt.date(year, int(m[1]), int(m[2]))
            return d if m[3] or d >= base - dt.timedelta(days=30) else d.replace(year=year + 1)
        except ValueError:
            return None
    if m := re.search(r"\b([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\b", t):
        mon, day = (m[1], m[2]) if m[1] else (m[4], m[3])
        if mon in _MONTHS:
            try:
                d = dt.date(base.year, _MONTHS[mon], int(day))
                return d if d >= base - dt.timedelta(days=30) else d.replace(year=base.year + 1)
            except ValueError:
                return None
    if m := re.search(r"\bq([1-4])\b", t):
        q = int(m[1])
        year = base.year + (1 if q * 3 < base.month else 0)
        return _month_end(dt.date(year, q * 3, 1))
    if re.search(r"\b(end of (the )?month|eom|this month)\b", t):
        return _month_end(base)
    if "next month" in t:
        return _month_end((base.replace(day=1) + dt.timedelta(days=32)))
    if re.search(r"\b(end of (the )?week|eow|this week)\b", t):
        return base + dt.timedelta(days=max(0, 4 - base.weekday()))
    if "next week" in t:
        return base + dt.timedelta(days=7 - base.weekday() + 4)   # Friday next week
    for word in re.findall(r"[a-z]+", t):
        if word in _WEEKDAYS:
            ahead = (_WEEKDAYS[word] - base.weekday()) % 7 or 7
            return base + dt.timedelta(days=ahead + (7 if "next" in t.split(word)[0][-6:] else 0))
    return None


_ACTION_HEADINGS = ("action items", "next steps", "commitments", "owners")
_ACTION_ITEM = re.compile(r"^\s*-\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+?)(?:\s*\(([^()]{1,40})\))?\s*$")


def summary_actions(summary: str | None) -> list[dict]:
    """Commitments from a stored briefing's "Action items" section: [{owner, action, due_text}]."""
    out, in_actions = [], False
    for line in (summary or "").splitlines():
        h = re.match(r"^\s*\*\*([^*]+)\*\*\s*$", line)
        if h:
            in_actions = any(k in h[1].lower() for k in _ACTION_HEADINGS)
            continue
        if not in_actions or not line.strip().startswith("-"):
            continue
        m = _ACTION_ITEM.match(line)
        if m:
            owner, action, due = m[1].strip(), m[2].strip(), (m[3] or "").strip() or None
        else:
            owner, action, due = "Unassigned", line.strip()[1:].strip(), None
        action = action.replace("**", "").strip()
        if action:
            out.append({"owner": owner.replace("**", "")[:80], "action": action[:500], "due_text": due})
    return out


def is_mine(owner: str | None, leader_name: str = "") -> bool:
    o = (owner or "").strip().lower()
    if o in ("me", "i", "myself", "leader", "the leader", "self"):
        return True
    names = [n for n in re.split(r"[\s,]+", leader_name.lower()) if len(n) >= 2]
    return bool(names) and any(n in re.split(r"[\s,/&]+", o) for n in names)


def parse_reroutes(text: str | None) -> list[dict]:
    """Stored "ORIGIN: "…" | ALTERNATIVE: "…" | RATIONALE: …" lines."""
    out = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 2:
            continue
        get = lambda p: re.sub(r"^(?:(?:Me|User|Participant|Speaker \d*):\s*)+", "", re.sub(   # noqa: E731
            r"^\s*(\d+[.)]\s*)?[A-Z]+:\s*", "", p).strip().strip('"“”')).strip()
        origin, alt = get(parts[0]), get(parts[1])
        if origin and alt:
            out.append({"original": origin, "better": alt, "why": get(parts[2]) if len(parts) > 2 else ""})
    return out


# ---------------------------------------------------------------- live decision tracker
_DECISION = re.compile(r"\b(we('ve| have)? decided|the decision is|decision made|let's go with|we'll go with|we're going with|"
                       r"we agree[ds]?\b|agreed[,.!]|it's agreed|approved|sign(ed)? off on|go ahead with|let's proceed|"
                       r"we will proceed|final call|we're aligned)\b", re.I)
_PARKED = re.compile(r"\b(parking lot|park (that|this|it)|take (that|this|it) offline|offline discussion|circle back|"
                     r"revisit (that|this|it)( later)?|table (that|this) for now|separate (meeting|conversation)|"
                     r"follow up separately|another time)\b", re.I)
_OWNER_SELF = re.compile(r"\b(i'll|i will|i can take|i'll own|i own|leave it with me|on me)\b", re.I)
_OWNER_NAMED = re.compile(r"\b([A-Z][a-z]{2,})\s+(will|owns|is going to|can take|to own|'ll)\b")
_NOT_NAMES = {"the", "this", "that", "these", "those", "we", "they", "it", "he", "she", "who", "what", "which", "there",
              "someone", "somebody", "everyone", "everybody", "nobody", "team", "and", "but", "then", "also", "you"}
_TASK = re.compile(r"\b(send|share|follow up|draft|schedule|set up|review|write|prepare|book|reach out|check|update|"
                   r"fix|deliver|ship|own|look into|get back)\b", re.I)


def _clip(sentence: str, n: int = 140) -> str:
    s = re.sub(r"\s+", " ", sentence).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def _named_owner(sentence: str) -> str | None:
    return next((m[1] for m in _OWNER_NAMED.finditer(sentence) if m[1].lower() not in _NOT_NAMES), None)


class DecisionTracker:
    """Catches decisions, commitments (with or without an owner) and parked topics as they're said."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def _dupe(self, kind: str, text: str) -> bool:
        words = set(_words(text))
        for it in self.items[-12:]:
            if it["kind"] == kind:
                other = set(_words(it["text"]))
                if words and other and len(words & other) / min(len(words), len(other)) >= 0.7:
                    return True
        return False

    def ingest(self, speaker: str, text: str, t_ms: int | None = None) -> list[dict]:
        new = []
        for s in _sentences(text):
            if len(_words(s)) < 4:
                continue
            item = None
            if _PARKED.search(s):
                item = {"kind": "parked", "text": _clip(s), "owner": None}
            elif _DECISION.search(s):
                item = {"kind": "decision", "text": _clip(s), "owner": None}
            elif COMMITMENT_MARKERS.search(s) or ((_OWNER_SELF.search(s) or _named_owner(s)) and _TASK.search(s)):
                owner = None
                if _OWNER_SELF.search(s):
                    owner = "Me" if speaker in ME_SPEAKERS else "Participant"
                else:
                    owner = _named_owner(s)
                item = {"kind": "commitment", "text": _clip(s), "owner": owner}
            if item and not self._dupe(item["kind"], item["text"]):
                item.update(speaker=speaker, t_ms=t_ms)
                self.items.append(item)
                new.append(item)
        return new

    def snapshot(self) -> dict:
        pick = lambda k: [{"text": i["text"], "owner": i["owner"]} for i in self.items if i["kind"] == k][-5:]   # noqa: E731
        commitments = [i for i in self.items if i["kind"] == "commitment"]
        return {"type": "tracker",
                "decisions": pick("decision"), "commitments": pick("commitment"), "parked": pick("parked"),
                "counts": {"decisions": sum(i["kind"] == "decision" for i in self.items),
                           "commitments": len(commitments),
                           "unowned": sum(i["owner"] is None for i in commitments),
                           "parked": sum(i["kind"] == "parked" for i in self.items)}}


# ---------------------------------------------------------------- people & team radar
_TITLE_1ON1 = re.compile(r"(?:1:1|1-1|one[- ]on[- ]one|1on1|skip[- ]level)\s*(?:with|w/|[-:–])?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)")
_TITLE_PAIR = re.compile(r"\b([A-Z][a-z]{2,})\s*(?:/|<>|&|\bx\b)\s*([A-Z][a-z]{2,})\b")


def parse_attendees(text: str | None) -> list[str]:
    out = []
    for part in re.split(r"[,;\n]+", text or ""):
        name = re.sub(r"\s+", " ", part).strip()[:60]
        if name and name.lower() not in (n.lower() for n in out):
            out.append(name)
    return out[:30]


def people_in(title: str | None, attendees: str | None, leader_name: str = "") -> list[str]:
    names = parse_attendees(attendees)
    for rx in (_TITLE_1ON1, _TITLE_PAIR):
        for m in rx.finditer(title or ""):
            names += [g for g in m.groups() if g]
    me = {n for n in re.split(r"\s+", leader_name.lower()) if n}
    seen, out = set(), []
    for n in names:
        key = n.lower()
        if key not in seen and key.split()[0] not in me and key not in ("meeting", "sync", "team"):
            seen.add(key)
            out.append(n)
    return out


def team_radar(meetings: list[dict], today: dt.date) -> list[dict]:
    """meetings: [{id, title, date, category, people, analysis}]. One card per person with flags worth acting on."""
    per: dict[str, list[dict]] = defaultdict(list)
    for m in sorted(meetings, key=lambda m: m["date"]):
        for p in m["people"]:
            per[p].append(m)
    radar = []
    for person, rows in per.items():
        ones = [r for r in rows if r["category"] == "one_on_one"]
        sent = [r["analysis"]["room_sentiment"] for r in rows if r["analysis"].get("room_sentiment") is not None]
        share = [r["analysis"]["room_share"] for r in ones if r["analysis"].get("room_share") is not None]
        concern_counts = Counter(t for r in rows for t in set(r["analysis"].get("concerns", [])))
        last = rows[-1]["date"].date()
        flags = []
        if len(sent) >= 4:
            before, after = mean(sent[:-2]), mean(sent[-2:])
            if after - before < -0.15:
                flags.append(f"Mood dropping: room sentiment {before:+.2f} → {after:+.2f} in recent meetings")
        if len(share) >= 3:
            if mean(share[-2:]) < mean(share[:-2]) - 10:
                flags.append(f"Getting quieter in 1:1s: {mean(share[:-2]):.0f}% → {mean(share[-2:]):.0f}% of the talking")
            elif mean(share[-2:]) < 30:
                flags.append(f"Talks only {mean(share[-2:]):.0f}% of your 1:1s; ask more, tell less")
        if ones and (today - ones[-1]["date"].date()).days > 21:
            flags.append(f"No 1:1 in {(today - ones[-1]['date'].date()).days} days")
        recurring = [t for t, n in concern_counts.most_common(5) if n >= 2]
        if recurring:
            flags.append("Recurring concerns: " + ", ".join(recurring[:3]))
        radar.append({
            "person": person, "meetings": len(rows), "one_on_ones": len(ones), "last_met": last.isoformat(),
            "days_since": (today - last).days,
            "sentiment": [{"date": r["date"].date().isoformat(), "value": r["analysis"]["room_sentiment"]}
                          for r in rows if r["analysis"].get("room_sentiment") is not None],
            "share": share, "concerns": recurring, "flags": flags,
        })
    radar.sort(key=lambda r: (-len(r["flags"]), r["days_since"]))
    return radar


def team_concerns(meetings: list[dict], today: dt.date, days: int = 14) -> list[dict]:
    """Concern terms that are rising across all meetings: recent window vs the period before it."""
    cut = today - dt.timedelta(days=days)
    recent, before = Counter(), Counter()
    for m in meetings:
        (recent if m["date"].date() >= cut else before).update(set(m["analysis"].get("concerns", [])))
    n_before = max(1, sum(1 for m in meetings if m["date"].date() < cut))
    n_recent = max(1, sum(1 for m in meetings if m["date"].date() >= cut))
    rising = [{"term": t, "recent": c, "before": before[t]}
              for t, c in recent.most_common(20) if c >= 2 and c / n_recent > 1.5 * before[t] / n_before]
    return rising[:8]
