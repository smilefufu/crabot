"""LLM 客户端 — 路由到 4 种 format（与 admin / agent 端口对齐）：
openai / anthropic / gemini（走 OpenAI 兼容端点）/ openai-responses。
"""
import json
import logging
from typing import List, Dict, Any, Optional

from .._config_ref import get_llm_config

logger = logging.getLogger(__name__)


class LLMClient:
    """异步 LLM 客户端，支持 openai / anthropic / gemini / openai-responses。"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        format: Optional[str] = None,
        account_id: Optional[str] = None,
    ):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model
        self._format = format or "openai"
        # 仅 openai-responses + ChatGPT Codex OAuth 用，作为 ChatGPT-Account-Id header
        self._account_id = account_id or ""
        self._client: Any = None

    def reconfigure(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        format: Optional[str] = None,
        account_id: Optional[str] = None,
    ) -> None:
        """热更新配置，下次调用时自动重建客户端"""
        if api_key is not None:
            self._api_key = api_key
        if base_url is not None:
            self._base_url = base_url
        if model is not None:
            self._model = model
        if format is not None:
            self._format = format
        if account_id is not None:
            self._account_id = account_id
        self._client = None
        logger.info("LLMClient reconfigured: format=%s model=%s base_url=%s", self._format, self._model, self._base_url)

    def _ensure_client(self) -> Any:
        if self._client is None:
            if self._format == "anthropic":
                from anthropic import AsyncAnthropic
                self._client = AsyncAnthropic(
                    api_key=self._api_key,
                    base_url=self._base_url if self._base_url else None,
                )
            else:
                # openai / gemini / openai-responses 都用 OpenAI Python SDK
                # （gemini 走 OpenAI 兼容端点；responses 走 SDK 自带的 .responses 资源）
                from openai import AsyncOpenAI
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
        """聊天补全，带重试。按 format 路由到对应 API。"""
        client = self._ensure_client()

        last_err: Optional[Exception] = None
        for attempt in range(max_retries):
            try:
                if self._format == "anthropic":
                    content = await self._call_anthropic(client, messages, temperature, needs_json=response_format is not None)
                elif self._format == "openai-responses":
                    content = await self._call_responses(client, messages, temperature, needs_json=response_format is not None)
                else:
                    # 'openai' 和 'gemini' 都走 OpenAI Chat Completions
                    content = await self._call_openai(client, messages, temperature, response_format)
                return content
            except Exception as e:
                last_err = e
                logger.warning("LLM call attempt %d/%d failed: %s", attempt + 1, max_retries, e)

        raise RuntimeError(f"LLM call failed after {max_retries} attempts: {last_err}")

    @property
    def _json_response_format(self) -> Optional[Dict[str, str]]:
        """JSON 输出意图标记。

        统一返回 ``{"type": "json_object"}`` 让调用方表达"我要 JSON"的意图；
        chat_completion 内部按 format 决定如何落实：
        - openai / gemini：直接传给 chat.completions 的 response_format
        - anthropic / openai-responses：仅用作 needs_json 标志，靠 prompt 或 API 特有字段实现
        """
        return {"type": "json_object"}

    async def _call_openai(
        self,
        client: Any,
        messages: List[Dict[str, str]],
        temperature: float,
        response_format: Optional[Dict[str, str]],
    ) -> str:
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        if response_format:
            kwargs["response_format"] = response_format

        resp = await client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""

    async def _call_anthropic(
        self,
        client: Any,
        messages: List[Dict[str, str]],
        temperature: float,
        needs_json: bool = False,
    ) -> str:
        # 从 messages 中分离 system prompt 和 user messages
        system_prompt = ""
        user_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_prompt = msg["content"]
            else:
                user_messages.append(msg)

        # Anthropic 不支持 response_format，通过 prompt 指令确保 JSON 输出
        if needs_json and "JSON" not in system_prompt:
            system_prompt += "\n\nIMPORTANT: You must respond with valid JSON only, no other text."

        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": user_messages,
            "temperature": temperature,
            "max_tokens": 4096,
        }
        if system_prompt:
            kwargs["system"] = system_prompt

        resp = await client.messages.create(**kwargs)
        for block in resp.content:
            if block.type == "text":
                return block.text
        return ""

    async def _call_responses(
        self,
        client: Any,
        messages: List[Dict[str, str]],
        temperature: float,
        needs_json: bool = False,
    ) -> str:
        """OpenAI Responses API 调用（流式）。

        ChatGPT Codex 后端**强制要求 stream=true**（非流式直接 400 "Stream must be set to true"），
        OpenAI 官方端点也兼容流式。两边统一走流式，省一个分支。

        兼容端点：
        - OpenAI 官方 ``https://api.openai.com/v1``
        - ChatGPT Codex 后端 ``https://chatgpt.com/backend-api/codex``（OAuth + 特殊 header）

        Codex 端点要求：
        - HTTP header ``ChatGPT-Account-Id``（用 self._account_id）
        - body 含 ``reasoning`` 和 ``include`` 字段
        """
        # Responses API: system → instructions（顶层字段），user/assistant → input 列表
        system_parts: List[str] = []
        input_messages: List[Dict[str, Any]] = []
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            if role == "system":
                system_parts.append(content)
                continue
            input_messages.append({
                "type": "message",
                "role": role,
                "content": content,
            })

        instructions = "\n\n".join(system_parts) if system_parts else None

        # Codex 不支持 text.format JSON 强约束，统一走 prompt 兜底
        if needs_json and instructions and "JSON" not in instructions:
            instructions += "\n\nIMPORTANT: You must respond with valid JSON only, no other text."

        # account_id 只在 ChatGPT Codex OAuth 场景下被设置（admin.buildConnectionInfo 里只对
        # OAuth provider 注入），所以它是 Codex 后端的可靠信号。
        is_codex = bool(self._account_id)
        # SDK 的 responses.stream(...) 内部固定 stream=True，不能再传 stream kwarg
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "input": input_messages,
            "store": False,
        }
        # ChatGPT Codex 后端不支持 temperature（"Unsupported parameter: temperature"）；
        # OpenAI 官方 Responses API 支持。与 Agent OpenAIResponsesAdapter 对 max_output_tokens 的
        # 处理同模式：Codex 不支持的字段按 is_codex 跳过。
        if not is_codex:
            kwargs["temperature"] = temperature
        if instructions:
            kwargs["instructions"] = instructions
        if is_codex:
            kwargs["reasoning"] = {"effort": "medium", "summary": "auto"}
            kwargs["include"] = ["reasoning.encrypted_content"]
            kwargs["extra_headers"] = {"ChatGPT-Account-Id": self._account_id}

        # get_final_response() 内部会自动 await until_done()，不需要外层手动 drain
        async with client.responses.stream(**kwargs) as stream:
            final = await stream.get_final_response()
        return getattr(final, "output_text", "") or ""

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
            response_format=self._json_response_format,
        )
        data = extract_json(resp)
        if isinstance(data, dict):
            return data.get("keywords", [])
        if isinstance(data, list):
            return data
        return []

    async def generate_l0_l1(self, content: str) -> Dict[str, str]:
        """从 L2 content 生成 L0 abstract 和 L1 overview

        三层各有独立定位（参考 OpenViking 分层设计）：
        - L0 abstract: 单行索引摘要（<=256字符），用于向量搜索和快速筛选
        - L1 overview: 结构化 Markdown 概览（<=4000字符），用于快速理解内容
        - L2 content: 完整原文（不变）

        无论 content 长短，L0/L1 都由 LLM 按角色生成，而非截取或压缩。
        """
        messages = [
            {
                "role": "system",
                "content": (
                    "You generate two different views of the given content. "
                    "Each view has a distinct purpose — do NOT simply shorten or lengthen the original.\n\n"
                    '1. "abstract": A single-sentence index line (max 256 chars). '
                    "Purpose: vector search index and quick filtering. "
                    "Format: plain text, one line, no markdown.\n\n"
                    '2. "overview": A structured summary for quick comprehension (max 4000 chars). '
                    "Purpose: let the reader understand the key points without reading the full content. "
                    "Format: Markdown with headings/bullets as appropriate. "
                    "Must be SHORTER than the original content. "
                    "If the original is already very short, rephrase it structurally rather than padding.\n\n"
                    "Return JSON with keys: abstract, overview"
                ),
            },
            {"role": "user", "content": content},
        ]
        resp = await self.chat_completion(
            messages,
            temperature=0.1,
            response_format=self._json_response_format,
        )
        data = extract_json(resp)
        if isinstance(data, dict):
            abstract = data.get("abstract", content[:256])
            overview = data.get("overview", content[:4000])
            return {
                "abstract": abstract[:256],
                "overview": overview[:4000],
            }
        return {"abstract": content[:256], "overview": content[:4000]}

    async def judge_dedup(
        self,
        new_content: str,
        existing_content: str,
    ) -> Dict[str, Any]:
        """判断新记忆与已有记忆的去重策略"""
        messages = [
            {
                "role": "system",
                "content": (
                    "Compare the new memory with the existing memory.\n"
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
            response_format=self._json_response_format,
        )
        data = extract_json(resp)
        if isinstance(data, dict) and "action" in data:
            return data
        return {"action": "CREATE", "reason": "parse_failed"}

    async def compress_short_term(self, entries: List[Dict[str, str]]) -> List[str]:
        """将多条短期记忆压缩为更少的紧凑事实单元"""
        entries_text = "\n".join(
            f"[{e.get('event_time', '?')}] {e['content']}"
            for e in entries
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a memory compression engine. Given a list of timestamped events, "
                    "compress them into fewer fact statements. Rules:\n"
                    "1. Resolve pronouns to actual names\n"
                    "2. Convert relative times to absolute times\n"
                    "3. Merge related events into single factual statements\n"
                    "4. Preserve all unique information, remove redundancy\n"
                    "5. Each output fact should be a single clear sentence\n"
                    "Return a JSON array of strings."
                ),
            },
            {"role": "user", "content": entries_text},
        ]
        resp = await self.chat_completion(
            messages, temperature=0.1, response_format=self._json_response_format,
        )
        data = extract_json(resp)
        if isinstance(data, list):
            return [str(item) for item in data]
        if isinstance(data, dict) and "facts" in data:
            return [str(item) for item in data["facts"]]
        return [entries_text]

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
