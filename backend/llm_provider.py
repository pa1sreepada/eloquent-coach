"""Server-agnostic helpers for local OpenAI-compatible LLM servers (Ollama, LM Studio, llama-server, ...).

Every server speaks /v1/chat/completions, but model discovery, "is it loaded?" and the context
window live in server-specific APIs. This module hides those differences.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import re
import socket
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

OLLAMA = "ollama"
LMSTUDIO = "lmstudio"
GENERIC = "openai"

PROVIDER_NAMES = {OLLAMA: "Ollama", LMSTUDIO: "LM Studio", GENERIC: "LLM server"}
DEFAULT_URLS = {OLLAMA: "http://127.0.0.1:11434/v1", LMSTUDIO: "http://127.0.0.1:1234/v1"}
_PORT_HINTS = {":11434": OLLAMA, ":1234": LMSTUDIO}
PROBE_TIMEOUT_S = 3.0


API_KEY_ACCOUNT = "llm-api-key"


def _ip(host: str):
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def is_loopback_host(host: str) -> bool:
    host = (host or "").lower().strip("[]")
    ip = _ip(host)
    return host == "localhost" or bool(ip and ip.is_loopback)


def _is_private_host(host: str) -> bool:
    host = (host or "").lower().strip("[]")
    ip = _ip(host)
    if ip:
        return (ip.is_private or ip.is_link_local) and not ip.is_unspecified
    return host.endswith(".local") or host.endswith(".lan") or host.endswith(".home.arpa")


def check_url(url: str, allow_remote: bool) -> str:
    """The URL if it's a safe LLM endpoint, else LlmError with the reason.
    Transcripts are sent to this server, so anything off this Mac must be opted into explicitly,
    and a server on the internet must use https."""
    url = (url or "").strip().rstrip("/")
    try:
        parts = urlsplit(url)
        parts.port   # raises on a malformed port
    except ValueError:
        raise LlmError("API Base URL is not a valid URL.")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LlmError("API Base URL must start with http:// or https:// and include a host.")
    if parts.username or parts.password or "@" in parts.netloc:
        raise LlmError("Don't put credentials in the API Base URL; use the API key field.")
    if parts.query or parts.fragment:
        raise LlmError("API Base URL can't contain a query string or fragment.")
    host = parts.hostname
    if _ip(host.strip("[]")) is not None and _ip(host.strip("[]")).is_unspecified:
        raise LlmError(f"{host} is a listen address, not a server address; use 127.0.0.1.")
    if is_loopback_host(host):
        return url
    if not allow_remote:
        raise LlmError(f"{host} is not on this Mac. Meeting transcripts would be sent there; "
                       "turn on 'Allow an LLM server on another machine' to use it.")
    if parts.scheme != "https" and not _is_private_host(host):
        raise LlmError("A server outside your local network must use https:// so transcripts are encrypted in transit.")
    return url


def is_local_url(url: str) -> bool:
    return is_loopback_host(urlsplit(url or "").hostname or "")


def api_key() -> str | None:
    env = os.environ.get("ELOQUENT_LLM_API_KEY", "").strip()
    if env:
        return env
    try:
        import secure_store
        return secure_store.get_secret(API_KEY_ACCOUNT)
    except Exception as err:  # noqa: BLE001
        logger.warning("LLM API key unavailable: %s", err)
        return None


def client_kwargs() -> dict:
    """httpx.AsyncClient options for every LLM request: the API key (if any), and no redirects,
    so a server can't bounce transcripts (or the key) to another host."""
    key = api_key()
    return {"headers": {"Authorization": f"Bearer {key}"} if key else {}, "follow_redirects": False}


def _lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))   # TEST-NET address: picks the outbound interface, sends nothing
            ip = s.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None


def exposed_on_network(url: str) -> str | None:
    """For a loopback URL: this Mac's LAN address if the same server port also answers there, i.e.
    other machines on the network can use the LLM server too (e.g. OLLAMA_HOST=0.0.0.0, or
    LM Studio's 'Serve on Local Network')."""
    parts = urlsplit(url)
    if not is_loopback_host(parts.hostname or ""):
        return None
    ip = _lan_ip()
    port = parts.port or (443 if parts.scheme == "https" else 80)
    if not ip:
        return None
    try:
        with socket.create_connection((ip, port), timeout=0.3):
            return f"{ip}:{port}"
    except OSError:
        return None


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


# Extra output budget when thinking is on: reasoning tokens count against max_tokens.
THINKING_EXTRA_TOKENS = 1024


def parse_bool(value, default: bool = False) -> bool:
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in ("true", "1", "on", "yes")


def reasoning_fields(provider: str | None, thinking: bool) -> dict:
    """Request fields that turn model thinking on or off.
    `reasoning_effort` is what LM Studio and Ollama's OpenAI endpoint honour ("none" = off; omitted =
    the model's default, which is on for reasoning models). Ollama also gets its native `think` flag."""
    fields: dict = {} if thinking else {"reasoning_effort": "none"}
    if provider == OLLAMA:
        fields["think"] = thinking
    return fields


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
