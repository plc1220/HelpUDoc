"""Security and path validation tests for office-service."""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from security import (
    InvalidOperationError,
    PathTraversalError,
    resolve_workspace_path,
    validate_extension,
    validate_operations,
)


class TestResolveWorkspacePath:
    def test_valid_simple_path(self, workspace_root):
        ws_id = "test-ws"
        (workspace_root / ws_id).mkdir()
        result = resolve_workspace_path(str(workspace_root), ws_id, "reports/doc.docx")
        assert result == (workspace_root / ws_id / "reports" / "doc.docx").resolve()

    def test_rejects_absolute_path(self, workspace_root):
        with pytest.raises(PathTraversalError, match="Absolute paths"):
            resolve_workspace_path(str(workspace_root), "ws", "/etc/passwd")

    def test_rejects_dotdot(self, workspace_root):
        with pytest.raises(PathTraversalError, match="must not contain"):
            resolve_workspace_path(str(workspace_root), "ws", "../escape.docx")

    def test_rejects_dotdot_embedded(self, workspace_root):
        with pytest.raises(PathTraversalError, match="must not contain"):
            resolve_workspace_path(str(workspace_root), "ws", "sub/../../escape.docx")

    def test_rejects_empty_path(self, workspace_root):
        with pytest.raises(PathTraversalError, match="must not be empty"):
            resolve_workspace_path(str(workspace_root), "ws", "")

    def test_rejects_symlink_escape(self, workspace_root):
        ws_id = "test-ws"
        ws_dir = workspace_root / ws_id
        ws_dir.mkdir()
        external_file = workspace_root / "external-secret.txt"
        external_file.write_text("secret")
        symlink = ws_dir / "escape.docx"
        symlink.symlink_to(external_file)
        with pytest.raises(PathTraversalError):
            resolve_workspace_path(str(workspace_root), ws_id, "escape.docx")

    def test_nested_path_valid(self, workspace_root):
        ws_id = "test-ws"
        (workspace_root / ws_id).mkdir()
        result = resolve_workspace_path(str(workspace_root), ws_id, "a/b/c/document.docx")
        expected = (workspace_root / ws_id / "a" / "b" / "c" / "document.docx").resolve()
        assert result == expected


class TestValidateExtension:
    def test_valid_docx(self):
        validate_extension("report.docx")

    def test_valid_xlsx(self):
        validate_extension("data.xlsx")

    def test_valid_pptx(self):
        validate_extension("slides.pptx")

    def test_rejects_pdf(self):
        with pytest.raises(InvalidOperationError, match="extension"):
            validate_extension("report.pdf")

    def test_rejects_no_extension(self):
        with pytest.raises(InvalidOperationError, match="extension"):
            validate_extension("noextension")

    def test_case_insensitive(self):
        validate_extension("REPORT.DOCX")


