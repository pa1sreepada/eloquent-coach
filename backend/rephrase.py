"""Rephrase: turn a rough draft (typed or dictated) into ready-to-send options in the leader's voice.

The style prompt is the user's own and is stored in the encrypted database (AppConfig "rephrase_prompt");
DEFAULT_PROMPT is used until they save one. Output parsing doesn't depend on the prompt: FORMAT_RULES is
always appended so each option arrives as "**Name**" + text, separated by "---".
"""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import AppConfig, get_db
import leadership

router = APIRouter()

CONFIG_KEY = "rephrase_prompt"
MAX_DRAFT = 6000
MAX_PROMPT = 8000

DEFAULT_PROMPT = """You are my executive communication and writing partner. Transform every rough draft, Slack message, email or thought I share into three ready-to-send options in my voice.

### 1. Context & working style
* Role: a senior leader driving cross-functional work with engineering, product, security, marketing and vendors.
* Communication DNA:
  * Candid & pragmatic: surface capacity crunches, critical-path risks and trade-offs transparently; never sugarcoat blockers.
  * Accountable & firm: hold partners accountable for impact, ownership and prioritisation rather than silently absorbing gaps.
  * Empowering & direct: give trusted peers clear autonomy, recognise strong work authentically, and protect the team's bandwidth.
* Domain precision: keep exact system names, acronyms, metrics and dates; never dumb down technical details.

### 2. Output format
Always output three distinct options separated by `---` (unless I ask for a single format):
1. **Professional & Executive** (leadership, email, alignment syncs): strategic, polished and structured; firm on risks and trade-offs; crisp bullets for multi-part updates.
2. **Collaborative & Conversational** (cross-team Slack, 1:1s): a natural peer-to-peer tone that drives alignment without sounding stiff.
3. **Short & Direct** (quick status checks, triage threads): high-signal and zero filler, keeping every fact, date and ask.
If the message is not about work (for example a vendor or contractor follow-up), use **Polite & Firm**, **Friendly & Direct** and **Short & Crisp** instead, keeping my direct, action-oriented voice.

### 3. Guardrails
* Zero fluff: start immediately with option 1. No greetings, preambles or explanations of your edits.
* Fidelity: fix grammar, typos and run-on sentences while preserving my exact intent; never invent timelines, commitments or facts I didn't state.
* Action-oriented: make every ask, escalation or decision point stand out clearly at the end of the message."""

FORMAT_RULES = """

Output format (always): start each option with its name in bold on its own line (for example **Short & Direct**), then the ready-to-send message. Separate options with a line containing only ---. Output nothing else: no preamble, notes or explanations."""

STYLES = {   # key -> (work name, non-work name)
    "executive": ("Professional & Executive", "Polite & Firm"),
    "conversational": ("Collaborative & Conversational", "Friendly & Direct"),
    "direct": ("Short & Direct", "Short & Crisp"),
}


def current_prompt(db: Session) -> str:
    row = db.query(AppConfig).filter(AppConfig.key == CONFIG_KEY).first()
    return row.value if row and (row.value or "").strip() else DEFAULT_PROMPT


def build_request(text: str, style: str = "all", context: str = "auto", label: str = "", instruction: str = "") -> str:
    parts = [f"DRAFT:\n{text.strip()}"]
    if context == "work":
        parts.append("This is a work message.")
    elif context == "personal":
        parts.append("This is not a work message (for example a vendor, contractor or personal follow-up).")
    if label:
        parts.append(f"Give only one option, named **{label}**.")
    elif style in STYLES:
        work, other = STYLES[style]
        name = other if context == "personal" else work if context == "work" else f"{work} (or {other} if this isn't a work message)"
        parts.append(f"Give only one option: the {name} one.")
    if instruction.strip():
        parts.append(f"Also: {instruction.strip()}")
    return "\n\n".join(parts)


_SEPARATOR = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$", re.M)
_LABEL_LINE = re.compile(r"^\s*(?:#{1,6}\s*|\*\*|__|option\s*\d)", re.I)


