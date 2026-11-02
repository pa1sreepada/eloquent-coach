import httpx
import json
import logging
import re
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

class LMStudioClient:
    def __init__(self, base_url: str = "http://127.0.0.1:1234/v1"):
        self.base_url = base_url.rstrip('/')

    def _get_active_url(self) -> str:
        """
        Dynamically fetches the configured LLM API URL from database if available.
        """
        try:
            from database import SessionLocal, AppConfig
            db = SessionLocal()
            conf = db.query(AppConfig).filter(AppConfig.key == "llm_api_url").first()
            db.close()
            if conf and conf.value:
                return conf.value.rstrip('/')
        except Exception:
            pass
        return self.base_url

    async def _get_active_model_id(self, base_url: str) -> str:
        """
        Queries /v1/models to detect the active model loaded in LM Studio / Ollama / LocalAI.
        """
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(f"{base_url}/models")
                if res.status_code == 200:
                    data = res.json()
                    models = data.get("data", [])
                    chat_models = [m["id"] for m in models if "embed" not in m.get("id", "").lower()]
                    if chat_models:
                        return chat_models[0]
        except Exception as err:
            logger.debug(f"Could not auto-detect model ID from {base_url}/models: {err}")
        return "local-model"

    async def generate_insight(self, transcript_history: str, system_prompt: str) -> str:
        """
        Sends transcript history and system prompt to local LLM and returns executive insight/synthesis.
        """
        base_url = self._get_active_url()
        url = f"{base_url}/chat/completions"
        model_id = await self._get_active_model_id(base_url)
        
        payload = {
            "model": model_id,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": transcript_history}
            ],
            "temperature": 0.7,
            "max_tokens": 1200,
            "stream": False
        }

        async with httpx.AsyncClient(timeout=180.0) as client:
            try:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
                content = data["choices"][0]["message"]["content"].strip()
                
                # Strip <think>...</think> reasoning blocks if present
                content = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL).strip()
                
                return content
            except Exception as e:
                logger.error(f"Error calling LLM API at {url}: {e}")
                return ""

    async def generate_insight_stream(self, transcript_history: str, system_prompt: str) -> AsyncGenerator[str, None]:
        """
        Streams the LLM response for real-time insight generation.
        """
        base_url = self._get_active_url()
        url = f"{base_url}/chat/completions"
        payload = {
            "model": "local-model",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": transcript_history}
            ],
            "temperature": 0.7,
            "max_tokens": 200,
            "stream": True
        }

        async with httpx.AsyncClient(timeout=180.0) as client:
            try:
                async with client.stream("POST", url, json=payload) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_lines():
                        if chunk.startswith("data: "):
                            data_str = chunk[len("data: "):].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                data_json = json.loads(data_str)
                                content = data_json["choices"][0].get("delta", {}).get("content", "")
                                if content:
                                    yield content
                            except json.JSONDecodeError:
                                pass
            except Exception as e:
                logger.error(f"Error streaming from LLM API at {url}: {e}")
                yield f"[Error: {e}]"
