"""LLMClient 多格式路由测试。

每种 format 都应当：
- 路由到正确的 SDK（anthropic / openai SDK 之一）
- 用对应 API surface（chat.completions / messages.create / responses.stream）
- openai-responses + ChatGPT Codex 后端能注入 ChatGPT-Account-Id header + reasoning/include
"""
from types import SimpleNamespace
from typing import List, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.utils.llm_client import (
    LLMClient,
    LLMResponseFailedError,
    LLMResponseIncompleteError,
)


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
    """模拟 openai.responses.stream(...) 返回的 async context manager + async iterator。

    LLMClient 通过 ``async for event in stream`` 消费 stream events，所以 fake 需要
    实现 __aiter__。两种构造方式：
    - ``final_text`` 简写：自动生成 1 条 response.completed 事件（保持老 test 兼容）
    - ``events`` 显式传入：用于 incomplete / failed 等终态分支测试
    """

    def __init__(self, events: Optional[List[SimpleNamespace]] = None, final_text: Optional[str] = None):
        if events is None:
            assert final_text is not None, "FakeResponsesStream needs events or final_text"
            response = SimpleNamespace(output_text=final_text)
            events = [SimpleNamespace(type="response.completed", response=response)]
        self._events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def __aiter__(self):
        for e in self._events:
            yield e


def _fake_responses_client(final_text: Optional[str] = None, events: Optional[List[SimpleNamespace]] = None):
    """构造一个 fake AsyncOpenAI client，让 .responses.stream(**kwargs) 同步返回
    一个 FakeResponsesStream 实例（SDK 行为：stream() 是同步函数，返回值才是 ctx mgr）。"""
    stream_factory = MagicMock(return_value=FakeResponsesStream(events=events, final_text=final_text))
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
    # 官方 Responses API 支持 temperature，应该传递（默认 0.1）
    assert kwargs["temperature"] == pytest.approx(0.1)
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
    # ChatGPT Codex 后端不支持 temperature（会 400 "Unsupported parameter: temperature"），
    # 必须省略；OpenAI 官方 Responses API 才支持。
    assert "temperature" not in kwargs


@pytest.mark.asyncio
async def test_responses_incomplete_max_output_tokens_raises_typed_error_and_skips_retry():
    """response.incomplete 是终态：同输入再跑还是会被截断，不该重试。"""
    incomplete_resp = SimpleNamespace(
        output_text="",
        incomplete_details=SimpleNamespace(reason="max_output_tokens"),
    )
    events = [SimpleNamespace(type="response.incomplete", response=incomplete_resp)]
    fake_client, stream_factory = _fake_responses_client(events=events)
    client = LLMClient(
        api_key="k",
        base_url="https://api.openai.com/v1",
        model="gpt-5",
        format="openai-responses",
    )
    client._client = fake_client

    with pytest.raises(LLMResponseIncompleteError) as exc:
        await client.chat_completion([{"role": "user", "content": "hi"}], max_retries=3)
    assert exc.value.reason == "max_output_tokens"
    # 不该重试：3 次 max_retries 但只调 1 次
    assert stream_factory.call_count == 1


@pytest.mark.asyncio
async def test_responses_incomplete_content_filter_raises_typed_error():
    """content_filter 也是 incomplete 一种，同样不重试，但 reason 区分让上层决定怎么提示用户。"""
    incomplete_resp = SimpleNamespace(
        output_text="",
        incomplete_details=SimpleNamespace(reason="content_filter"),
    )
    events = [SimpleNamespace(type="response.incomplete", response=incomplete_resp)]
    fake_client, stream_factory = _fake_responses_client(events=events)
    client = LLMClient(
        api_key="k",
        base_url="https://api.openai.com/v1",
        model="gpt-5",
        format="openai-responses",
    )
    client._client = fake_client

    with pytest.raises(LLMResponseIncompleteError) as exc:
        await client.chat_completion([{"role": "user", "content": "hi"}], max_retries=3)
    assert exc.value.reason == "content_filter"
    assert stream_factory.call_count == 1


@pytest.mark.asyncio
async def test_responses_failed_invalid_prompt_not_retried():
    """response.failed + 4xx 类 code（如 invalid_prompt）：不可重试。"""
    failed_resp = SimpleNamespace(
        error=SimpleNamespace(code="invalid_prompt", message="bad input"),
    )
    events = [SimpleNamespace(type="response.failed", response=failed_resp)]
    fake_client, stream_factory = _fake_responses_client(events=events)
    client = LLMClient(
        api_key="k",
        base_url="https://api.openai.com/v1",
        model="gpt-5",
        format="openai-responses",
    )
    client._client = fake_client

    with pytest.raises(LLMResponseFailedError) as exc:
        await client.chat_completion([{"role": "user", "content": "hi"}], max_retries=3)
    assert exc.value.code == "invalid_prompt"
    assert exc.value.retryable is False
    assert stream_factory.call_count == 1


@pytest.mark.asyncio
async def test_responses_failed_server_error_retried_then_succeeds():
    """response.failed + server_error 是可重试的：第 1 次失败、第 2 次成功。"""
    failed_resp = SimpleNamespace(
        error=SimpleNamespace(code="server_error", message="transient"),
    )
    fail_events = [SimpleNamespace(type="response.failed", response=failed_resp)]
    success_events = [SimpleNamespace(
        type="response.completed",
        response=SimpleNamespace(output_text="recovered"),
    )]

    # MagicMock side_effect: 第一次返回失败 stream，第二次返回成功 stream。
    stream_factory = MagicMock(side_effect=[
        FakeResponsesStream(events=fail_events),
        FakeResponsesStream(events=success_events),
    ])
    fake_client = SimpleNamespace(responses=SimpleNamespace(stream=stream_factory))

    client = LLMClient(
        api_key="k",
        base_url="https://api.openai.com/v1",
        model="gpt-5",
        format="openai-responses",
    )
    client._client = fake_client

    out = await client.chat_completion([{"role": "user", "content": "hi"}], max_retries=3)
    assert out == "recovered"
    assert stream_factory.call_count == 2


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
