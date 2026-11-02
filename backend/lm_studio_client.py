"""Client for the post-meeting LLM calls (LM Studio / Ollama / any OpenAI-compatible server)."""
import logging
import re

import httpx

logger = logging.getLogger(__name__)

DEFAULT_CONTEXT_TOKENS = 4096   # conservative when the server can't tell us
DEFAULT_CHARS_PER_TOKEN = 3.0


def strip_reasoning(content: str) -> str:
    """Drop inline reasoning some models emit even with reasoning disabled
    (<think>…</think>, or Gemma's "…<channel|>" thought channel)."""
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL)
    if "<channel|>" in content:
        content = content.rsplit("<channel|>", 1)[-1]
    return content.strip()


class LMStudioClient:
    def __init__(self, base_url: str = "http://127.0.0.1:1234/v1"):
        self.base_url = base_url.rstrip('/')
        self._ctx_cache: dict[tuple[str, str], int] = {}
        # Reasoning models (Gemma 4, Qwen 3, ...) can spend the whole budget "thinking" and return
        # empty content; the briefing doesn't benefit from it. Dropped if the server rejects it.
        self._no_reasoning = True
        self.chars_per_token = DEFAULT_CHARS_PER_TOKEN   # calibrated from real usage below

    def _config(self) -> tuple[str, str]:
        """Current (api_url, model) from Settings; model may be "" (auto-detect)."""
        try:
            from database import SessionLocal, AppConfig
            db = SessionLocal()
            try:
                c = {r.key: r.value for r in db.query(AppConfig).filter(
                    AppConfig.key.in_(("llm_api_url", "llm_model"))).all()}
            finally:
                db.close()
            return (c.get("llm_api_url") or self.base_url).rstrip('/'), (c.get("llm_model") or "").strip()
        except Exception:  # noqa: BLE001
            return self.base_url, ""

    async def _resolve_model(self, client: httpx.AsyncClient, base_url: str, configured: str) -> str:
        if configured:
            return configured
        try:
            res = await client.get(f"{base_url}/models", timeout=4.0)
            ids = [m["id"] for m in res.json().get("data", []) if "embed" not in m.get("id", "").lower()]
            if ids:
                return ids[0]
        except Exception as err:  # noqa: BLE001
            logger.debug("model auto-detect failed at %s: %s", base_url, err)
        return "local-model"

    async def _context_tokens(self, client: httpx.AsyncClient, base_url: str, model: str) -> int:
        """Loaded context window, so long transcripts are chunked instead of overflowing."""
        key = (base_url, model)
        if key not in self._ctx_cache:
            ctx = DEFAULT_CONTEXT_TOKENS
            root = re.sub(r"/v1$", "", base_url)
            try:  # LM Studio REST API
                res = await client.get(f"{root}/api/v0/models/{model}", timeout=4.0)
                if res.status_code == 200:
                    info = res.json()
                    ctx = int(info.get("loaded_context_length") or info.get("max_context_length") or ctx)
            except Exception:  # noqa: BLE001
                pass
            self._ctx_cache[key] = ctx
        return self._ctx_cache[key]

    async def context_tokens(self) -> int:
        base_url, configured = self._config()
        async with httpx.AsyncClient() as client:
            return await self._context_tokens(client, base_url, await self._resolve_model(client, base_url, configured))

    async def complete(self, system_prompt: str, user_content: str, *, max_tokens: int = 1000,
                       temperature: float = 0.3) -> str:
        """One chat completion; returns "" on failure. Strips <think> blocks from reasoning models."""
        base_url, configured = self._config()
        url = f"{base_url}/chat/completions"
        async with httpx.AsyncClient(timeout=180.0) as client:
            try:
                payload = {
                    "model": await self._resolve_model(client, base_url, configured),
                    "messages": [{"role": "system", "content": system_prompt},
                                 {"role": "user", "content": user_content}],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "stream": False,
                }
                if self._no_reasoning:
                    payload["reasoning_effort"] = "none"
                response = await client.post(url, json=payload)
                if response.status_code in (400, 422) and self._no_reasoning:
                    self._no_reasoning = False
                    payload.pop("reasoning_effort")
                    response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
                prompt_tokens = (data.get("usage") or {}).get("prompt_tokens")
                if prompt_tokens:
                    measured = (len(system_prompt) + len(user_content)) / prompt_tokens
                    self.chars_per_token = max(2.0, min(4.5, 0.5 * self.chars_per_token + 0.5 * measured))
                choice = data["choices"][0]
                content = choice["message"].get("content") or ""
                if choice.get("finish_reason") == "length":
                    logger.warning("LLM hit max_tokens (%d); output may be truncated", max_tokens)
                return strip_reasoning(content)
            except Exception as e:  # noqa: BLE001
                logger.error(f"Error calling LLM API at {url}: {e}")
                return ""
