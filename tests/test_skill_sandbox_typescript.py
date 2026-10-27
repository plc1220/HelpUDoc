"""Declared skill scripts may be TypeScript.

Node 22.18+ strips type annotations itself, so a `.ts` script runs on the same
node binary as JavaScript, with no tsx or compile step. Syntax that needs
compiling (enum, namespace, parameter properties) is refused by Node; the
runner adds a plain explanation of what to write instead.
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path

import pytest

from agent.helpudoc_agent import sandbox_runner
from agent.helpudoc_agent.sandbox_runner import (
    CONTAINER_INTERPRETER_BY_LANGUAGE,
    SCRIPT_LANGUAGE_BY_SUFFIX,
    TYPESCRIPT_SYNTAX_HINT,
    SandboxConfig,
    SandboxExecutionError,
    build_sandbox_job_manifest,
    resolve_script_language,
    run_skill_python_script_locally,
    with_typescript_syntax_hint,
)
from agent.helpudoc_agent.skills_registry import (
    SkillSandboxScript,
    activate_skill_context,
    load_skills,
)
from agent.helpudoc_agent.state import WorkspaceState


def _node_strips_types() -> bool:
    node = shutil.which("node")
    if not node:
        return False
    version = sandbox_runner._node_version(node)
    return version is not None and version >= sandbox_runner.MIN_NODE_FOR_TYPESCRIPT


needs_typescript_node = pytest.mark.skipif(
    not _node_strips_types(), reason="Node.js 22.18+ is not installed on this host"
)


def _write_ts_skill(tmp_path: Path, *, script_body: str, script_path: str = "scripts/run.ts") -> Path:
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


def _activate(tmp_path: Path, skills_root: Path, workspace_id: str) -> WorkspaceState:
    workspace = WorkspaceState(workspace_id=workspace_id, root_path=tmp_path / "workspace")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    skills = {skill.skill_id: skill for skill in load_skills(skills_root)}
    activate_skill_context(workspace.context, skills["demo"])
    return workspace


@pytest.mark.parametrize("path", ["scripts/run.ts", "scripts/run.mts", "scripts/run.cts", "scripts/RUN.TS"])
def test_typescript_suffixes_resolve_to_typescript(path: str) -> None:
    assert resolve_script_language(path) == "typescript"


def test_python_and_javascript_are_unchanged() -> None:
    # The control: a mapping change that moved these would break every skill.
    assert resolve_script_language("scripts/run.py") == "python"
    assert resolve_script_language("scripts/run.js") == "javascript"


def test_every_suffix_has_a_container_interpreter() -> None:
    # Checked from the table itself, so the next suffix added is covered too.
    for suffix in SCRIPT_LANGUAGE_BY_SUFFIX:
        assert resolve_script_language(f"x{suffix}") in CONTAINER_INTERPRETER_BY_LANGUAGE


def test_manifest_runs_a_ts_script_with_node() -> None:
    manifest = build_sandbox_job_manifest(
        job_name="job",
        workspace_id="ws",
        run_id="run",
        staged_script_name="run.ts",
        args=["--name", "Ada"],
        script=SkillSandboxScript(name="run", path="scripts/run.ts", sha256="abc", timeout_seconds=10),
        sandbox_config=SandboxConfig(
            namespace="helpudoc",
            image="helpudoc-agent:latest",
            workspace_pvc="workspace-pvc",
            runtime_class_name="gvisor",
            cpu_limit="500m",
            memory_limit="512Mi",
            ephemeral_storage_limit="1Gi",
            poll_interval_seconds=0.25,
        ),
    )
    container = manifest["spec"]["template"]["spec"]["containers"][0]
    assert container["command"] == ["node", "/sandbox/scripts/run.ts"]
    assert container["args"] == ["--name", "Ada"]


@needs_typescript_node
def test_a_declared_ts_script_runs_and_imports_a_sibling(tmp_path: Path) -> None:
    skills_root = _write_ts_skill(
        tmp_path,
        script_body=(
            "import { greet } from './helper.ts';\n"
            "type Args = readonly string[];\n"
            "const args: Args = process.argv.slice(2);\n"
            "console.log(greet(args.join(' ')));\n"
        ),
    )
    (skills_root / "demo" / "scripts" / "helper.ts").write_text(
        "export function greet(name: string): string { return `hello from ts ${name}`; }\n",
        encoding="utf-8",
    )
    workspace = _activate(tmp_path, skills_root, "ws-ts")

    result = run_skill_python_script_locally(
        skills_root=skills_root,
        workspace_state=workspace,
        script_name="run",
        args=["Ada", "Lovelace"],
    )
    assert "hello from ts Ada Lovelace" in result.stdout


@needs_typescript_node
def test_an_enum_fails_with_a_plain_explanation(tmp_path: Path) -> None:
    skills_root = _write_ts_skill(tmp_path, script_body="enum Color { Red }\nconsole.log(Color.Red);\n")
    workspace = _activate(tmp_path, skills_root, "ws-ts-enum")

    with pytest.raises(SandboxExecutionError) as excinfo:
        run_skill_python_script_locally(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
        )
    message = str(excinfo.value)
    assert "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" in message
    assert TYPESCRIPT_SYNTAX_HINT in message


def test_the_hint_is_added_only_for_typescript_syntax_errors() -> None:
    assert with_typescript_syntax_hint("ReferenceError: x is not defined") == "ReferenceError: x is not defined"
    assert with_typescript_syntax_hint("SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]").endswith(
        TYPESCRIPT_SYNTAX_HINT
    )


def test_an_old_local_node_is_refused_with_its_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sandbox_runner.shutil, "which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(sandbox_runner, "_node_version", lambda node: (18, 20))
    with pytest.raises(SandboxExecutionError, match=r"Node\.js 22\.18 or later.*has 18\.20"):
        sandbox_runner._local_interpreter("typescript")
    # JavaScript still runs on the same old Node.
    assert sandbox_runner._local_interpreter("javascript") == "/usr/bin/node"


def test_node_version_is_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    class Done:
        stdout = "v24.22.1\n"

    monkeypatch.setattr(sandbox_runner.subprocess, "run", lambda *a, **k: Done())
    assert sandbox_runner._node_version("node") == (24, 22)

    def broken(*a, **k):
        raise subprocess.TimeoutExpired("node", 10)

    monkeypatch.setattr(sandbox_runner.subprocess, "run", broken)
    assert sandbox_runner._node_version("node") is None


def test_a_tampered_ts_script_is_refused(tmp_path: Path) -> None:
    skills_root = _write_ts_skill(tmp_path, script_body="console.log('original');\n")
    (skills_root / "demo" / "scripts" / "run.ts").write_text("console.log('tampered');\n", encoding="utf-8")
    workspace = _activate(tmp_path, skills_root, "ws-ts-tamper")

    with pytest.raises(SandboxExecutionError, match="hash mismatch"):
        run_skill_python_script_locally(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
        )
