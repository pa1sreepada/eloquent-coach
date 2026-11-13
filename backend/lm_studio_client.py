"""Client for the post-meeting LLM calls (LM Studio / Ollama / any OpenAI-compatible server)."""
import logging
import re

import httpx

import external_llm
import llm_provider

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
        # Reasoning models (Gemma 4, Qwen 3, ...) think unless told not to; Settings decides (off by
        # default, since it can eat the whole budget). The fields are dropped if the server rejects them.
        self._reasoning_fields_ok = True
        self.chars_per_token = DEFAULT_CHARS_PER_TOKEN   # calibrated from real usage below
        self.last_error: str | None = None               # user-facing reason the last call returned ""

    def _config(self) -> tuple[str, str, bool, bool]:
        """Current (api_url, model, thinking, allow_remote) from Settings; model may be "" (auto-detect)."""
        try:
            from database import SessionLocal, AppConfig
            db = SessionLocal()
            try:
                c = {r.key: r.value for r in db.query(AppConfig).filter(
                    AppConfig.key.in_(("llm_api_url", "llm_model", "llm_thinking", "llm_allow_remote"))).all()}
            finally:
                db.close()
            return ((c.get("llm_api_url") or self.base_url).rstrip('/'), (c.get("llm_model") or "").strip(),
                    llm_provider.parse_bool(c.get("llm_thinking")), llm_provider.parse_bool(c.get("llm_allow_remote")))
        except Exception:  # noqa: BLE001
            return self.base_url, "", False, False

    def _external(self) -> "external_llm.Target | None":
        """The external frontier model when Settings turns it on (hybrid mode), else None.
        Raises LlmError when it's on but incomplete, so the user sees why instead of a silent local fallback."""
        try:
            from database import SessionLocal, AppConfig
            db = SessionLocal()
            try:
                c = {r.key: r.value for r in db.query(AppConfig).filter(AppConfig.key.like("external_llm_%")).all()}
            finally:
                db.close()
        except Exception:  # noqa: BLE001
            return None
        return external_llm.target_from_settings(c)

    async def _complete_external(self, target: "external_llm.Target", system_prompt: str, user_content: str,
                                 max_tokens: int, temperature: float) -> str:
        async with httpx.AsyncClient(**external_llm.client_kwargs(target.provider)) as client:
            try:
                data = await external_llm.chat(client, target, system_prompt, user_content,
                                               max_tokens=max_tokens + external_llm.REASONING_BUDGET,
                                               temperature=temperature)
                choice = data["choices"][0]
                content = choice["message"].get("content") or ""
                if not content.strip():
                    raise llm_provider.LlmError(f"{target.label} returned an empty answer"
                                                f"{' (token limit reached)' if choice.get('finish_reason') == 'length' else ''}.")
                return strip_reasoning(content)
            except Exception as e:  # noqa: BLE001
                self.last_error = external_llm.describe(e, target)
                logger.error("Error calling external LLM %s: %s", target.label, self.last_error)
                return ""

    async def _resolve_model(self, client: httpx.AsyncClient, base_url: str, configured: str) -> str:
        if configured:
            return configured
        try:
            provider = await llm_provider.detect_provider(client, base_url)
            picked = llm_provider.pick_model(await llm_provider.list_models(client, base_url, provider))
            if picked:
                return picked
        except Exception as err:  # noqa: BLE001
            logger.debug("model auto-detect failed at %s: %s", base_url, err)
        return "local-model"

    async def _context_tokens(self, client: httpx.AsyncClient, base_url: str, model: str) -> int:
        """Context window the server will actually use, so long transcripts are chunked instead of overflowing."""
        key = (base_url, model)
        if key not in self._ctx_cache:
            ctx = None
            try:
                provider = await llm_provider.detect_provider(client, base_url)
                for m in await llm_provider.list_models(client, base_url, provider):
                    if m.id == model:
                        ctx = m.context_length
                        break
            except Exception:  # noqa: BLE001
                pass
            # Ollama only reports context for a loaded model; its default when unloaded is ~4k.
            self._ctx_cache[key] = int(ctx or DEFAULT_CONTEXT_TOKENS)
        return self._ctx_cache[key]

    async def context_tokens(self) -> int:
        """Usable prompt + answer budget; with thinking on, room for the reasoning is held back."""
        try:
            if self._external() is not None:
                return external_llm.CONTEXT_TOKENS
        except llm_provider.LlmError:
            pass   # complete() reports it
        base_url, configured, thinking, allow_remote = self._config()
        try:
            llm_provider.check_url(base_url, allow_remote)
        except llm_provider.LlmError:
            return DEFAULT_CONTEXT_TOKENS
        async with httpx.AsyncClient(**llm_provider.client_kwargs()) as client:
            ctx = await self._context_tokens(client, base_url, await self._resolve_model(client, base_url, configured))
        return max(2048, ctx - llm_provider.THINKING_EXTRA_TOKENS) if thinking else ctx

    async def complete(self, system_prompt: str, user_content: str, *, max_tokens: int = 1000,
                       temperature: float = 0.3) -> str:
        """One chat completion; returns "" on failure. Strips <think> blocks from reasoning models.
        Uses the external frontier model instead of the local server when Settings turns it on."""
        self.last_error = None
        try:
            target = self._external()
        except llm_provider.LlmError as err:
            self.last_error = str(err)
            return ""
        if target is not None:
            return await self._complete_external(target, system_prompt, user_content, max_tokens, temperature)
        base_url, configured, thinking, allow_remote = self._config()
        url = f"{base_url}/chat/completions"
        self.last_error = None
        async with httpx.AsyncClient(timeout=180.0, **llm_provider.client_kwargs()) as client:
            try:
                llm_provider.check_url(base_url, allow_remote)
                payload = {
                    "model": await self._resolve_model(client, base_url, configured),
                    "messages": [{"role": "system", "content": system_prompt},
                                 {"role": "user", "content": user_content}],
                    "temperature": temperature,
                    "max_tokens": max_tokens + (llm_provider.THINKING_EXTRA_TOKENS if thinking else 0),
                    "stream": False,
                }
                provider = await llm_provider.detect_provider(client, base_url)
                fields = llm_provider.reasoning_fields(provider, thinking) if self._reasoning_fields_ok else {}
                response = await client.post(url, json={**payload, **fields})
                if response.status_code in (400, 422) and fields:
                    self._reasoning_fields_ok = False
                    response = await client.post(url, json=payload)
                if response.status_code >= 400:
                    name = llm_provider.provider_name(provider)
                    raise llm_provider.LlmError(
                        f"{name} error {response.status_code}: {llm_provider.error_detail(response)}")
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
                self.last_error = llm_provider.describe_exception(e, base_url)
                logger.error("Error calling LLM API at %s: %s", url, self.last_error)
                return ""
