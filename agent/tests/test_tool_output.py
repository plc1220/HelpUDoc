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
