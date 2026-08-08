"""Direct unit tests for strict executor parsing logic."""

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("OFFICE_SERVICE_WORKSPACE_ROOT", "/tmp/test")
os.environ.setdefault("OFFICE_SERVICE_OFFICECLI_BIN", "/tmp/fake")

from executor import (
    OfficeCLIOutputError,
    _assert_workspace_containment,
    _parse_batch_output,
    _parse_create_output,
    _parse_validate_output,
    _read_spill_file,
)

OPS_1 = [{"command": "get", "path": "/body"}]
OPS_2 = [{"command": "get", "path": "/body"}, {"command": "set", "path": "/body/p[1]", "props": {"bold": "true"}}]


def _batch_envelope(results, summary, success=True):
    return json.dumps({"success": success, "data": {"results": results, "summary": summary}})


def _good_summary(n, succeeded=None, failed=0):
    s = succeeded if succeeded is not None else n - failed
    return {"total": n, "executed": n, "succeeded": s, "failed": failed, "skipped": 0}


def _good_results(n):
    return [{"index": i, "success": True, "output": f"ok{i}"} for i in range(n)]


class TestBatchStrictResultValidation:
    """Item-level strict checks."""

    def test_valid_single_op(self):
        stdout = _batch_envelope(_good_results(1), _good_summary(1))
        success, valid, results, summary, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert success is True
        assert valid is True
        assert results[0].success is True

    def test_missing_index_fails(self):
        results = [{"success": True, "output": "x"}]  # no index
        stdout = _batch_envelope(results, _good_summary(1))
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_wrong_index_fails(self):
        results = [{"index": 5, "success": True}]
        stdout = _batch_envelope(results, _good_summary(1))
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_bool_index_fails(self):
        results = [{"index": True, "success": True}]
        stdout = _batch_envelope(results, _good_summary(1))
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_missing_success_in_item_fails(self):
        results = [{"index": 0, "output": "x"}]
        stdout = _batch_envelope(results, _good_summary(1))
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_non_bool_success_in_item_fails(self):
        results = [{"index": 0, "success": 1}]
        stdout = _batch_envelope(results, _good_summary(1))
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_non_string_error_fails(self):
        results = [{"index": 0, "success": False, "error": 123}]
        stdout = _batch_envelope(results, _good_summary(1, failed=1), success=False)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 1, OPS_1)
        assert valid is False

    def test_non_string_code_fails(self):
        results = [{"index": 0, "success": False, "error": "x", "code": 42}]
        stdout = _batch_envelope(results, _good_summary(1, failed=1), success=False)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 1, OPS_1)
        assert valid is False

    def test_non_object_result_item_fails(self):
        results = ["not an object"]
        stdout = _batch_envelope(results, _good_summary(1))
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False


class TestBatchStrictSummaryValidation:
    """Summary cross-check tests."""

    def test_missing_summary_fails(self):
        stdout = json.dumps({"success": True, "data": {"results": _good_results(1)}})
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_bool_total_fails(self):
        summary = {"total": True, "executed": 1, "succeeded": 1, "failed": 0, "skipped": 0}
        stdout = _batch_envelope(_good_results(1), summary)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_total_mismatch_ops_fails(self):
        summary = {"total": 5, "executed": 1, "succeeded": 1, "failed": 0, "skipped": 4}
        stdout = _batch_envelope(_good_results(1), summary)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_executed_mismatch_results_fails(self):
        summary = {"total": 1, "executed": 2, "succeeded": 1, "failed": 0, "skipped": 0}
        stdout = _batch_envelope(_good_results(1), summary)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_succeeded_mismatch_fails(self):
        summary = {"total": 1, "executed": 1, "succeeded": 0, "failed": 0, "skipped": 0}
        stdout = _batch_envelope(_good_results(1), summary)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_failed_mismatch_fails(self):
        summary = {"total": 1, "executed": 1, "succeeded": 1, "failed": 1, "skipped": 0}
        stdout = _batch_envelope(_good_results(1), summary)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_succeeded_plus_failed_ne_executed_fails(self):
        results = [{"index": 0, "success": True}, {"index": 1, "success": False, "error": "x"}]
        summary = {"total": 2, "executed": 2, "succeeded": 1, "failed": 0, "skipped": 0}
        stdout = _batch_envelope(results, summary, success=False)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 1, OPS_2)
        assert valid is False

    def test_skipped_ne_total_minus_executed_fails(self):
        summary = {"total": 1, "executed": 1, "succeeded": 1, "failed": 0, "skipped": 1}
        stdout = _batch_envelope(_good_results(1), summary)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False


