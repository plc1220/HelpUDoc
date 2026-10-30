"""propose_skill: offer a skill as a card the user saves as a private draft.

On 2026-10-12 a user asked the agent to convert a Word document into skills, and the
agent wrote ten folders straight into the shared catalog. /skills/ is read-only now,
so a skill reaches the platform only as a governed draft, which records its creator and
owning team and goes through review.

This tool writes nothing. It checks one skill against the draft rules the backend
enforces (backend/src/services/governance/skillGovernanceModel.ts and
backend/src/services/skills/paths.ts), then returns the proposal as its output. The
backend collects that output from the tool_end event into the message's
skillProposals, and the workspace shows it as a card. The user saves the card through
the governance draft API under their own session, so the draft is theirs.

The tool output is not shortened in the stream (tool inputs are, to 200 characters),
which is why the full proposal travels in the output.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import PurePosixPath
from typing import Any, List

from langchain_core.tools import Tool, tool
from pydantic import BaseModel, Field

from ....skills_registry import _parse_frontmatter
from ....state import WorkspaceState

PROPOSAL_TYPE = "helpudoc.skill_proposal/1"

# Mirrors SKILL_KEY_PATTERN and its 128-character limit in skillGovernanceModel.ts.
_SKILL_KEY = re.compile(r"^[a-z0-9_-]+(?:/[a-z0-9_-]+)*$")
# Mirrors IMPORT_ALLOWED_PREFIXES and IMPORT_BLOCKED_EXTENSIONS in skills/paths.ts.
_ALLOWED_PREFIXES = (
    "SKILL.md", "LICENSE", "LICENSE.txt", "README.md", "QUICKREF.md", "STYLE_PRESETS.md",
    "animation-patterns.md", "html-template.md", "interaction_contract.yaml",
    "interaction_contract.yml", "manifest.txt", "render_docx.py", "viewport-base.css",
    "agents/", "artifact_tool/", "scripts/", "references/", "assets/", "templates/", "docs/",
    "examples/", "bold-template-pack/", "builtin_templates_support/", "container_tools/",
    "ooxml/", "tasks/", "template_following_scripts/", "troubleshooting/",
)
_BLOCKED_EXTENSIONS = frozenset({".exe", ".dll", ".so", ".dylib", ".bat", ".cmd", ".com"})

# Far below the backend's package limits (500 files, 50 MB): a proposal is shown in
# chat and saved in one request, and it goes back into the model's context.
MAX_FILES = 40
MAX_FILE_CHARS = 200_000
MAX_TOTAL_CHARS = 1_000_000


def workspace_skill_proposals_enabled() -> bool:
    """On unless ENABLE_WORKSPACE_SKILL_PROPOSALS is set to false."""
    return str(os.environ.get("ENABLE_WORKSPACE_SKILL_PROPOSALS", "true")).strip().lower() != "false"


class ProposedSkillFile(BaseModel):
    path: str = Field(description="Path inside the skill folder, e.g. SKILL.md or references/checklist.md")
    content: str = Field(description="Full UTF-8 text content of the file")


class ProposeSkillInput(BaseModel):
    skill_id: str = Field(description="Lowercase kebab-case skill ID, e.g. contract-fairness")
    name: str = Field(description="Display name of the skill")
    description: str = Field(description="When and how to use the skill, in one or two sentences")
    files: List[ProposedSkillFile] = Field(
        description="Every file of the skill, SKILL.md first. SKILL.md starts with YAML frontmatter holding name and description.",
    )


def _path_error(raw: str) -> str | None:
    path = str(raw or "").strip().replace("\\", "/")
    if not path or path.startswith("/") or path.startswith("."):
        return f"'{raw}' must be a relative path inside the skill folder"
    if path.startswith("skills/"):
        return f"'{raw}' must not start with skills/; paths are relative to the skill folder"
    parts = path.split("/")
    if any(part in {"", ".", ".."} for part in parts) or "\0" in path:
        return f"'{raw}' must not contain empty, '.' or '..' segments"
    if not any(path == prefix or path.startswith(prefix) for prefix in _ALLOWED_PREFIXES if prefix.endswith("/")) and path not in _ALLOWED_PREFIXES:
        return (
            f"'{raw}' is outside the allowed skill layout; put supporting files under "
            "references/, scripts/, assets/, templates/, docs/ or examples/"
        )
    if PurePosixPath(path).suffix.lower() in _BLOCKED_EXTENSIONS:
        return f"'{raw}' is an executable binary type, which skills may not contain"
    return None


def validate_proposal(payload: ProposeSkillInput) -> tuple[dict[str, Any] | None, list[str]]:
    """Return (normalised proposal, errors). Errors are written for the model to fix."""
    errors: list[str] = []
    skill_id = str(payload.skill_id or "").strip().lower().strip("/")
    if not skill_id or len(skill_id) > 128 or not _SKILL_KEY.match(skill_id):
        errors.append("skill_id must be lowercase letters, digits, '-' or '_' (e.g. contract-fairness), at most 128 characters")
    name = str(payload.name or "").strip()
    description = str(payload.description or "").strip()
    if not name:
        errors.append("name is required")
    if not description:
        errors.append("description is required")

    files: list[dict[str, str]] = []
    seen: set[str] = set()
    total = 0
    for item in payload.files or []:
        path = str(item.path or "").strip().replace("\\", "/")
        error = _path_error(path)
        if error:
            errors.append(error)
            continue
        if path in seen:
            errors.append(f"'{path}' appears more than once")
            continue
        seen.add(path)
        content = str(item.content or "")
        if len(content) > MAX_FILE_CHARS:
            errors.append(f"'{path}' is longer than {MAX_FILE_CHARS} characters; split it into references/ files")
        total += len(content)
        files.append({"path": path, "content": content})
    if len(files) > MAX_FILES:
        errors.append(f"a proposal may hold at most {MAX_FILES} files")
    if total > MAX_TOTAL_CHARS:
        errors.append(f"the files total more than {MAX_TOTAL_CHARS} characters; propose a smaller skill")

    skill_md = next((file for file in files if file["path"] == "SKILL.md"), None)
    if skill_md is None:
        errors.append("files must include SKILL.md")
    else:
        # No leading whitespace: the backend validator, like _parse_frontmatter, needs "---" first.
        frontmatter = _parse_frontmatter(skill_md["content"])
        if not str(frontmatter.get("name") or "").strip():
            errors.append("SKILL.md must start with YAML frontmatter that has a name")
        if not str(frontmatter.get("description") or "").strip():
            errors.append("SKILL.md frontmatter must have a description")
        tools = frontmatter.get("tools")
        if isinstance(tools, list) and not tools:
            errors.append("omit tools from the SKILL.md frontmatter instead of writing an empty list (empty means unrestricted)")
        files.sort(key=lambda file: (file["path"] != "SKILL.md", file["path"]))

    if errors:
        return None, errors
    # The same action batch the Skill Creator emits, so the card can hand it to
    # POST /skills/drafts/:id/builder-actions unchanged.
    actions: list[dict[str, Any]] = [
        {"type": "create_skill", "skillId": skill_id, "name": name, "description": description},
        *({"type": "upsert_text", "skillId": skill_id, "path": file["path"], "content": file["content"]} for file in files),
    ]
    return {
        "type": PROPOSAL_TYPE,
        "proposalId": str(uuid.uuid4()),
        "skillId": skill_id,
        "name": name,
        "description": description,
        "files": files,
        "actions": actions,
    }, []


def build_propose_skill_tool(workspace_state: WorkspaceState) -> Tool:
    @tool(args_schema=ProposeSkillInput)
    def propose_skill(skill_id: str, name: str, description: str, files: List[Any]) -> str:
        """Propose one skill for the user to save as a private draft."""
        payload = ProposeSkillInput(
            skill_id=skill_id,
            name=name,
            description=description,
            files=[item if isinstance(item, ProposedSkillFile) else ProposedSkillFile.model_validate(item) for item in files],
        )
        proposal, errors = validate_proposal(payload)
        if errors:
            return "Skill proposal rejected. Fix these and call propose_skill again:\n- " + "\n- ".join(errors)
        proposals = workspace_state.context.setdefault("skill_proposals_this_turn", [])
        if isinstance(proposals, list):
            proposals.append(proposal["skillId"])
        proposal["note"] = (
            "Shown to the user as a card. They save it as a private draft, test it in their "
            "private workspace and submit it for review. Do not write skill files yourself."
        )
        return json.dumps(proposal, ensure_ascii=False)

    propose_skill.name = "propose_skill"
    propose_skill.description = (
        "Propose ONE skill as a card the user can save as a private draft. Call it once per skill "
        "when the user asks to create, convert or package skills, for example from an attached "
        "document. Include every file, SKILL.md first with frontmatter name and description. "
        "Never write skill files with write_file; /skills/ is read-only."
    )
    return propose_skill
