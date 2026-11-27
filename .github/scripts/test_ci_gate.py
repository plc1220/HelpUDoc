"""Regression coverage for required builds, intentional skips and detection failure."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from ci_gate import JOB_FILTERS, failures


def results(**filters: str) -> dict:
    return {
        "changes": {"result": "success", "outputs": {"backend": "false", "frontend": "false", "agent": "false", "spreadsheet": "false", **filters}},
        **{job: {"result": "success" if filters.get(path) == "true" else "skipped"} for job, path in JOB_FILTERS.items()},
    }


class GateTests(unittest.TestCase):
    def test_unrelated_pr_can_skip_agent_and_keep_green_aggregate(self):
        self.assertEqual(failures(results(backend="true"), "pull_request", "refs/pull/1/merge"), [])

    def test_required_agent_build_passes_when_both_matrix_architectures_pass(self):
        self.assertEqual(failures(results(agent="true"), "pull_request", "refs/pull/1/merge"), [])

    def test_required_agent_cannot_skip_fail_cancel_or_be_missing(self):
        for result in ["skipped", "failure", "cancelled", "", None, "unknown"]:
            with self.subTest(result=result):
                needs = results(agent="true")
                needs["docker-agent"]["result"] = result
                self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))
        needs = results(agent="true")
        del needs["docker-agent"]
        self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))

    def test_required_xlsx_preview_cannot_skip_fail_cancel_or_be_missing(self):
        self.assertEqual(failures(results(frontend="true", spreadsheet="true"), "pull_request", "refs/pull/1/merge"), [])
        for result in ["skipped", "failure", "cancelled", None]:
            with self.subTest(result=result):
                needs = results(frontend="true", spreadsheet="true")
                needs["xlsx-preview"]["result"] = result
                self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))
        needs = results(frontend="true", spreadsheet="true")
        del needs["xlsx-preview"]
        self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))

    def test_unrelated_frontend_pr_can_skip_xlsx_preview(self):
        self.assertEqual(failures(results(frontend="true"), "pull_request", "refs/pull/1/merge"), [])

    def test_path_detection_failure_cancellation_and_skip_fail_gate(self):
        for result in ["failure", "cancelled", "skipped", None]:
            with self.subTest(result=result):
                needs = results()
                needs["changes"]["result"] = result
                self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))

    def test_path_detection_missing_or_invalid_output_fails_gate(self):
        for name in ["backend", "frontend", "agent", "spreadsheet"]:
            for value in [None, "", "unknown", True]:
                with self.subTest(name=name, value=value):
                    needs = results()
                    needs["changes"]["outputs"][name] = value
                    self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))
        self.assertTrue(failures({}, "pull_request", "refs/pull/1/merge"))

    def test_default_branch_push_requires_all_jobs(self):
        for ref in ["refs/heads/master", "refs/heads/main"]:
            needs = results()
            self.assertTrue(failures(needs, "push", ref))
            for job in JOB_FILTERS:
                needs[job]["result"] = "success"
            self.assertEqual(failures(needs, "push", ref), [])

    def test_any_executed_job_failure_fails_even_when_unrelated(self):
        for job in JOB_FILTERS:
            with self.subTest(job=job):
                needs = results()
                needs[job]["result"] = "failure"
                self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))

    def test_each_required_job_cannot_be_skipped(self):
        for job in JOB_FILTERS:
            with self.subTest(job=job):
                needs = results(backend="true", frontend="true", agent="true", spreadsheet="true")
                needs[job]["result"] = "skipped"
                self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))

    def test_unknown_job_result_fails_even_for_unrelated_job(self):
        needs = results()
        needs["docker-agent"]["result"] = "unexpected"
        self.assertTrue(failures(needs, "pull_request", "refs/pull/1/merge"))

    def test_unknown_event_fails_closed(self):
        self.assertTrue(failures(results(), "workflow_dispatch", "refs/heads/master"))

    def test_cli_blocks_an_intentionally_failed_required_build_and_allows_legitimate_skip(self):
        gate = Path(__file__).with_name("ci_gate.py")
        for needs, expected in [(results(backend="true"), 0), (results(agent="true"), 1)]:
            if expected:
                needs["docker-agent"]["result"] = "failure"
            with self.subTest(expected=expected):
                result = subprocess.run([sys.executable, str(gate)], env={
                    **os.environ, "CI_NEEDS": json.dumps(needs),
                    "GITHUB_EVENT_NAME": "pull_request", "GITHUB_REF": "refs/pull/1/merge",
                }, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_cli_rejects_missing_invalid_or_nonobject_results(self):
        gate = Path(__file__).with_name("ci_gate.py")
        for payload in ["", "not json", "[]", "null", '{"changes":null}']:
            with self.subTest(payload=payload):
                result = subprocess.run([sys.executable, str(gate)], env={
                    **os.environ, "CI_NEEDS": payload, "GITHUB_EVENT_NAME": "pull_request",
                }, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
