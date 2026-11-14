"""Voice profile API: enroll, test and delete the leader's voiceprint (see voiceprint.py)."""
from __future__ import annotations

import asyncio
import json

import numpy as np
from fastapi import APIRouter, HTTPException, Request

import voiceprint as vp
from database import SessionLocal, Transcript, VoiceProfile
from model_files import SPK_FILE

router = APIRouter(prefix="/voice", tags=["voice"])

MAX_TEST_S = 20.0


async def _read_pcm(request: Request, max_seconds: float) -> np.ndarray:
    """Raw 16 kHz mono float32 little-endian audio from the request body (never written to disk)."""
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/octet-stream":
        raise HTTPException(415, "Send raw 16 kHz float32 audio as application/octet-stream.")
    limit = int(max_seconds * vp.SAMPLE_RATE * 4)
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > limit:
            raise HTTPException(413, f"Recording is longer than {max_seconds:.0f} seconds.")
    if not buf or len(buf) % 4:
        raise HTTPException(400, "Audio must be whole float32 samples.")
    pcm = np.frombuffer(bytes(buf), dtype="<f4").astype(np.float32)
    if not np.isfinite(pcm).all():
        raise HTTPException(400, "Audio contains invalid samples.")
    return np.clip(pcm, -1.0, 1.0)


def _profile_json(row: VoiceProfile | None) -> dict:
    if not row or row.model != vp.SPK_FILE:
        return {"enrolled": False}
    return {"enrolled": True, "created_at": row.created_at.isoformat() if row.created_at else None,
            "seconds": row.seconds, "quality": row.quality}


def _usage() -> dict:
    """How mic lines in recent meetings were labelled, so the leader can see it working."""
    from sqlalchemy import func
    db = SessionLocal()
    try:
        rows = (db.query(Transcript.voice, func.count(Transcript.id))
                .filter(Transcript.voice.isnot(None)).group_by(Transcript.voice).all())
        return {v: n for v, n in rows}
    finally:
        db.close()


@router.get("/profile")
def get_profile():
    db = SessionLocal()
    try:
        row = db.query(VoiceProfile).order_by(VoiceProfile.id.desc()).first()
        return {**_profile_json(row), "labels": _usage(),
                "min_seconds": vp.MIN_ENROLL_S, "max_seconds": vp.MAX_ENROLL_S}
    finally:
        db.close()


def _save(profile: dict) -> dict:
    db = SessionLocal()
    try:
        db.query(VoiceProfile).delete()
        row = VoiceProfile(model=SPK_FILE, embedding=json.dumps([round(float(x), 6) for x in profile["embedding"]]),
                           seconds=profile["seconds"], quality=profile["quality"])
        db.add(row)
        db.commit()
        return _profile_json(row)
    finally:
        db.close()


@router.post("/enroll")
async def enroll(request: Request):
    pcm = await _read_pcm(request, vp.MAX_ENROLL_S)
    try:
        profile = await asyncio.to_thread(vp.build_profile, pcm)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:   # noqa: BLE001 - model download / load failures
        raise HTTPException(503, f"Voice model unavailable: {e}") from e
    if profile["worst"] < vp.ME_THRESHOLD:
        raise HTTPException(400, "The recording sounds like more than one voice or has a lot of noise. "
                                 "Record again somewhere quiet, reading on your own.")
    saved = await asyncio.to_thread(_save, profile)
    return {**saved, "message": "Voice profile saved. Meetings from now on will label your mic lines."}


@router.post("/test")
async def test(request: Request):
    """Score a short clip against the profile, so the leader can check it recognises them."""
    pcm = await _read_pcm(request, MAX_TEST_S)
    vec = await asyncio.to_thread(vp.load_profile_vector)
    if vec is None:
        raise HTTPException(409, "Record a voice profile first.")
    checker = vp.VoiceChecker(vec)
    try:
        voice, sim = await asyncio.to_thread(checker.check, pcm, None)
    except Exception as e:   # noqa: BLE001
        raise HTTPException(503, f"Voice model unavailable: {e}") from e
    return {"voice": voice, "similarity": sim, "me_threshold": vp.ME_THRESHOLD, "room_threshold": vp.ROOM_THRESHOLD}


@router.delete("/profile")
def delete_profile():
    db = SessionLocal()
    try:
        n = db.query(VoiceProfile).delete()
        db.commit()
        return {"deleted": n}
    finally:
        db.close()
