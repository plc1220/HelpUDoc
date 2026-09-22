"""Declared skill scripts may be JavaScript, not only Python.

The registry never filtered on extension, so a declared `.js` script was
accepted and then handed to the Python interpreter, which failed with a
SyntaxError naming neither the language nor the cause. The interpreter is now
derived from the file suffix in one place, `resolve_script_language`.
"""
from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

import pytest

from agent.helpudoc_agent.sandbox_runner import (
    CONTAINER_INTERPRETER_BY_LANGUAGE,
    SandboxConfig,
    SandboxExecutionError,
    build_sandbox_job_manifest,
    resolve_script_language,
    run_skill_python_script_locally,
)
from agent.helpudoc_agent.skills_registry import (
    SkillSandboxScript,
    activate_skill_context,
    load_skills,
)
from agent.helpudoc_agent.state import WorkspaceState


def _write_js_skill(tmp_path: Path, *, script_body: str, script_path: str = "scripts/run.js") -> Path:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "demo"
    script_file = skill_dir / script_path
    script_file.parent.mkdir(parents=True, exist_ok=True)
    script_file.write_text(script_body, encoding="utf-8")
    digest = hashlib.sha256(script_file.read_bytes()).hexdigest()
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: Demo
tools:
  - run_skill_python_script
sandbox_scripts:
  - name: run
    path: {script_path}
    sha256: "{digest}"
    timeout_seconds: 10
---

