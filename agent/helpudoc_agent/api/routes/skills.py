"""Skill policy contract route."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from helpudoc_agent.configuration import Settings
from helpudoc_agent.skills_registry import find_skill


def register_skills_routes(app: FastAPI, *, settings: Settings) -> None:
    @app.get("/skills/{skill_id:path}/contract")
    async def skill_contract(skill_id: str):
        skills_root = settings.backend.skills_root
        skill = find_skill(skills_root, skill_id)
        if skill is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
        policy = skill.policy
        return JSONResponse(
            {
                "skillId": skill.skill_id,
                "name": skill.name,
                "description": skill.description,
                "tools": list(skill.tools),
                "mcpServers": list(skill.mcp_servers),
                "requiresHitlPlan": bool(policy.requires_hitl_plan),
                "requiresWorkspaceArtifacts": bool(policy.requires_workspace_artifacts),
                "requiredArtifactsMode": policy.required_artifacts_mode,
                "prePlanSearchLimit": int(policy.pre_plan_search_limit or 0),
                "sourcePath": str(skill.path),
            }
        )
