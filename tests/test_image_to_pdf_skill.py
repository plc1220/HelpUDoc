from pathlib import Path

from helpudoc_agent.skills_registry import load_skills


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_image_to_pdf_workflow_is_owned_by_pdf_skill() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}

    assert "image-to-pdf" not in skills
    pdf = skills["pdf"]
    assert "create_pdf_from_images" in pdf.tools
    assert "rag_query" in pdf.tools
    assert "stitch" in (pdf.description or "") or "image" in pdf.path.read_text(encoding="utf-8").lower()


def test_pdf_skill_can_create_image_based_pdfs() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}

    pdf = skills["pdf"]
    assert "create_pdf_from_images" in pdf.tools
    assert "rag_query" in pdf.tools