# Demo
""",
        encoding="utf-8",
    )
    return skills_root


def _sandbox_config() -> SandboxConfig:
    return SandboxConfig(
        namespace="helpudoc",
        image="helpudoc-agent:latest",
        workspace_pvc="workspace-pvc",
        runtime_class_name="gvisor",
        cpu_limit="500m",
        memory_limit="512Mi",
        ephemeral_storage_limit="1Gi",
        poll_interval_seconds=0.25,
    )


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("scripts/run.py", "python"),
        ("scripts/run.js", "javascript"),
        ("scripts/run.mjs", "javascript"),
        ("scripts/run.cjs", "javascript"),
        ("scripts/RUN.JS", "javascript"),
    ],
)
def test_language_follows_the_file_suffix(path: str, expected: str) -> None:
    assert resolve_script_language(path) == expected


@pytest.mark.parametrize("path", ["scripts/run.txt", "scripts/run.sh", "scripts/run"])
def test_an_unknown_suffix_is_refused_rather_than_guessed(path: str) -> None:
    # Defaulting to Python is what produced the baffling SyntaxError, and
    # running an unknown extension as code would be worse than refusing it.
    with pytest.raises(SandboxExecutionError) as excinfo:
        resolve_script_language(path)
    assert "not a supported sandbox script type" in str(excinfo.value)


def test_manifest_runs_a_js_script_with_node() -> None:
    manifest = build_sandbox_job_manifest(
        job_name="job",
        workspace_id="ws",
        run_id="run",
        staged_script_name="run.js",
        args=["--name", "Ada"],
        script=SkillSandboxScript(name="run", path="scripts/run.js", sha256="abc", timeout_seconds=10),
        sandbox_config=_sandbox_config(),
    )
    container = manifest["spec"]["template"]["spec"]["containers"][0]
    assert container["command"] == ["node", "/sandbox/scripts/run.js"]
    # Arguments stay argv, never a shell string, exactly as for Python.
    assert container["args"] == ["--name", "Ada"]


def test_manifest_still_runs_a_py_script_with_python() -> None:
    # The control. A change that sent everything to Node would pass the test
    # above and break every existing skill.
    manifest = build_sandbox_job_manifest(
        job_name="job",
        workspace_id="ws",
        run_id="run",
        staged_script_name="run.py",
        args=[],
        script=SkillSandboxScript(name="run", path="scripts/run.py", sha256="abc", timeout_seconds=10),
        sandbox_config=_sandbox_config(),
    )
    container = manifest["spec"]["template"]["spec"]["containers"][0]
    assert container["command"] == ["python", "/sandbox/scripts/run.py"]


def test_container_interpreters_cover_every_language() -> None:
    # A new suffix must not reach Kubernetes as a KeyError at submit time.
    languages = set(
        resolve_script_language(f"x{suffix}")
        for suffix in (".py", ".js", ".mjs", ".cjs")
    )
    assert languages <= set(CONTAINER_INTERPRETER_BY_LANGUAGE)


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed on this host")
def test_a_declared_js_script_actually_runs(tmp_path: Path) -> None:
    skills_root = _write_js_skill(
        tmp_path,
        script_body=(
            "const args = process.argv.slice(2);\n"
            "console.log('hello from node ' + args.join(' '));\n"
        ),
    )
    workspace = WorkspaceState(workspace_id="ws-js", root_path=tmp_path / "workspace")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    skills = {skill.skill_id: skill for skill in load_skills(skills_root)}
    activate_skill_context(workspace.context, skills["demo"])

    result = run_skill_python_script_locally(
        skills_root=skills_root,
        workspace_state=workspace,
        script_name="run",
        args=["Ada", "Lovelace"],
    )
    assert "hello from node Ada Lovelace" in result.stdout
    # The old failure mode was the Python interpreter choking on JS source.
    # Asserting the absence of that beats asserting an empty stderr, which
    # picks up unrelated gRPC fd chatter when the whole suite runs.
    assert "SyntaxError" not in result.stderr


def test_manifest_sets_node_path_beside_pythonpath() -> None:
    # The local runner sets NODE_PATH; if the manifest did not, a JS script
    # that requires a staged sibling would work on a dev box and fail in the
    # cluster. That asymmetry is the class of bug this change removes.
    manifest = build_sandbox_job_manifest(
        job_name="job",
        workspace_id="ws",
        run_id="run",
        staged_script_name="run.js",
        args=[],
        script=SkillSandboxScript(name="run", path="scripts/run.js", sha256="abc", timeout_seconds=10),
        sandbox_config=_sandbox_config(),
    )
    env = {item["name"]: item["value"] for item in manifest["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["NODE_PATH"] == "/sandbox/scripts:/sandbox"
    assert env["PYTHONPATH"] == "/sandbox/scripts:/sandbox"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed on this host")
def test_a_js_script_can_require_a_staged_sibling(tmp_path: Path) -> None:
    # Proves NODE_PATH is actually honoured, not merely present in the env.
    skills_root = _write_js_skill(
        tmp_path,
        script_body=(
            "const helper = require('helper.js');\n"
            "console.log('sum=' + helper.add(2, 3));\n"
        ),
    )
    (skills_root / "demo" / "scripts" / "helper.js").write_text(
        "module.exports = { add: (a, b) => a + b };\n", encoding="utf-8"
    )
    workspace = WorkspaceState(workspace_id="ws-js-req", root_path=tmp_path / "workspace")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    skills = {skill.skill_id: skill for skill in load_skills(skills_root)}
    activate_skill_context(workspace.context, skills["demo"])

    result = run_skill_python_script_locally(
        skills_root=skills_root,
        workspace_state=workspace,
        script_name="run",
    )
    assert "sum=5" in result.stdout


def test_a_tampered_js_script_is_refused(tmp_path: Path) -> None:
    # The integrity check is content-based, so it should not care about the
    # language — but "should" is how a gate quietly stops covering a new case.
    skills_root = _write_js_skill(tmp_path, script_body="console.log('original');\n")
    script = skills_root / "demo" / "scripts" / "run.js"
    script.write_text("console.log('tampered');\n", encoding="utf-8")

    workspace = WorkspaceState(workspace_id="ws-js-tamper", root_path=tmp_path / "workspace")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    skills = {skill.skill_id: skill for skill in load_skills(skills_root)}
    activate_skill_context(workspace.context, skills["demo"])

    with pytest.raises(SandboxExecutionError, match="hash mismatch"):
        run_skill_python_script_locally(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
        )
