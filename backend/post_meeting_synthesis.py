"""Post-meeting executive briefing.

Short meetings go to the LLM in one pass. Long ones are summarised in order-preserving chunks sized
to the model's loaded context window (map), then synthesised from those notes (reduce), so nothing
in the middle of a meeting is dropped.
"""
import logging
import re

from coach_engine import mode_focus
from database import Insight, Meeting, SessionLocal, Transcript
from lm_studio_client import LMStudioClient

logger = logging.getLogger(__name__)

SYNTH_OUTPUT_TOKENS = 1200
NOTES_OUTPUT_TOKENS = 800
PROMPT_OVERHEAD_TOKENS = 1100  # system prompt + safety margin (header is counted separately)
MAX_REDUCE_ROUNDS = 3
SECTIONS = ("EXECUTIVE SUMMARY", "ACTION ITEMS", "OPEN QUESTIONS", "STRATEGIC REROUTES")

_BRIEFING = """You are a senior executive coach writing the post-meeting briefing for a leader. In the input, "Me" is the leader and "Participant" is anyone else (individual speakers are not labelled; use a person's name only if it was spoken).

Rules:
- Use only what is in the input. Never invent decisions, owners, dates, numbers or quotes.
- Be concise and specific; reuse the meeting's own terms and numbers. Keep the whole briefing under 450 words.
- Start your reply with the first marker. No planning, preamble, closing remarks or markdown headings.
- Output exactly these four section markers, in this order, each on its own line.

--- EXECUTIVE SUMMARY ---
{summary}

--- ACTION ITEMS ---
{actions}

--- OPEN QUESTIONS ---
Up to 5 bullets: important questions raised but not resolved, including any LIVE COACHING QUESTIONS that were never answered. Write "- None" if there are none.

--- STRATEGIC REROUTES ---
{reroutes}
One line each, numbered, best first, at most 3:
1. ORIGIN: "<exact words Me said>" | ALTERNATIVE: "<what Me could have said instead>" | RATIONALE: <why it works, max 20 words>
ORIGIN must be copied word-for-word from a "Me" line or from LEADER QUOTES, and be a substantive moment (a position, answer, request or question of 8+ words), not filler or small talk. ALTERNATIVE must be a complete sentence Me could really have said in that moment, using the meeting's specifics; never placeholders like X or Y. If nothing qualifies, write: None"""

EXECUTIVE_SYNTHESIS_PROMPT = _BRIEFING.format(
    summary="""Bottom line: <one sentence: the most important outcome, decision or unresolved issue>
Decisions:
- <decision> (or "- None recorded")
Key points:
- 2-4 bullets on what mattered and why
Risks & concerns:
- <risk> (or "- None raised")""",
    actions="""One bullet per commitment: - Owner | Action | Due
Use "Unassigned" or "No date" when not stated. Write "- None" if no commitments were made.""",
    reroutes="""Moments where Me sounded hedged, vague, defensive or rambling, or let a decision slip, each with a stronger executive alternative (bottom line first, specific, confident).""",
)

FIRESIDE_SYNTHESIS_PROMPT = _BRIEFING.format(
    summary="""Bottom line: <one sentence: the guest's core message>
Philosophy:
- 2-3 bullets on the guest's leadership philosophy
Inflection points:
- the pivotal stories or decisions the guest shared
Takeaways:
- 2-3 transferable lessons""",
    actions="""One bullet per principle worth applying: - Principle | What the guest shared | How I'll apply it
Write "- None" if nothing applies.""",
    reroutes="""Moments where Me (the host) asked a surface-level or closed question, interrupted, or moved on before the guest's story reached the decision or lesson, each with a sharper follow-up question.""",
)

MAX_LEADER_NOTES_CHARS = 3000

FOLLOWUP_PROMPT = """You write the follow-up email a senior leader ("Me") sends to the other attendees right after a meeting.

Rules:
- Use only facts in the input. Never invent names, owners, dates or numbers. Use a person's name only if it appears in the input.
- Bottom line first: the outcome or decision in the first sentence after the greeting.
- Then, as short sections only when there is content: "Decisions", "Next steps" (one bullet per item: Owner: action, by when; keep "Unassigned"/"No date" visible so people can claim them), "Open questions".
- Confident, warm, plain English. No filler ("I hope this finds you well"), no hedging. Under 180 words.
- Format: the first line is "Subject: <specific subject, max 9 words>", then a blank line, then "Hi all,", the body, and end with "Thanks," on its own line. Plain text only (no markdown, no asterisks)."""

