"""Optional external (cloud) LLM for post-meeting work: summaries, follow-up emails and teleprompter
polish. Live coaching cards always stay on the local server (latency, and live audio never leaves the Mac).

Any provider implementing the OpenAI chat-completions API works. Keys live in the OS credential store
(one per provider, see secure_store.set_secret), are never written to the database, never returned by
the API and are redacted from error messages.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

import llm_provider
import secure_store

# Room for hidden reasoning (o-series / GPT-5 / Gemini / Claude thinking) on top of the visible answer.
REASONING_BUDGET = 4096
CONTEXT_TOKENS = 100_000   # every supported frontier model offers at least this; keeps summaries in one request


@dataclass(frozen=True)
class Provider:
    label: str
    url: str           # "" = the user supplies the URL
    model_hint: str
    url_hint: str = ""


PROVIDERS: dict[str, Provider] = {
    "openai": Provider("OpenAI", "https://api.openai.com/v1", "e.g. gpt-5-mini"),
    "anthropic": Provider("Anthropic (Claude)", "https://api.anthropic.com/v1", "e.g. claude-sonnet-4-5"),
    "gemini": Provider("Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "e.g. gemini-2.5-flash"),
    "openrouter": Provider("OpenRouter", "https://openrouter.ai/api/v1", "e.g. openai/gpt-5-mini"),
    "groq": Provider("Groq", "https://api.groq.com/openai/v1", "e.g. llama-3.3-70b-versatile"),
    "azure": Provider("Azure OpenAI", "", "your deployment name",
                      "https://<resource>.openai.azure.com/openai/v1"),
    "custom": Provider("Other OpenAI-compatible API", "", "model ID", "https://…/v1"),
}
# Model IDs that can't write text (listed by /models on OpenAI and others).
_NON_CHAT = ("embed", "tts", "whisper", "dall-e", "moderation", "transcribe", "audio", "realtime", "image",
             "sora", "davinci", "babbage", "computer-use", "search")


def key_account(provider: str) -> str:
    return f"external-llm-key-{provider}"


def api_key(provider: str) -> str | None:
    env = os.environ.get("ELOQUENT_EXTERNAL_LLM_API_KEY", "").strip()
    return env or secure_store.get_secret(key_account(provider))


def set_api_key(provider: str, key: str | None) -> None:
    if provider not in PROVIDERS:
        raise llm_provider.LlmError("Unknown provider.")
    key = (key or "").strip()
    if len(key) > 4096 or any(c in key for c in "\r\n\0"):
        raise llm_provider.LlmError("Invalid API key.")
    secure_store.set_secret(key_account(provider), key or None)


def resolve_url(provider: str, url: str | None) -> str:
    """The endpoint for `provider`: the preset's, or the user's (custom / Azure). https unless on this Mac."""
    if provider not in PROVIDERS:
        raise llm_provider.LlmError("Choose an external LLM provider.")
    url = PROVIDERS[provider].url or (url or "").strip()
    if not url:
        raise llm_provider.LlmError(f"Enter the API Base URL for {PROVIDERS[provider].label}.")
    url = llm_provider.check_url(url, allow_remote=True)
    if urlsplit(url).scheme != "https" and not llm_provider.is_local_url(url):
        raise llm_provider.LlmError("An external LLM must use https:// so transcripts are encrypted in transit.")
    return url


def client_kwargs(provider: str) -> dict:
    headers = {}
    key = api_key(provider)
    if key:
        headers["Authorization"] = f"Bearer {key}"
        if provider == "anthropic":   # its /models endpoint takes Anthropic's own auth headers
            headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
        elif provider == "azure":
            headers["api-key"] = key
    try:
        from model_files import use_system_trust_store
        use_system_trust_store()   # corporate TLS-inspecting proxies
    except Exception:  # noqa: BLE001
        pass
    return {"headers": headers, "follow_redirects": False}


def redact(text: str, provider: str) -> str:
    key = api_key(provider)
    return text.replace(key, "[API key]") if key and len(key) >= 8 else text


@dataclass
class Target:
    provider: str
    url: str
    model: str

    @property
    def label(self) -> str:
        return PROVIDERS[self.provider].label


def target_from_settings(c: dict) -> Target | None:
    """The external target if it's enabled and complete in Settings, else None (use the local LLM)."""
    if not llm_provider.parse_bool(c.get("external_llm_enabled")):
        return None
    provider = c.get("external_llm_provider") or ""
    model = (c.get("external_llm_model") or "").strip()
    if not model:
        raise llm_provider.LlmError("External LLM is on but no model is set (Settings → External frontier model).")
    return Target(provider, resolve_url(provider, c.get("external_llm_url")), model)


async def list_models(client: httpx.AsyncClient, target: Target) -> list[str]:
    res = await client.get(f"{target.url}/models", timeout=10.0)
    if res.status_code >= 400:
        raise llm_provider.LlmError(
            f"{target.label} error {res.status_code}: {redact(llm_provider.error_detail(res), target.provider)}",
            status=res.status_code)
    ids = {str(m.get("id", "")).removeprefix("models/") for m in (res.json().get("data") or []) if isinstance(m, dict)}
    return sorted(i for i in ids if i and not any(k in i.lower() for k in _NON_CHAT))


async def chat(client: httpx.AsyncClient, target: Target, system: str, user: str, *,
               max_tokens: int, temperature: float | None) -> dict:
    """One chat completion. Adapts to the API's quirks: newer OpenAI models want max_completion_tokens
    and reject a custom temperature."""
    limit_field = "max_completion_tokens" if target.provider in ("openai", "azure") else "max_tokens"
    payload: dict = {"model": target.model, "stream": False,
                     "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if temperature is not None:
        payload["temperature"] = temperature
    for _ in range(3):
        body = {**payload, limit_field: max_tokens}
        res = await client.post(f"{target.url}/chat/completions", json=body, timeout=180.0)
        if res.status_code < 400:
            return res.json()
        detail = redact(llm_provider.error_detail(res), target.provider)
        if res.status_code == 400 and "temperature" in detail and "temperature" in payload:
            payload.pop("temperature")
            continue
        if res.status_code == 400 and limit_field in detail:
            limit_field = "max_tokens" if limit_field == "max_completion_tokens" else "max_completion_tokens"
            continue
        raise llm_provider.LlmError(f"{target.label} error {res.status_code}: {detail}", status=res.status_code)
    raise llm_provider.LlmError(f"{target.label} rejected the request.")


def describe(err: Exception, target: Target) -> str:
    if isinstance(err, llm_provider.LlmError):
        return str(err)
    if isinstance(err, httpx.ConnectError):
        return f"Can't reach {target.label} at {target.url}."
    if isinstance(err, httpx.TimeoutException):
        return f"{target.label} didn't respond in time."
    return redact(f"{target.label} call failed: {err}", target.provider)
