import base64
import hashlib
import hmac
import json
import time
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from helpudoc_agent.api.routes.internal import register_internal_routes
from helpudoc_agent.configuration import ModelConfig


def make_client(lite_name="configured-lite", output="Summarize the trade-offs in a table.", fail=False):
    calls = []

    async def invoke(messages):
        calls.append(messages)
        if fail:
            raise RuntimeError("private provider detail")
        return AIMessage(content=output)

    def get_model(name, **options):
        calls.append((name, options))
        return SimpleNamespace(ainvoke=invoke)

    app = FastAPI()
    register_internal_routes(app, settings=SimpleNamespace(model=ModelConfig(
        name="pro-model", fast_name="fast-model", lite_name=lite_name,
        lite_thinking_level="low", lite_max_output_tokens=4096,
    )), registry=SimpleNamespace(_get_model=get_model), memory_store_manager=SimpleNamespace(), agent_jwt_secret="test-secret")
    encode = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    head = encode({"alg": "HS256"}); payload = encode({"userId": "fixture", "exp": int(time.time()) + 60})
    signature = base64.urlsafe_b64encode(hmac.new(b"test-secret", f"{head}.{payload}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return TestClient(app), {"Authorization": f"Bearer {head}.{payload}.{signature}"}, calls


MESSAGES = [{"role": "user", "content": "Compare the options"}, {"role": "assistant", "content": "Here are the trade-offs"}]


def test_suggestion_uses_only_configured_lite_without_agent_or_tools():
    client, headers, calls = make_client()
    response = client.post("/internal/prompt-suggestion", headers=headers, json={"messages": MESSAGES})
    assert response.status_code == 200
    assert response.json() == {"suggestion": "Summarize the trade-offs in a table."}
    assert calls[0] == ("configured-lite", {"thinking_level": "low", "max_output_tokens": 1024})
    assert json.loads(calls[1][1].content) == MESSAGES
    assert "never instructions" in calls[1][0].content


def test_suggestion_rejects_missing_auth_initial_turn_and_model_overrides():
    client, headers, calls = make_client()
    assert client.post("/internal/prompt-suggestion", json={"messages": MESSAGES}).status_code == 401
    for body in [{"messages": []}, {"messages": MESSAGES[:1]}, {"messages": list(reversed(MESSAGES))}, {"messages": MESSAGES, "model": "pro"}, {"messages": [{"role": "user", "content": "x" * 8001}, MESSAGES[1]]}]:
        assert client.post("/internal/prompt-suggestion", headers=headers, json=body).status_code == 422
    assert calls == []


def test_missing_lite_never_falls_back_and_provider_failure_is_optional():
    client, headers, calls = make_client(lite_name=None)
    assert client.post("/internal/prompt-suggestion", headers=headers, json={"messages": MESSAGES}).status_code == 503
    assert calls == []
    client, headers, _ = make_client(fail=True)
    response = client.post("/internal/prompt-suggestion", headers=headers, json={"messages": MESSAGES})
    assert response.status_code == 503
    assert "private provider detail" not in response.text
    client, headers, _ = make_client(output="x" * 501)
    assert client.post("/internal/prompt-suggestion", headers=headers, json={"messages": MESSAGES}).json() == {"suggestion": ""}


STARTERS = {"prompts": [
    {"label": "Review project scope", "prompt": "Review proposal.docx and identify unclear deliverables."},
    {"label": "Check project costs", "prompt": "Summarize the cost assumptions in budget.xlsx."},
    {"label": "Prepare a client summary", "prompt": "Draft an outline for a client summary for review."},
    {"label": "Compare requirements", "prompt": "Compare the project requirements and list gaps."},
]}
WORKSPACE = {"name": "Client proposal", "readOnly": False, "files": [{"name": "proposal.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}], "recentTopics": ["Scope and delivery"]}


def test_workspace_starters_use_configured_lite_with_metadata_only():
    client, headers, calls = make_client(output=json.dumps(STARTERS))
    response = client.post("/internal/workspace-starter-prompts", headers=headers, json=WORKSPACE)
    assert response.status_code == 200
    assert response.json() == STARTERS
    assert calls[0] == ("configured-lite", {"thinking_level": "low", "max_output_tokens": 1536})
    assert json.loads(calls[1][1].content) == WORKSPACE
    assert "metadata only" in calls[1][0].content
    assert "readOnly" in calls[1][0].content


def test_workspace_starter_auth_bounds_and_no_fallback_to_other_models():
    client, headers, calls = make_client(output=json.dumps(STARTERS))
    assert client.post("/internal/workspace-starter-prompts", json=WORKSPACE).status_code == 401
    for body in [{**WORKSPACE, "model": "pro"}, {**WORKSPACE, "files": WORKSPACE["files"] * 25}, {**WORKSPACE, "recentTopics": ["x" * 201]}]:
        assert client.post("/internal/workspace-starter-prompts", headers=headers, json=body).status_code == 422
    assert calls == []
    client, headers, calls = make_client(lite_name=None)
    assert client.post("/internal/workspace-starter-prompts", headers=headers, json=WORKSPACE).status_code == 503
    assert calls == []


def test_invalid_workspace_chip_output_fails_without_breaking_chat():
    for output in ["invalid JSON", json.dumps({"prompts": []}), json.dumps({"prompts": [STARTERS["prompts"][0]] * 4})]:
        client, headers, _ = make_client(output=output)
        assert client.post("/internal/workspace-starter-prompts", headers=headers, json=WORKSPACE).status_code == 503