NOTES_PROMPT = """You take notes on one part of a meeting for a later executive briefing. "Me" is the leader; "Participant" is anyone else. Record only what this part contains, tersely, under these headings:
DECISIONS:
COMMITMENTS: (- owner | action | due, as stated; "Unassigned" / "No date" otherwise)
KEY POINTS:
RISKS/CONCERNS:
OPEN QUESTIONS:
LEADER QUOTES: up to 4 substantive lines (8+ words) copied word-for-word from "Me" (or from existing LEADER QUOTES) that are hedged, vague, defensive or rambling; when Me is hosting a guest, Me's weakest questions.
Start directly with "DECISIONS:". Write "None" under empty headings. Short bullets; at most 180 words in total. Never invent anything. No planning or other text."""

# "--- NAME ---" anywhere (tolerating **bold** / ## wrappers), or NAME alone on its own line.
_NAMES = "|".join(SECTIONS)
_MARKER = re.compile(rf"[#*]*[ \t]*-{{2,}}[ \t]*({_NAMES})[ \t]*-{{2,}}[ \t*#]*"
                     rf"|^[ \t#*>]*({_NAMES})[ \t*:]*$", re.I | re.M)


def _is_fireside(mode: str) -> bool:
    m = (mode or "").lower()
    return "fireside" in m or "guest" in m


def _chunks(text: str, max_chars: int) -> list[str]:
    """Split on line boundaries into pieces of at most ~max_chars."""
    out, cur, size = [], [], 0
    for line in text.split("\n"):
        line = line[:max_chars]
        if cur and size + len(line) + 1 > max_chars:
            out.append("\n".join(cur)); cur, size = [], 0
        cur.append(line); size += len(line) + 1
    if cur:
        out.append("\n".join(cur))
    return out


_PLACEHOLDER = re.compile(r"\b(?:X|Y|Z)\b(?:\s*(?:,|/|and|or)\s*\b(?:X|Y|Z)\b)+|\[[^\]]*\]|<[^>]*>")


def _good_reroute(line: str) -> bool:
    """Keep reroutes with a substantive ORIGIN quote and a concrete (placeholder-free) alternative."""
    parts = line.split("|")
    if len(parts) < 3:
        return False
    origin = parts[0].split(":", 1)[-1].strip(' "\'')
    return len(origin.split()) >= 8 and not _PLACEHOLDER.search(parts[1])


def parse_briefing(raw: str) -> tuple[str, str]:
    """Split LLM output into (summary shown in Reports, reroute lines). Tolerates markdown around markers."""
    marks = list(_MARKER.finditer(raw))
    if not marks:
        return raw.strip(), ""
    sections: dict[str, str] = {}
    for m, nxt in zip(marks, marks[1:] + [None]):
        name = (m.group(1) or m.group(2)).upper()
        sections.setdefault(name, raw[m.end(): nxt.start() if nxt else len(raw)].strip())
    preamble = raw[: marks[0].start()].strip()
    if not sections.get("EXECUTIVE SUMMARY") and preamble:   # model skipped the first marker
        sections["EXECUTIVE SUMMARY"] = preamble
    blocks = []
    for name in SECTIONS[:3]:
        body = sections.get(name, "")
        if body:
            blocks.append(body if name == "EXECUTIVE SUMMARY" else f"{name.title()}:\n{body}")
    reroutes = "\n".join(ln.strip() for ln in sections.get("STRATEGIC REROUTES", "").splitlines()
                         if _good_reroute(ln))
    return "\n\n".join(blocks) or raw.strip(), reroutes