class TestValidateOperations:
    """Tests with per-command allowlists matching real OfficeCLI dispatch."""

    def test_valid_add(self):
        ops = [{"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "hi"}}]
        validate_operations(ops, max_operations=50)

    def test_valid_set(self):
        ops = [{"command": "set", "path": "/body/p[1]", "props": {"bold": "true"}}]
        validate_operations(ops, max_operations=50)

    def test_valid_get(self):
        ops = [{"command": "get", "path": "/body/p[1]", "depth": 2}]
        validate_operations(ops, max_operations=50)

    def test_valid_query_with_text(self):
        ops = [{"command": "query", "selector": "p", "text": "hello"}]
        validate_operations(ops, max_operations=50)

    def test_valid_remove_with_props(self):
        ops = [{"command": "remove", "path": "/body/p[2]", "props": {"type": "footnote"}}]
        validate_operations(ops, max_operations=50)

    def test_valid_move_with_props(self):
        ops = [{"command": "move", "path": "/body/p[3]", "after": "/body/p[1]", "props": {"keep": "true"}}]
        validate_operations(ops, max_operations=50)

    def test_valid_swap_with_to(self):
        ops = [{"command": "swap", "path": "/body/p[1]", "path2": "/body/p[2]", "to": "/body"}]
        validate_operations(ops, max_operations=50)

    def test_valid_view(self):
        ops = [{"command": "view", "mode": "outline"}]
        validate_operations(ops, max_operations=50)

    def test_valid_validate(self):
        ops = [{"command": "validate"}]
        validate_operations(ops, max_operations=50)

    def test_rejects_too_many(self):
        ops = [{"command": "get", "path": "/body"}] * 10
        with pytest.raises(InvalidOperationError, match="Too many"):
            validate_operations(ops, max_operations=5)

    def test_rejects_missing_command(self):
        ops = [{"path": "/body"}]
        with pytest.raises(InvalidOperationError, match="must have 'command'"):
            validate_operations(ops, max_operations=50)

    def test_rejects_raw(self):
        ops = [{"command": "raw"}]
        with pytest.raises(InvalidOperationError, match="not allowed"):
            validate_operations(ops, max_operations=50)

    def test_rejects_raw_set(self):
        ops = [{"command": "raw-set"}]
        with pytest.raises(InvalidOperationError, match="not allowed"):
            validate_operations(ops, max_operations=50)

    def test_rejects_add_part(self):
        ops = [{"command": "add-part"}]
        with pytest.raises(InvalidOperationError, match="not allowed"):
            validate_operations(ops, max_operations=50)

    def test_rejects_meta(self):
        ops = [{"command": "meta"}]
        with pytest.raises(InvalidOperationError, match="not allowed"):
            validate_operations(ops, max_operations=50)

    def test_rejects_import(self):
        ops = [{"command": "import"}]
        with pytest.raises(InvalidOperationError, match="not allowed"):
            validate_operations(ops, max_operations=50)

    def test_rejects_from_field(self):
        """'from' is blocked at top level."""
        ops = [{"command": "add", "parent": "/body", "type": "paragraph", "from": "/other"}]
        with pytest.raises(InvalidOperationError, match="blocked fields"):
            validate_operations(ops, max_operations=50)

    def test_rejects_file_field(self):
        ops = [{"command": "get", "path": "/body", "file": "/etc/passwd"}]
        with pytest.raises(InvalidOperationError, match="blocked fields"):
            validate_operations(ops, max_operations=50)

    def test_rejects_url_field(self):
        ops = [{"command": "get", "path": "/body", "url": "http://evil.com"}]
        with pytest.raises(InvalidOperationError, match="blocked fields"):
            validate_operations(ops, max_operations=50)

    def test_rejects_xpath_on_safe_ops(self):
        ops = [{"command": "set", "path": "/body/p[1]", "xpath": "//w:t"}]
        with pytest.raises(InvalidOperationError, match="not allowed for this command"):
            validate_operations(ops, max_operations=50)

    def test_rejects_xml_on_safe_ops(self):
        ops = [{"command": "add", "parent": "/body", "type": "paragraph", "xml": "<w:p/>"}]
        with pytest.raises(InvalidOperationError, match="not allowed for this command"):
            validate_operations(ops, max_operations=50)

    def test_rejects_part_on_safe_ops(self):
        ops = [{"command": "get", "path": "/body", "part": "/document"}]
        with pytest.raises(InvalidOperationError, match="not allowed for this command"):
            validate_operations(ops, max_operations=50)

    def test_rejects_action_on_safe_ops(self):
        ops = [{"command": "set", "path": "/body/p[1]", "action": "delete"}]
        with pytest.raises(InvalidOperationError, match="not allowed for this command"):
            validate_operations(ops, max_operations=50)

    # --- Fix 3 regression: nested 'path' must be blocked ---
    def test_rejects_nested_path_in_props(self):
        """'path' inside props is blocked — potential filesystem reference."""
        ops = [{"command": "set", "path": "/body/p[1]", "props": {"path": "/etc/secret"}}]
        with pytest.raises(InvalidOperationError, match="nested key 'path'"):
            validate_operations(ops, max_operations=50)

    def test_rejects_nested_src_in_props(self):
        ops = [{"command": "set", "path": "/body/p[1]", "props": {"src": "/etc/secret"}}]
        with pytest.raises(InvalidOperationError, match="nested key 'src'"):
            validate_operations(ops, max_operations=50)

    def test_rejects_nested_fallback_in_props(self):
        ops = [{"command": "set", "path": "/body/p[1]", "props": {"fallback": "/tmp/x"}}]
        with pytest.raises(InvalidOperationError, match="nested key 'fallback'"):
            validate_operations(ops, max_operations=50)

    def test_rejects_nested_url_in_props(self):
        ops = [{"command": "set", "path": "/body/p[1]", "props": {"url": "http://evil.com"}}]
        with pytest.raises(InvalidOperationError, match="nested key 'url'"):
            validate_operations(ops, max_operations=50)

    def test_rejects_deeply_nested_path(self):
        """'path' blocked even deeply nested."""
        ops = [{"command": "set", "path": "/body/p[1]", "props": {"nested": {"path": "/x"}}}]
        with pytest.raises(InvalidOperationError, match="nested key 'path'"):
            validate_operations(ops, max_operations=50)

    def test_allows_text_in_props(self):
        ops = [{"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "Hello"}}]
        validate_operations(ops, max_operations=50)

    def test_allows_op_alias(self):
        ops = [{"op": "get", "path": "/body"}]
        validate_operations(ops, max_operations=50)

    def test_rejects_non_string_command(self):
        with pytest.raises(InvalidOperationError, match="must be a string"):
            validate_operations([{"command": {"name": "get"}}], max_operations=50)

    def test_rejects_command_and_op_even_when_equal(self):
        ops = [{"command": "get", "op": "get", "path": "/body"}]
        with pytest.raises(InvalidOperationError, match="must not contain both"):
            validate_operations(ops, max_operations=50)
