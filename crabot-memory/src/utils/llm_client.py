"""
LLM 客户端 - 精简版，提取自 SimpleMem
使用 OpenAI 兼容 API
"""
import json
import logging
from typing import List, Dict, Any, Optional

from openai import AsyncOpenAI

from .._config_ref import get_llm_config

logger = logging.getLogger(__name__)


class LLMClient:
    """异步 LLM 客户端"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model
        self._client: Optional[AsyncOpenAI] = None

    def reconfigure(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        """热更新配置，下次调用时自动重建客户端"""
        if api_key is not None:
            self._api_key = api_key
        if base_url is not None:
            self._base_url = base_url
        if model is not None:
            self._model = model
        self._client = None
        logger.info("LLMClient reconfigured: model=%s base_url=%s", self._model, self._base_url)

    def _ensure_client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
            )
        return self._client

    @property
    def model(self) -> str:
        return self._model or "gpt-4o-mini"

    async def chat_completion(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.1,
        response_format: Optional[Dict[str, str]] = None,
        max_retries: int = 3,
    ) -> str:
        """聊天补全，带重试"""
        client = self._ensure_client()
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        if response_format:
            kwargs["response_format"] = response_format

        last_err: Optional[Exception] = None
        for attempt in range(max_retries):
            try:
                resp = await client.chat.completions.create(**kwargs)
                content = resp.choices[0].message.content or ""
                return content
            except Exception as e:
                last_err = e
                logger.warning("LLM call attempt %d/%d failed: %s", attempt + 1, max_retries, e)

        raise RuntimeError(f"LLM call failed after {max_retries} attempts: {last_err}")

    async def extract_keywords(self, text: str) -> List[str]:
        """从文本中提取关键词"""
        messages = [
            {
                "role": "system",
                "content": "Extract 3-8 keywords from the text. Return a JSON array of strings only.",
            },
            {"role": "user", "content": text},
        ]
        resp = await self.chat_completion(
            messages,
            temperature=0.0,
            response_format={"type": "json_object"},
        )
        data = extract_json(resp)
        if isinstance(data, dict):
            return data.get("keywords", [])
        if isinstance(data, list):
            return data
        return []

    async def generate_l0_l1(self, content: str) -> Dict[str, str]:
        """从 L2 content 生成 L0 abstract 和 L1 overview"""
        messages = [
            {
                "role": "system",
                "content": (
                    "Generate two summaries of the given content:\n"
                    '1. "abstract": A very concise summary in ~100 tokens\n'
                    '2. "overview": A moderate summary in ~500 tokens\n'
                    "Return JSON with keys: abstract, overview"
                ),
            },
            {"role": "user", "content": content},
        ]
        resp = await self.chat_completion(
            messages,
            temperature=0.1,
            response_format={"type": "json_object"},
        )
        data = extract_json(resp)
        if isinstance(data, dict):
            return {
                "abstract": data.get("abstract", content[:200]),
                "overview": data.get("overview", content[:2000]),
            }
        return {"abstract": content[:200], "overview": content[:2000]}

    async def judge_dedup(
        self,
        new_content: str,
        existing_content: str,
        category: str,
    ) -> Dict[str, Any]:
        """判断新记忆与已有记忆的去重策略"""
        messages = [
            {
                "role": "system",
                "content": (
                    "Compare the new memory with the existing memory in the same category.\n"
                    "Decide the action:\n"
                    '- "CREATE": completely different, create new\n'
                    '- "UPDATE": same topic but new info, update existing\n'
                    '- "MERGE": overlapping info, merge into one\n'
                    '- "SKIP": duplicate, skip\n'
                    'Return JSON: {"action": "CREATE|UPDATE|MERGE|SKIP", "reason": "..."}'
                ),
            },
            {
                "role": "user",
                "content": f"New:\n{new_content}\n\nExisting:\n{existing_content}",
            },
        ]
        resp = await self.chat_completion(
            messages,
            temperature=0.0,
            response_format={"type": "json_object"},
        )
        data = extract_json(resp)
        if isinstance(data, dict) and "action" in data:
            return data
        return {"action": "CREATE", "reason": "parse_failed"}

    async def merge_contents(self, content_a: str, content_b: str) -> str:
        """合并两段记忆内容"""
        messages = [
            {
                "role": "system",
                "content": (
                    "Merge the following two memory entries into one coherent entry. "
                    "Preserve all unique information. Remove duplicates. "
                    "Return only the merged text, no JSON."
                ),
            },
            {"role": "user", "content": f"Entry A:\n{content_a}\n\nEntry B:\n{content_b}"},
        ]
        return await self.chat_completion(messages, temperature=0.1)


def extract_json(text: str) -> Any:
    """从文本中提取 JSON，提取自 SimpleMem"""
    text = text.strip()
    # 直接尝试解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 查找 JSON 块
    for start_char, end_char in [("{", "}"), ("[", "]")]:
        start_idx = text.find(start_char)
        if start_idx == -1:
            continue

        depth = 0
        in_string = False
        escape_next = False

        for i in range(start_idx, len(text)):
            char = text[i]
            if escape_next:
                escape_next = False
                continue
            if char == "\\":
                escape_next = True
                continue
            if char == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if char == start_char:
                depth += 1
            elif char == end_char:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start_idx : i + 1])
                    except json.JSONDecodeError:
                        break

    return None