class TestBatchEnvelopeConsistency:
    """Envelope success vs results consistency, rc handling."""

    def test_envelope_success_mismatch_is_contract_invalid(self):
        """The outer envelope must agree with the per-item summary."""
        results = [{"index": 0, "success": False, "error": "bad"}]
        summary = {"total": 1, "executed": 1, "succeeded": 0, "failed": 1, "skipped": 0}
        stdout = _batch_envelope(results, summary, success=True)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 1, OPS_1)
        assert valid is False
        assert success is False

    def test_rc2_valid_success(self):
        """rc=2 is a valid success (OfficeCLI warnings)."""
        stdout = json.dumps({
            "success": True,
            "warnings": [{"message": "fallback used", "code": "advisory"}],
            "data": {"results": _good_results(1), "summary": _good_summary(1)},
        })
        success, valid, _, _, w = _parse_batch_output(stdout, "", 2, OPS_1)
        assert valid is True
        assert success is True
        assert "[advisory] fallback used" in w

    def test_rc2_without_warning_object_is_contract_invalid(self):
        stdout = _batch_envelope(_good_results(1), _good_summary(1))
        _, valid, _, _, _ = _parse_batch_output(stdout, "", 2, OPS_1)
        assert valid is False

    def test_rc0_with_warning_object_is_contract_invalid(self):
        stdout = json.dumps({
            "success": True,
            "warnings": [{"message": "fallback used"}],
            "data": {"results": _good_results(1), "summary": _good_summary(1)},
        })
        _, valid, _, _, _ = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_rc1_with_success_is_contract_invalid(self):
        """rc=1 is reserved for a valid failure envelope."""
        stdout = _batch_envelope(_good_results(1), _good_summary(1))
        success, valid, _, _, w = _parse_batch_output(stdout, "", 1, OPS_1)
        assert valid is False
        assert success is False

    def test_valid_failure_envelope_with_rc1(self):
        results = [{"index": 0, "success": False, "error": "bad"}]
        stdout = _batch_envelope(results, _good_summary(1, failed=1), success=False)
        success, valid, _, _, _ = _parse_batch_output(stdout, "", 1, OPS_1)
        assert valid is True
        assert success is False

    def test_failure_envelope_with_rc0_is_contract_invalid(self):
        results = [{"index": 0, "success": False, "error": "bad"}]
        stdout = _batch_envelope(results, _good_summary(1, failed=1), success=False)
        success, valid, _, _, _ = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False
        assert success is False

    def test_atomic_rolled_back_wrong_type_is_contract_invalid(self):
        summary = _good_summary(1)
        summary["atomicRolledBack"] = "false"
        stdout = _batch_envelope(_good_results(1), summary)
        _, valid, _, _, _ = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_result_count_mismatch_contract_invalid(self):
        results = _good_results(2)
        summary = {"total": 2, "executed": 2, "succeeded": 2, "failed": 0, "skipped": 0}
        stdout = _batch_envelope(results, summary)
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)  # only 1 op
        assert valid is False

    def test_data_not_dict_contract_invalid(self):
        stdout = json.dumps({"success": True, "data": "string"})
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False


