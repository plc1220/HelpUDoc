from helpudoc_agent.api.tool_output import (
    _extract_output_files_from_tool_result,
    _workspace_files_changed_event,
)


def test_workspace_file_change_event_normalizes_and_deduplicates_committed_paths():
    event = _workspace_files_changed_event(
        "workspace-123",
        [
            {"path": "/slides/final.pptx"},
            {"path": "slides\\final.pptx"},
            {"path": "previews/final.png"},
            {"path": "  "},
        ],
    )

    assert event == {
        "type": "workspace_files_changed",
        "workspaceId": "workspace-123",
        "paths": ["slides/final.pptx", "previews/final.png"],
    }


def test_workspace_file_change_event_requires_a_workspace_and_committed_path():
    assert _workspace_files_changed_event("", [{"path": "report.docx"}]) is None
    assert _workspace_files_changed_event("workspace-123", []) is None


def test_skill_sandbox_workspace_outputs_are_exposed_to_stream_contracts():
    outputs = _extract_output_files_from_tool_result(
        "run_skill_python_script",
        (
            "SKILL_SANDBOX_RUN_COMPLETED\n"
            "Workspace output file: sustainable-tourism-malaysia-deck.pptx\n"
        ),
    )

    assert outputs == [
        {
            "path": "sustainable-tourism-malaysia-deck.pptx",
            "mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }
    ]


def test_document_execute_published_output_is_exposed_to_stream_contracts():
    outputs = _extract_output_files_from_tool_result(
        "document_execute",
        '{"success":true,"published":true,"output_path":"reports/final.docx"}',
    )

    assert outputs == [
        {
            "path": "reports/final.docx",
            "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
    ]


def test_document_execute_unpublished_output_is_not_committed():
    assert _extract_output_files_from_tool_result(
        "document_execute",
        '{"success":false,"published":false,"output_path":"reports/invalid.docx"}',
    ) == []
