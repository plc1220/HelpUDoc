from pathlib import Path

from helpudoc_agent.skills_registry import load_skills


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_image_to_pdf_skill_is_discoverable_and_narrowly_scoped() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}

    assert "image-to-pdf" in skills
    assert skills["image-to-pdf"].tools == ["create_pdf_from_images", "request_clarification"]


def test_pdf_skill_can_create_image_based_pdfs() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}

    pdf = skills["pdf"]
    assert "create_pdf_from_images" in pdf.tools
    assert "rag_query" in pdf.tools
