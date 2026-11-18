"""Private inference must stay on its configured endpoint without Google clients."""
import json
from types import SimpleNamespace

import httpx
import pytest
from pydantic import BaseModel

from helpudoc_agent.configuration import ModelConfig
from helpudoc_agent.gemini_chat import create_chat_google_generative_ai


def local_config(**kwargs):
    return ModelConfig(
        provider="openai-compatible", name="local-model", base_url="https://nim.example.test/v1",
        **kwargs,
    )


@pytest.mark.parametrize("endpoint", [None, "", "nim.example.test", "https://api.openai.com/v1",
    "https://user:password@nim.example.test/v1", "https://nim.example.test/v1?key=secret"])
def test_local_provider_requires_explicit_private_endpoint(endpoint):
    with pytest.raises(ValueError):
        ModelConfig(provider="openai-compatible", base_url=endpoint)


def test_local_provider_does_not_inherit_gemini_credentials(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "must-not-use")
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        create_chat_google_generative_ai(local_config(api_key="also-not-google"), "local-model")


def test_local_chat_tool_call_and_structured_output_use_private_endpoint(monkeypatch):
    monkeypatch.setenv("PCAI_TOKEN", "site-token")
    monkeypatch.setenv("GEMINI_API_KEY", "must-not-use")
    captured = []

    class Answer(BaseModel):
        """A bounded answer from the local model."""
        answer: str

    def handler(request):
        payload = json.loads(request.content)
        captured.append(payload)
        assert str(request.url) == "https://nim.example.test/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer site-token"
        return httpx.Response(200, json={
            "id": "local-response", "object": "chat.completion", "created": 0,
            "model": "local-model", "choices": [{"index": 0, "finish_reason": "tool_calls",
                "message": {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "call-local", "type": "function", "function": {
                        "name": "Answer", "arguments": '{"answer":"local answer"}'}}]}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        })

    model = create_chat_google_generative_ai(
        local_config(api_key_env="PCAI_TOKEN"), "local-model", thinking_level="high",
        max_output_tokens=512, timeout=17,
    )
    from openai import OpenAI
    client = OpenAI(base_url="https://nim.example.test/v1", api_key="site-token",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    model.root_client = client
    model.client = client.chat.completions
    result = model.with_structured_output(Answer, method="function_calling", include_raw=True).invoke("Answer locally")
    assert result["parsed"].answer == "local answer"
    assert result["raw"].tool_calls[0]["name"] == "Answer"
    payload = captured[0]
    assert payload["model"] == "local-model"
    assert payload["max_tokens"] == 512
    assert "max_completion_tokens" not in payload
    assert "thinking_level" not in payload
    assert "reasoning_effort" not in payload
    assert model.stream_usage is False
    assert model.use_responses_api is False


@pytest.mark.asyncio
async def test_local_streaming_preserves_tokens(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "local-test")
    async def handler(request):
        payload = json.loads(request.content)
        assert payload["stream"] is True
        assert "stream_options" not in payload
        chunks = [dict(id="stream-local", object="chat.completion.chunk", created=0, model="local-model",
            choices=[dict(index=0, delta={"role": "assistant", "content": "hello local"}, finish_reason=None)]),
            dict(id="stream-local", object="chat.completion.chunk", created=0, model="local-model",
            choices=[dict(index=0, delta={}, finish_reason="stop")])]
        content = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=content, headers={"content-type": "text/event-stream"})
    from openai import AsyncOpenAI
    model = create_chat_google_generative_ai(local_config(), "local-model")
    client = AsyncOpenAI(base_url="https://nim.example.test/v1", api_key="local-test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    model.root_async_client = client
    model.async_client = client.chat.completions
    result = [chunk async for chunk in model.astream("hello")]
    assert "".join(chunk.content for chunk in result) == "hello local"
    await client.close()


def test_local_manager_never_constructs_google_client_and_caps_ingestion(monkeypatch):
    from helpudoc_agent.tools.workspace.gemini_client import GeminiClientManager
    monkeypatch.setenv("OPENAI_API_KEY", "local-test")
    monkeypatch.setattr(GeminiClientManager, "_build_client", lambda *_: pytest.fail("Google client constructed"))
    cfg = local_config(lite_max_output_tokens=1024, pro_max_output_tokens=2048)
    manager = GeminiClientManager(SimpleNamespace(model=cfg))
    assert manager.client is None
    with pytest.raises(ValueError, match="unavailable"):
        manager.get_web_tool_chat_model()
    for model, limit in [(manager.get_ingestion_chat_model(), 1024), (manager.get_reduce_chat_model(), 2048)]:
        assert model.extra_body["max_tokens"] == limit


def test_local_runtime_does_not_merge_cloud_tools_or_mcp_servers(tmp_path):
    import yaml
    from pathlib import Path
    from helpudoc_agent.configuration import load_settings

    chart = Path(__file__).resolve().parents[1] / "infra/helm/helpudoc"
    cfg = yaml.safe_load((chart / "files/runtime.yaml").read_text())
    cfg["model"] = yaml.safe_load((chart / "values.yaml").read_text())["model"]
    cfg["backend"]["workspace_root"] = str(tmp_path)
    path = tmp_path / "runtime.yaml"
    path.write_text(yaml.safe_dump(cfg))
    settings = load_settings(path)
    assert set(settings.mcp_servers) == {"data-artifacts"}
    assert not ({"google_search", "url_context", "image_generation"} & set(settings.tools))


def test_private_tool_factory_excludes_cloud_only_tools():
    from helpudoc_agent.configuration import ToolConfig
    from helpudoc_agent.tools.workspace.factory import ToolFactory

    names = ["google_search", "url_context", "image_generation", "export_bigquery_query"]
    settings = SimpleNamespace(model=local_config(), get_tool=lambda name: ToolConfig(name=name))
    factory = ToolFactory(settings, SimpleNamespace(), SimpleNamespace())
    assert factory.build_tools(names, SimpleNamespace()) == []


@pytest.mark.asyncio
async def test_text_pdf_extraction_with_ocr_off_needs_no_google_client(monkeypatch, tmp_path):
    from helpudoc_agent.knowledge_ingestion import pipeline
    monkeypatch.setattr(pipeline, "_build_plan", lambda path, **kw: (path, kw["ocr_adapter"]))
    path = tmp_path / "text.pdf"
    result = await pipeline.extract_and_plan_document_with_gemini(path, client=None, model="local", ocr_mode="off")
    assert result == (path, None)
