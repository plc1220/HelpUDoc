"""Fail closed when a required CI job did not complete successfully."""
from __future__ import annotations

import json
import os
import sys


JOB_FILTERS = {
    "backend-test": "backend",
    "calendar-review-tests": "backend",
    "frontend": "frontend",
    "python-agent": "agent",
    "docker-backend": "backend",
    "docker-frontend": "frontend",
    "docker-agent": "agent",
}


def failures(needs: dict, event: str, ref: str) -> list[str]:
    errors: list[str] = []
    if event not in {"pull_request", "push"}:
        errors.append(f"Unsupported CI event: {event!r}")
    changes = needs.get("changes", {})
    if changes.get("result") != "success":
        errors.append("Path detection did not succeed")
    outputs = changes.get("outputs", {})
    for name in {"backend", "frontend", "agent"}:
        if outputs.get(name) not in {"true", "false"}:
            errors.append(f"Missing or invalid path detection output: {name}")

    default_push = event == "push" and ref in {"refs/heads/master", "refs/heads/main"}
    for job, path_filter in JOB_FILTERS.items():
        result = needs.get(job, {}).get("result")
        required = default_push or outputs.get(path_filter) == "true"
        if required and result != "success":
            errors.append(f"Required job {job} ended with {result!r}; expected success")
        elif not required and result not in {"success", "skipped"}:
            errors.append(f"Job {job} ended with {result!r}")
    return errors


def main() -> int:
    try:
        needs = json.loads(os.environ["CI_NEEDS"])
        if not isinstance(needs, dict):
            raise ValueError("CI_NEEDS must be an object")
        errors = failures(needs, os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("GITHUB_REF", ""))
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        errors = [f"Cannot validate CI results: {error}"]
    for error in errors:
        print(f"::error::{error}")
    if not errors:
        print("All required jobs succeeded; only unrelated jobs may be skipped.")
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
