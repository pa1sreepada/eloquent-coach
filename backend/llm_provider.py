"""Server-agnostic helpers for local OpenAI-compatible LLM servers (Ollama, LM Studio, llama-server, ...).

Every server speaks /v1/chat/completions, but model discovery, "is it loaded?" and the context
window live in server-specific APIs. This module hides those differences.
"""
from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass

import httpx

logger = logging.getLogger(__name__)

OLLAMA = "ollama"
LMSTUDIO = "lmstudio"
GENERIC = "openai"

PROVIDER_NAMES = {OLLAMA: "Ollama", LMSTUDIO: "LM Studio", GENERIC: "LLM server"}
DEFAULT_URLS = {OLLAMA: "http://127.0.0.1:11434/v1", LMSTUDIO: "http://127.0.0.1:1234/v1"}
_PORT_HINTS = {":11434": OLLAMA, ":1234": LMSTUDIO}
PROBE_TIMEOUT_S = 3.0


class LlmError(RuntimeError):
    """A failure worth showing to the user as-is (unreachable server, model can't load, ...)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class ModelInfo:
    id: str
    loaded: bool | None = None          # None when the server can't tell us
    context_length: int | None = None   # context the server will actually use, when known
    size_bytes: int | None = None

    def to_json(self) -> dict:
        return asdict(self)


def api_root(base_url: str) -> str:
    return re.sub(r"/v1/?$", "", base_url.rstrip("/"))


def provider_name(provider: str) -> str:
    return PROVIDER_NAMES.get(provider, PROVIDER_NAMES[GENERIC])


async def _get_json(client: httpx.AsyncClient, url: str):
    try:
        res = await client.get(url, timeout=PROBE_TIMEOUT_S)
        return res.json() if res.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


async def detect_provider(client: httpx.AsyncClient, base_url: str) -> str:
    root = api_root(base_url)
    data = await _get_json(client, f"{root}/api/version")
    if isinstance(data, dict) and "version" in data:
        return OLLAMA
    data = await _get_json(client, f"{root}/api/v0/models")
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return LMSTUDIO
    return GENERIC


def guess_provider(base_url: str) -> str:
    """Offline guess from the URL's default port, for messages when the server is unreachable."""
    return next((p for hint, p in _PORT_HINTS.items() if hint in base_url), GENERIC)


def _is_chat_model(model_id: str, model_type: str = "") -> bool:
    return "embed" not in model_id.lower() and model_type != "embeddings"


async def list_models(client: httpx.AsyncClient, base_url: str, provider: str) -> list[ModelInfo]:
    """Chat models the server offers, loaded ones first. Empty if the server can't be listed."""
    root = api_root(base_url)
    models: list[ModelInfo] = []
    if provider == OLLAMA:
        tags = await _get_json(client, f"{root}/api/tags") or {}
        running = {m.get("name") or m.get("model"): m
                   for m in (await _get_json(client, f"{root}/api/ps") or {}).get("models", [])}
        for m in tags.get("models", []):
            name = m.get("name") or m.get("model") or ""
            if not name or not _is_chat_model(name):
                continue
            ps = running.get(name)
            models.append(ModelInfo(name, loaded=ps is not None,
                                    context_length=(ps or {}).get("context_length"), size_bytes=m.get("size")))
    elif provider == LMSTUDIO:
        for m in (await _get_json(client, f"{root}/api/v0/models") or {}).get("data", []):
            if not _is_chat_model(m.get("id", ""), m.get("type", "")):
                continue
            loaded = m.get("state") == "loaded"
            ctx = m.get("loaded_context_length") if loaded else None
            models.append(ModelInfo(m["id"], loaded=loaded, context_length=ctx or m.get("max_context_length")))
    if not models:   # generic server, or the native API was unavailable
        data = await _get_json(client, f"{base_url.rstrip('/')}/models") or {}
        models = [ModelInfo(m["id"]) for m in data.get("data", []) if m.get("id") and _is_chat_model(m["id"])]
    models.sort(key=lambda m: not m.loaded)   # stable: keeps the server's order within each group
    return models


def pick_model(models: list[ModelInfo]) -> str | None:
    """Prefer a model that's already in memory: no load delay and it's known to fit."""
    return models[0].id if models else None


def error_detail(res: httpx.Response) -> str:
    """The server's own error message (e.g. Ollama's "model requires 16.9 GiB ...")."""
    try:
        data = res.json()
        err = data.get("error", data) if isinstance(data, dict) else data
        if isinstance(err, dict):
            err = err.get("message") or err.get("error") or err
        return str(err)[:300]
    except ValueError:
        return (res.text or res.reason_phrase or "").strip()[:300]


def describe_exception(err: Exception, base_url: str, provider: str | None = None) -> str:
    """One user-facing sentence for an LLM failure."""
    if isinstance(err, LlmError):
        return str(err)
    name = provider_name(provider or guess_provider(base_url))
    if isinstance(err, httpx.ConnectError):
        return f"Can't reach {name} at {base_url}. Is it running?"
    if isinstance(err, httpx.TimeoutException):
        return f"{name} didn't respond in time; the model may still be loading or is too large for this machine."
    if isinstance(err, httpx.HTTPStatusError):
        return f"{name} error {err.response.status_code}: {error_detail(err.response)}"
    return f"{name} call failed: {err}"