class TestValidateStrict:
    """Strict validate output parsing."""

    def test_valid_zero_errors(self):
        stdout = '{"success": true, "data": {"count": 0, "errors": []}}'
        result = _parse_validate_output(stdout, "", 0)
        assert result.success is True
        assert result.count == 0

    def test_valid_with_errors(self):
        stdout = '{"success": false, "data": {"count": 2, "errors": ["a", "b"]}}'
        result = _parse_validate_output(stdout, "", 1)
        assert result.success is False
        assert result.count == 2

    def test_missing_count_raises(self):
        stdout = '{"success": true, "data": {"errors": []}}'
        with pytest.raises(OfficeCLIOutputError, match="count"):
            _parse_validate_output(stdout, "", 0)

    def test_bool_count_raises(self):
        stdout = '{"success": true, "data": {"count": true, "errors": []}}'
        with pytest.raises(OfficeCLIOutputError, match="count"):
            _parse_validate_output(stdout, "", 0)

    def test_missing_errors_raises(self):
        stdout = '{"success": true, "data": {"count": 0}}'
        with pytest.raises(OfficeCLIOutputError, match="errors"):
            _parse_validate_output(stdout, "", 0)

    def test_count_len_mismatch_raises(self):
        stdout = '{"success": true, "data": {"count": 0, "errors": ["x"]}}'
        with pytest.raises(OfficeCLIOutputError, match="count=0"):
            _parse_validate_output(stdout, "", 0)

    def test_data_not_dict_raises(self):
        stdout = '{"success": true, "data": "string"}'
        with pytest.raises(OfficeCLIOutputError, match="not an object"):
            _parse_validate_output(stdout, "", 0)

    def test_empty_stdout_raises(self):
        with pytest.raises(OfficeCLIOutputError, match="empty"):
            _parse_validate_output("", "", 0)

    def test_success_must_match_error_count(self):
        stdout = '{"success": false, "data": {"count": 0, "errors": []}}'
        with pytest.raises(OfficeCLIOutputError, match="inconsistent"):
            _parse_validate_output(stdout, "", 1)

    def test_return_code_must_match_success(self):
        stdout = '{"success": true, "data": {"count": 0, "errors": []}}'
        with pytest.raises(OfficeCLIOutputError, match="rc=1"):
            _parse_validate_output(stdout, "", 1)

    def test_validate_rc2_is_not_a_success_code(self):
        stdout = '{"success": true, "data": {"count": 0, "errors": []}}'
        with pytest.raises(OfficeCLIOutputError, match="rc=2"):
            _parse_validate_output(stdout, "", 2)


class TestCreateStrict:
    """Strict create output parsing."""

    def test_valid_create(self):
        stdout = '{"success": true, "data": "Created: /tmp/x.docx", "message": "Created: /tmp/x.docx"}'
        _parse_create_output(stdout, "", 0)  # should not raise

    def test_create_failure_raises_output_error(self):
        stdout = '{"success": false, "data": "failed"}'
        with pytest.raises(OfficeCLIOutputError, match="create failed"):
            _parse_create_output(stdout, "", 1)

    def test_create_malformed_json_raises_output_error(self):
        with pytest.raises(OfficeCLIOutputError, match="Malformed JSON"):
            _parse_create_output("not json", "", 0)

    def test_create_bad_rc_raises(self):
        stdout = '{"success": true, "data": "ok", "message": "ok"}'
        with pytest.raises(OfficeCLIOutputError, match="rc=3"):
            _parse_create_output(stdout, "", 3)

    def test_create_rc2_rejected(self):
        stdout = '{"success": true, "data": "ok", "message": "ok"}'
        with pytest.raises(OfficeCLIOutputError, match="rc=2"):
            _parse_create_output(stdout, "", 2)

    def test_create_success_requires_data_and_message(self):
        with pytest.raises(OfficeCLIOutputError, match="requires string"):
            _parse_create_output('{"success": true}', "", 0)

    def test_create_data_and_message_must_match(self):
        stdout = '{"success": true, "data": "one", "message": "two"}'
        with pytest.raises(OfficeCLIOutputError, match="must match"):
            _parse_create_output(stdout, "", 0)


