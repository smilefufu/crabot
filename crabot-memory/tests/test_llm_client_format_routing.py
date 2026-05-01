"""LLMClient 多格式路由测试。

每种 format 都应当：
- 路由到正确的 SDK（anthropic / openai SDK 之一）
- 用对应 API surface（chat.completions / messages.create / responses.stream）
- openai-responses + ChatGPT Codex 后端能注入 ChatGPT-Account-Id header + reasoning/include
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.utils.llm_client import LLMClient


def _make_openai_response(text: str):
    """模拟 chat.completions.create 的返回。"""
    msg = SimpleNamespace(content=text)
    choice = SimpleNamespace(message=msg)
    return SimpleNamespace(choices=[choice])


def _make_anthropic_response(text: str):
    """模拟 anthropic.messages.create 的返回。"""
    block = SimpleNamespace(type="text", text=text)
    return SimpleNamespace(content=[block])


class FakeResponsesStream:
    """模拟 openai.responses.stream(...) 返回的 async context manager。

    LLMClient 只用 ``await stream.get_final_response()``（SDK 内部会自动 drain），
    所以 mock 不需要实现 __aiter__/__anext__。
    """

    def __init__(self, final_text: str):
        self._final = SimpleNamespace(output_text=final_text)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get_final_response(self):
        return self._final


def _fake_responses_client(final_text: str):
    """构造一个 fake AsyncOpenAI client，让 .responses.stream(**kwargs) 同步返回
    一个 FakeResponsesStream 实例（SDK 行为：stream() 是同步函数，返回值才是 ctx mgr）。"""
    stream_factory = MagicMock(return_value=FakeResponsesStream(final_text))
    return SimpleNamespace(responses=SimpleNamespace(stream=stream_factory)), stream_factory


@pytest.mark.asyncio
async def test_openai_format_routes_to_chat_completions():
    client = LLMClient(api_key="k", base_url="https://api.openai.com/v1", model="gpt-4o", format="openai")
    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=_make_openai_response("hello-openai"))
            )
        )
    )
    client._client = fake_client
    out = await client.chat_completion([{"role": "user", "content": "hi"}], max_retries=1)
    assert out == "hello-openai"
    fake_client.chat.completions.create.assert_called_once()
    kwargs = fake_client.chat.completions.create.call_args.kwargs
    assert kwargs["model"] == "gpt-4o"
    assert kwargs["messages"] == [{"role": "user", "content": "hi"}]


@pytest.mark.asyncio
async def test_gemini_format_routes_to_chat_completions():
    """Gemini 走 OpenAI 兼容端点（chat.completions），跟 'openai' format 等价。"""
    client = LLMClient(
        api_key="k",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-2.0-flash",
        format="gemini",
    )
    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=_make_openai_response("hello-gemini"))
            )
        )
    )
    client._client = fake_client
    out = await client.chat_completion([{"role": "user", "content": "hi"}], max_retries=1)
    assert out == "hello-gemini"
    fake_client.chat.completions.create.assert_called_once()


@pytest.mark.asyncio
async def test_anthropic_format_routes_to_messages_create():
    client = LLMClient(api_key="k", base_url="https://api.anthropic.com", model="claude-sonnet", format="anthropic")
    fake_client = SimpleNamespace(
        messages=SimpleNamespace(
            create=AsyncMock(return_value=_make_anthropic_response("hello-anthropic"))
        )
    )
    client._client = fake_client
    out = await client.chat_completion(
        [{"role": "system", "content": "be concise"}, {"role": "user", "content": "hi"}],
        max_retries=1,
    )
    assert out == "hello-anthropic"
    fake_client.messages.create.assert_called_once()
    kwargs = fake_client.messages.create.call_args.kwargs
    # system prompt 被分离
    assert kwargs["system"] == "be concise"
    assert kwargs["messages"] == [{"role": "user", "content": "hi"}]


@pytest.mark.asyncio
async def test_responses_format_routes_to_responses_stream_official_endpoint():
    """官方 OpenAI Responses 端点：传 instructions + input；不带 ChatGPT-Account-Id；不传 stream kwarg。"""
    client = LLMClient(
        api_key="k",
        base_url="https://api.openai.com/v1",
        model="gpt-5",
        format="openai-responses",
    )
    fake_client, stream_factory = _fake_responses_client("hello-responses")
    client._client = fake_client

    out = await client.chat_completion(
        [{"role": "system", "content": "be brief"}, {"role": "user", "content": "hi"}],
        max_retries=1,
    )
    assert out == "hello-responses"
    stream_factory.assert_called_once()
    kwargs = stream_factory.call_args.kwargs
    assert kwargs["instructions"] == "be brief"
    assert kwargs["input"] == [{"type": "message", "role": "user", "content": "hi"}]
    # 非 Codex 端点不应注入 reasoning / include / extra_headers
    assert "reasoning" not in kwargs
    assert "include" not in kwargs
    assert "extra_headers" not in kwargs
    # SDK 的 .stream() 内部固定 stream=True，不能再传 stream kwarg
    assert "stream" not in kwargs


@pytest.mark.asyncio
async def test_responses_format_codex_backend_injects_account_id_and_reasoning():
    """ChatGPT Codex 后端：必须注入 reasoning + include + ChatGPT-Account-Id header。"""
    client = LLMClient(
        api_key="oauth-token",
        base_url="https://chatgpt.com/backend-api/codex",
        model="gpt-5.4-mini",
        format="openai-responses",
        account_id="acc-xxx",
    )
    fake_client, stream_factory = _fake_responses_client("hello-codex")
    client._client = fake_client

    out = await client.chat_completion(
        [{"role": "user", "content": "hi"}],
        max_retries=1,
    )
    assert out == "hello-codex"
    kwargs = stream_factory.call_args.kwargs
    assert kwargs["reasoning"] == {"effort": "medium", "summary": "auto"}
    assert kwargs["include"] == ["reasoning.encrypted_content"]
    assert kwargs["extra_headers"]["ChatGPT-Account-Id"] == "acc-xxx"


@pytest.mark.asyncio
async def test_reconfigure_supports_account_id():
    client = LLMClient(api_key="k", base_url="https://api.openai.com/v1", model="m", format="openai")
    assert client._account_id == ""
    client.reconfigure(format="openai-responses", account_id="acc-1")
    assert client._format == "openai-responses"
    assert client._account_id == "acc-1"
    # 客户端应当被清空，下次调用重建
    assert client._client is None


@pytest.mark.asyncio
async def test_json_response_format_marker_unified_across_formats():
    """_json_response_format 在所有 format 下都返回 truthy 值；
    各 format 内部按需决定如何落实（直接传 / 仅作 needs_json 信号）。"""
    for fmt in ("openai", "anthropic", "gemini", "openai-responses"):
        c = LLMClient(api_key="k", base_url="u", model="m", format=fmt)
        assert c._json_response_format == {"type": "json_object"}, f"failed for {fmt}"
