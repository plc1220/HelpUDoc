import asyncio
import json
from types import SimpleNamespace

import pytest
from langchain_core.tools import tool

from helpudoc_agent.slide_style_preview import preview_request, preview_tool_error
from helpudoc_agent.middleware.slide_style_preview import SlideStylePreviewMiddleware
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tool_guard import GuardedTool
from helpudoc_agent.interaction_contract import is_frontend_slides_edit_existing_context


def context():
    return {"current_user_prompt": 'SLIDE_STYLE_PREVIEW ' + json.dumps({
        "source": "campaign/deck.html", "output": "campaign/.style-preview-abc.html",
    }) + '\nRestyle the existing HTML deck campaign/deck.html.'}


@pytest.mark.parametrize('name,args', [
    ('write_file', {'file_path': '/campaign/deck.html'}),
    ('edit_file', {'file_path': 'campaign/../campaign/.style-preview-abc.html'}),
    ('write_file', {'file_path': '/skills/frontend-slides/SKILL.md'}),
    ('write_file', {'file_path': '/memories/preferences.md'}),
    ('upload_files', {'files': [['campaign/deck.html', b'bad']]}),
    ('run_skill_python_script', {}), ('execute', {}), ('python', {}),
    ('task', {}), ('image_generation', {}), ('external_mcp_write', {}),
])
def test_preview_blocks_alternate_mutations(name, args):
    assert preview_tool_error(context(), name, args)
    assert preview_tool_error({}, name, args) is None


@pytest.mark.parametrize('name,args', [
    ('read_file', {'file_path': '/campaign/deck.html'}), ('load_skill', {'skill_id': 'frontend-slides'}),
    ('write_file', {'file_path': '/campaign/.style-preview-abc.html'}),
    ('edit_file', {'file_path': 'campaign/.style-preview-abc.html'}),
])
def test_preview_allows_reads_and_exact_draft_only(name, args):
    assert preview_tool_error(context(), name, args) is None


def test_invalid_marker_fails_closed_and_plain_turn_is_unrestricted():
    assert preview_request({}) is None
    assert preview_request({'current_user_prompt': 'SLIDE_STYLE_PREVIEW {}'}) == {}
    assert preview_tool_error({'current_user_prompt': 'SLIDE_STYLE_PREVIEW {}'}, 'write_file', {'file_path': 'deck.html'})
    assert is_frontend_slides_edit_existing_context(context())


def test_middleware_guards_sync_and_async_native_filesystem_tools():
    middleware = SlideStylePreviewMiddleware()
    request = SimpleNamespace(runtime=SimpleNamespace(context=context()), tool_call={
        'id': 'call-1', 'name': 'write_file', 'args': {'file_path': 'campaign/deck.html'},
    })
    def handler(_):
        pytest.fail('Original deck must not be written')
    assert middleware.wrap_tool_call(request, handler).status == 'error'
    assert asyncio.run(middleware.awrap_tool_call(request, handler)).status == 'error'
    assert 'Only /campaign/.style-preview-abc.html' in middleware.before_model({}, request.runtime)['messages'][0].content


def test_guarded_tools_cannot_bypass_preview_through_code_interpreter(tmp_path):
    @tool
    def run_skill_python_script(script_name: str) -> str:
        """Execute a script."""
        pytest.fail('Preview must not run scripts')
    state = WorkspaceState(workspace_id='preview', root_path=tmp_path, context=context())
    guarded = GuardedTool.from_tool(run_skill_python_script, workspace_state=state)
    assert 'designated' in guarded.invoke({'script_name': 'unsafe'})


def test_filesystem_backend_enforces_boundary_even_without_tool_middleware(tmp_path):
    from helpudoc_agent.runtime.agent_registry import SkillScopedFilesystemBackend
    folder = tmp_path / 'campaign'
    folder.mkdir()
    source = folder / 'deck.html'
    source.write_text('original')
    state = WorkspaceState(workspace_id='preview', root_path=tmp_path, context=context())
    backend = SkillScopedFilesystemBackend(workspace_state=state, root_dir=str(tmp_path), virtual_mode=True)
    assert backend.write('/campaign/deck.html', 'modified').error
    assert backend.edit('/campaign/deck.html', 'original', 'modified').error
    assert backend.upload_files([('/campaign/deck.html', b'modified')])[0].error
    assert not backend.write('/campaign/.style-preview-abc.html', 'draft').error
    assert source.read_text() == 'original'