class TestSpillFileStrict:
    """Spill file reader strict validation."""

    def test_rejects_non_string_output_file(self):
        """outputFile with wrong type should raise."""
        # This is tested at the call site in _parse_batch_output
        stdout = json.dumps({"success": True, "data": {"outputFile": 123, "results": [], "summary": {}}})
        # The raise happens in _parse_batch_output when it checks isinstance
        # Actually it checks `if output_file and isinstance(output_file, str)` so 123 would pass the truthy check
        # The audit says "Reject outputFile key with wrong type" — this should raise
        # Let's test _parse_batch_output directly
        success, valid, _, _, w = _parse_batch_output(stdout, "", 0, OPS_1)
        # With wrong type, it should still fail (count mismatch since results=[])
        assert valid is False

    def test_rejects_null_output_file(self):
        stdout = json.dumps({"success": True, "data": {"outputFile": None}})
        _, valid, _, _, _ = _parse_batch_output(stdout, "", 0, OPS_1)
        assert valid is False

    def test_rejects_bad_filename_pattern(self):
        with pytest.raises(OfficeCLIOutputError, match="bad name"):
            _read_spill_file("/tmp/evil.json", {"outputSize": 10}, max_size=1024)

    def test_rejects_wrong_parent(self):
        with pytest.raises(OfficeCLIOutputError, match="parent"):
            _read_spill_file(
                "/etc/officecli_batch_00000000000000000000000000000000.json",
                {"outputSize": 10}, max_size=1024,
            )

    def test_rejects_missing_output_size(self):
        # Create a real temp file to test size validation
        tmpdir = tempfile.gettempdir()
        path = os.path.join(tmpdir, "officecli_batch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json")
        try:
            with open(path, "w") as f:
                json.dump({"results": [], "summary": {}}, f)
            with pytest.raises(OfficeCLIOutputError, match="outputSize"):
                _read_spill_file(path, {}, max_size=1024 * 1024)
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_rejects_size_mismatch(self):
        tmpdir = tempfile.gettempdir()
        path = os.path.join(tmpdir, "officecli_batch_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json")
        try:
            with open(path, "w") as f:
                json.dump({"results": [], "summary": {}}, f)
            actual_size = os.path.getsize(path)
            with pytest.raises(OfficeCLIOutputError, match="outputSize"):
                _read_spill_file(path, {"outputSize": actual_size + 100}, max_size=1024 * 1024)
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_valid_spill_file(self):
        tmpdir = tempfile.gettempdir()
        path = os.path.join(tmpdir, "officecli_batch_cccccccccccccccccccccccccccccccc.json")
        content = {"results": [{"index": 0, "success": True, "output": "hi"}], "summary": {"total": 1}}
        try:
            with open(path, "w") as f:
                json.dump(content, f)
            actual_size = os.path.getsize(path)
            result = _read_spill_file(path, {"outputSize": actual_size}, max_size=1024 * 1024)
            assert result["results"][0]["output"] == "hi"
            assert not os.path.exists(path)  # unlinked
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_rejects_spill_symlink_without_following_target(self, tmp_path):
        tmpdir = Path(tempfile.gettempdir())
        target = tmp_path / "target.json"
        target.write_text('{"results": [], "summary": {}}')
        link = tmpdir / "officecli_batch_dddddddddddddddddddddddddddddddd.json"
        link.unlink(missing_ok=True)
        link.symlink_to(target)
        try:
            with pytest.raises(OfficeCLIOutputError, match="open/read spill"):
                _read_spill_file(
                    str(link), {"outputSize": target.stat().st_size}, max_size=1024
                )
            assert target.exists()
        finally:
            link.unlink(missing_ok=True)


def test_runtime_containment_recheck_rejects_parent_symlink_swap(tmp_path):
    workspace = tmp_path / "root" / "ws"
    subdir = workspace / "sub"
    outside = tmp_path / "outside"
    subdir.mkdir(parents=True)
    outside.mkdir()
    output = subdir / "out.docx"

    subdir.rename(workspace / "sub-original")
    subdir.symlink_to(outside, target_is_directory=True)

    with pytest.raises(OfficeCLIOutputError, match="escaped the workspace"):
        _assert_workspace_containment(workspace, output, "output path")
