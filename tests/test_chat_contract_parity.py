"""The streaming and non-streaming chat endpoints must enforce identical completion contracts.

The non-streaming `/chat` endpoint previously ran `_invoke_agent` and returned its reply with no
checks at all, so a research run could finish having written none of its 15 required artifacts and
still respond 200. Only the streaming path evaluated plan, source, and artifact contracts.

These tests pin the parity rather than the wording, so a future gate added to one path and not the
other fails here.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from helpudoc_agent.api.routes.chat import ContractFailure
from helpudoc_agent.state import AgentRuntimeState, WorkspaceState


def _runtime(tmp_path: Path, **context) -> AgentRuntimeState:
    workspace = WorkspaceState("workspace-1", tmp_path)
    workspace.context.update(context)
    return AgentRuntimeState("general", workspace, agent=SimpleNamespace())


# --------------------------------------------------------------------------------------
# ContractFailure rendering
# --------------------------------------------------------------------------------------

def test_stream_payload_omits_error_code_when_absent() -> None:
    """The plan contract historically emitted only a message; that shape must not change."""
    failure = ContractFailure(
        progress_label="Plan approval contract not satisfied",
        progress_detail="needs approval",
        error_message="needs approval",
    )

    payload = failure.contract_error_payload()

    assert payload == {"type": "contract_error", "message": "needs approval"}
    assert "errorCode" not in payload
    assert "retryable" not in payload
    assert "missing" not in payload


def test_stream_payload_carries_code_and_retryable_together() -> None:
    failure = ContractFailure(
        progress_label="Research source contract not satisfied",
        progress_detail="no sources",
        error_message="no sources",
        error_code="RESEARCH_SOURCES_UNAVAILABLE",
        retryable=True,
        done_error="no sources",
    )

    payload = failure.contract_error_payload()

    assert payload["errorCode"] == "RESEARCH_SOURCES_UNAVAILABLE"
    assert payload["retryable"] is True
    assert failure.done_error == "no sources"


def test_stream_payload_includes_missing_artifact_list() -> None:
    failure = ContractFailure(
        progress_label="Artifact contract not satisfied",
        error_message="Artifact contract not satisfied.",
        missing=["/question.txt", "/research_plan.md"],
        context_flag="artifact_contract_failed",
    )

    payload = failure.contract_error_payload()

    assert payload["missing"] == ["/question.txt", "/research_plan.md"]
    # The artifact case deliberately carries no progress detail.
    assert failure.progress_detail is None


def test_http_detail_always_carries_a_machine_readable_code() -> None:
    """A 422 body must be actionable even for contracts that emit no stream errorCode."""
    plain = ContractFailure(progress_label="l", error_message="m")
    coded = ContractFailure(
        progress_label="l", error_message="m", error_code="RESEARCH_SOURCES_UNAVAILABLE", retryable=True,
    )
    with_missing = ContractFailure(
        progress_label="l", error_message="m", missing=["/question.txt"],
    )

    assert plain.http_detail() == {
        "message": "m", "code": "CONTRACT_NOT_SATISFIED", "retryable": False,
    }
    assert coded.http_detail()["code"] == "RESEARCH_SOURCES_UNAVAILABLE"
    assert coded.http_detail()["retryable"] is True
    assert with_missing.http_detail()["missing"] == ["/question.txt"]


# --------------------------------------------------------------------------------------
# Both endpoints evaluate the same contracts
# --------------------------------------------------------------------------------------

@pytest.fixture()
def app_module():
    import helpudoc_agent.api.routes.chat as chat_module
    return chat_module


def test_both_endpoints_share_one_contract_evaluator(app_module) -> None:
    """Parity is structural: there is exactly one evaluator, used by both paths.

    Guards against reintroducing a per-endpoint chain of contract checks, which is how the two
    paths diverged in the first place.
    """
    source = Path(app_module.__file__).read_text(encoding="utf-8")

    assert source.count("def _evaluate_completion_contracts(") == 1
    # Both the stream generator and the non-streaming endpoint must call it.
    assert source.count("_evaluate_completion_contracts(") >= 3

    # The individual contract helpers must not be called directly by the endpoints any more.
    assert source.count("_missing_required_artifacts(runtime)") == 1
    assert source.count("_research_source_contract_error(runtime, source_tracker)") == 1


def test_non_streaming_endpoint_rejects_instead_of_returning_200(app_module) -> None:
    source = Path(app_module.__file__).read_text(encoding="utf-8")
    # The endpoint body must raise rather than fall through to ChatResponse on failure.
    endpoint = source.split('@app.post("/agents/{agent_name}/workspace/{workspace_id}/chat",')[1]
    endpoint = endpoint.split("@app.post")[0]

    assert "_evaluate_completion_contracts(runtime)" in endpoint
    assert "status_code=422" in endpoint
    assert "raise HTTPException" in endpoint
    # The success return must come after the guard.
    assert endpoint.index("raise HTTPException") < endpoint.index("return ChatResponse")


def test_activation_check_runs_before_the_model(app_module) -> None:
    """An explicit skill that cannot load must fail before tokens are spent."""
    source = Path(app_module.__file__).read_text(encoding="utf-8")
    invoke = source.split("async def _invoke_agent(")[1].split("def _json_line")[0]

    assert "_skill_activation_contract_error(runtime)" in invoke
    assert invoke.index("_skill_activation_contract_error") < invoke.index("ainvoke")