class PostMeetingSynthesis:
    def __init__(self, lm_client: LMStudioClient):
        self.lm_client = lm_client

    def _chars(self, tokens: int) -> int:
        return max(2000, int(tokens * self.lm_client.chars_per_token))

    async def _condense(self, text: str, ctx: int, header_chars: int) -> tuple[str, int]:
        """Map step: replace the transcript with ordered notes until it fits the final prompt.
        Budgets are recomputed each round because chars/token is calibrated from real usage."""
        budget = lambda: self._chars(ctx - PROMPT_OVERHEAD_TOKENS - SYNTH_OUTPUT_TOKENS) - header_chars  # noqa: E731
        rounds = 0
        while len(text) > budget() and rounds < MAX_REDUCE_ROUNDS:
            pieces = _chunks(text, self._chars(ctx - PROMPT_OVERHEAD_TOKENS - NOTES_OUTPUT_TOKENS))
            notes = []
            for i, piece in enumerate(pieces, 1):   # sequential: a local LLM serves one request well at a time
                note = await self.lm_client.complete(
                    NOTES_PROMPT, f"PART {i} OF {len(pieces)}:\n{piece}",
                    max_tokens=NOTES_OUTPUT_TOKENS, temperature=0.2)
                if note:
                    notes.append(f"## Part {i}\n{note}")
            if not notes:
                break
            text, rounds = "\n\n".join(notes), rounds + 1
        if len(text) > budget():   # last resort only; should not happen with sane contexts
            half = budget() // 2
            text = text[:half] + "\n[...]\n" + text[-half:]
        return text, rounds

    async def generate_summary(self, meeting_id: int):
        db = SessionLocal()
        try:
            meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
            if not meeting:
                return "Meeting not found."
            mode = meeting.mode or "General Executive"
            rows = (db.query(Transcript).filter(Transcript.meeting_id == meeting_id)
                    .order_by(Transcript.timestamp.asc()).all())
            if not rows:
                return "No transcript available for synthesis."
            transcript = "\n".join(f"{t.speaker}: {t.text}" for t in rows)
            live_qs = list(dict.fromkeys(
                i.text for i in db.query(Insight).filter(Insight.meeting_id == meeting_id,
                                                         Insight.insight_type == "question")))[:10]

            header = [f"MODE: {mode}\nLENS: {mode_focus(mode)}"]
            if meeting.agenda:
                header.append(f"AGENDA: {meeting.agenda}")
            if live_qs:
                header.append("LIVE COACHING QUESTIONS (suggested to Me during the meeting):\n"
                              + "\n".join(f"- {q}" for q in live_qs))
            if (meeting.notes or "").strip():
                header.append("LEADER NOTES (typed by Me during the meeting; highest-signal input: make sure "
                              "every decision, commitment and concern noted here is reflected):\n"
                              + meeting.notes.strip()[:MAX_LEADER_NOTES_CHARS])

            ctx = await self.lm_client.context_tokens()
            body, rounds = await self._condense(transcript, ctx, sum(len(h) + 2 for h in header) + 100)
            label = ("TRANSCRIPT:" if rounds == 0 else
                     "NOTES (taken in order from consecutive parts of the full transcript):")
            logger.info("synthesis meeting %s: %d chars, ctx %d tok, %d condense round(s)",
                        meeting_id, len(transcript), ctx, rounds)

            system = FIRESIDE_SYNTHESIS_PROMPT if _is_fireside(mode) else EXECUTIVE_SYNTHESIS_PROMPT
            raw = await self.lm_client.complete(system, "\n\n".join(header + [f"{label}\n{body}"]),
                                                max_tokens=SYNTH_OUTPUT_TOKENS, temperature=0.3)
            if not raw:
                return f"Failed to generate synthesis from LLM. {self.lm_client.last_error or ''}".strip()

            meeting.summary, meeting.strategic_alternatives = parse_briefing(raw)
            db.commit()
            return raw
        except Exception as e:  # noqa: BLE001
            logger.error(f"Error generating executive synthesis: {e}")
            return "Error generating synthesis."
        finally:
            db.close()

    async def generate_followup(self, meeting_id: int) -> tuple[str | None, str | None]:
        """Draft a follow-up email. Returns (email, error)."""
        db = SessionLocal()
        try:
            meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
            if not meeting:
                return None, "Meeting not found."
            parts = [f"MEETING TYPE: {meeting.mode or 'General'}"]
            if meeting.agenda:
                parts.append(f"GOAL: {meeting.agenda}")
            if (meeting.notes or "").strip():
                parts.append("MY NOTES:\n" + meeting.notes.strip()[:MAX_LEADER_NOTES_CHARS])
            if meeting.summary:
                parts.append("MEETING BRIEFING:\n" + meeting.summary)
            else:
                rows = (db.query(Transcript).filter(Transcript.meeting_id == meeting_id)
                        .order_by(Transcript.timestamp.asc()).all())
                if not rows and not (meeting.notes or "").strip():
                    return None, "This meeting has no transcript or notes to write from."
                transcript = "\n".join(f"{t.speaker}: {t.text}" for t in rows)
                if transcript:
                    ctx = await self.lm_client.context_tokens()
                    body, rounds = await self._condense(transcript, ctx, sum(len(x) + 2 for x in parts) + 100)
                    parts.append(("TRANSCRIPT:" if rounds == 0 else "MEETING NOTES (in order):") + "\n" + body)
            raw = await self.lm_client.complete(FOLLOWUP_PROMPT, "\n\n".join(parts), max_tokens=500, temperature=0.3)
            email = clean_email(raw)
            if not email:
                return None, (self.lm_client.last_error
                              or "The local LLM returned nothing. Make sure LM Studio or Ollama is running.")
            meeting.followup_email = email
            db.commit()
            return email, None
        except Exception as e:  # noqa: BLE001
            logger.error(f"Error generating follow-up email: {e}")
            return None, "Error generating the follow-up email."
        finally:
            db.close()


def clean_email(raw: str) -> str:
    """Normalise model output: start at the Subject line, drop markdown emphasis and code fences."""
    text = re.sub(r"```\w*", "", raw or "").replace("**", "").strip()
    m = re.search(r"^\s*subject\s*:", text, re.I | re.M)
    if m:
        text = text[m.start():].lstrip()
        text = re.sub(r"^\s*subject\s*:\s*", "Subject: ", text, count=1, flags=re.I)
    return text.strip()