def _clean_label(line: str) -> str:
    s = re.sub(r"[#*_`]", "", line).strip()
    s = re.sub(r"^(?:option\s*\d+|\d+[.)])\s*[:.\-–—]?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*\([^)]*\)\s*", " ", s)   # "(Leadership, Emails)" routing hints
    return s.strip(" :-–—")[:60]


def parse_options(raw: str, fallback: list[str] | None = None) -> list[dict]:
    """Split the reply into [{label, text}]. Unlabelled chunks before the first labelled one (a leaked
    preamble or reasoning) are dropped when labelled options exist."""
    names = fallback or [w for w, _ in STYLES.values()]
    chunks = [c.strip() for c in _SEPARATOR.split(raw or "") if c.strip()]
    out = []
    for c in chunks:
        first, _, rest = c.partition("\n")
        if _LABEL_LINE.match(first) and _clean_label(first) and (rest.strip() or len(chunks) == 1):
            out.append({"label": _clean_label(first), "text": rest.strip(), "labelled": True})
        else:
            # A label may sit on a later line after leaked preamble: "Sure!\n**Short & Direct**\n..."
            m = re.search(r"^\s*\*\*([^*\n]{2,60})\*\*\s*:?\s*$", c, re.M)
            if m and c[m.end():].strip():
                out.append({"label": _clean_label(m.group(0)), "text": c[m.end():].strip(), "labelled": True})
            else:
                out.append({"label": "", "text": c, "labelled": False})
    if any(o["labelled"] for o in out):
        first = next(i for i, o in enumerate(out) if o["labelled"])
        out = out[first:]
    for i, o in enumerate(out):
        o["label"] = o["label"] or (names[i] if i < len(names) else f"Option {i + 1}")
        o.pop("labelled")
    return [o for o in out if o["text"]]


class PromptIn(BaseModel):
    prompt: str = Field("", max_length=MAX_PROMPT)


class RephraseIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_DRAFT)
    style: Literal["all", "executive", "conversational", "direct"] = "all"
    context: Literal["auto", "work", "personal"] = "auto"
    label: str = Field("", max_length=60)          # refine one existing option, keeping its name
    instruction: str = Field("", max_length=300)   # e.g. "make it shorter"


@router.get("/rephrase/prompt")
def get_prompt(db: Session = Depends(get_db)):
    prompt = current_prompt(db)
    return {"prompt": prompt, "default": DEFAULT_PROMPT, "custom": prompt != DEFAULT_PROMPT}


@router.put("/rephrase/prompt")
def put_prompt(body: PromptIn, db: Session = Depends(get_db)):
    prompt = body.prompt.strip()
    row = db.query(AppConfig).filter(AppConfig.key == CONFIG_KEY).first()
    if not prompt or prompt == DEFAULT_PROMPT:   # empty = back to the default
        if row:
            db.delete(row)
    elif row:
        row.value = prompt
    else:
        db.add(AppConfig(key=CONFIG_KEY, value=prompt))
    db.commit()
    return get_prompt(db)


@router.post("/rephrase")
async def rephrase(body: RephraseIn, db: Session = Depends(get_db)):
    if not body.text.strip():
        raise HTTPException(400, "Type or dictate something to rephrase.")
    single = bool(body.label) or body.style != "all"
    system = current_prompt(db) + FORMAT_RULES
    raw = await leadership._ask_llm(system, build_request(body.text, body.style, body.context, body.label, body.instruction),
                                    max_tokens=1200 if single else 2400, temperature=0.5)
    fallback = [body.label] if body.label else [STYLES[body.style][body.context == "personal"]] if single else None
    options = parse_options(raw, fallback)
    if single:
        options = options[-1:]   # the model sometimes repeats the draft first; the last option is the answer
        if body.label and options:
            options[0]["label"] = body.label
    if not options:
        raise HTTPException(502, "The LLM didn't return any options. Try again, or check the LLM in Settings.")
    return {"options": options}
