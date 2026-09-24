from docx import Document
from langchain_core.tools import tool
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tool_guard import GuardedTool
from helpudoc_agent.tools.workspace.builtins.document_inspection import build_document_inspection_tools


def test_builder_reads_docx_context_and_cannot_execute_workflow(tmp_path):
    document = Document()
    document.add_paragraph('Use a concise tone in the daily email summary.')
    document.save(tmp_path / 'policy.docx')
    workspace = WorkspaceState(workspace_id='builder', root_path=tmp_path)
    workspace.context.update({'skill_builder': True, 'can_write_workspace': False})
    tools = {item.name: item for item in build_document_inspection_tools(workspace)}
    inspector = GuardedTool.from_tool(tools['inspect_document'], workspace_state=workspace)
    output = inspector.invoke({'file_path': 'policy.docx'})
    assert 'concise tone' in output
    calls = []
    @tool
    def send_email() -> str:
        """Send an email."""
        calls.append('sent')
        return 'sent'
    sender = GuardedTool.from_tool(send_email, workspace_state=workspace, tool_mcp_server='google-workspace')
    assert 'cannot execute' in sender.invoke({})
    assert calls == []
