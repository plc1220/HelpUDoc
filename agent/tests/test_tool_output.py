from helpudoc_agent.api.tool_output import _extract_output_files_from_tool_result


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
