"""
Generate Stage - Image generation
"""
import logging
import os
from pathlib import Path
from typing import Dict

from ...utils import load_json
from ..paths import get_summary_checkpoint, get_plan_checkpoint, get_output_dir

logger = logging.getLogger(__name__)


def _resolve_asset_flag(value, env_name: str, default: bool) -> bool:
    if value is None:
        env_value = os.getenv(env_name)
        if env_value is None:
            return default
        return env_value.strip().lower() in {"1", "true", "yes", "y"}
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return bool(value)


async def run_generate_stage(base_dir: Path, config_dir: Path, config: Dict) -> Dict:
    """Stage 4: Generate images."""
    from paper2slides.summary import PaperContent, GeneralContent, TableInfo, FigureInfo, OriginalElements
    from paper2slides.generator import GenerationConfig, GenerationInput
    from paper2slides.generator.config import OutputType, PosterDensity, SlidesLength, StyleType
    from paper2slides.generator.content_planner import ContentPlan, Section, TableRef, FigureRef
    from paper2slides.generator.image_generator import ImageGenerator, save_images_as_pdf
    
    plan_data = load_json(get_plan_checkpoint(config_dir))
    summary_data = load_json(get_summary_checkpoint(base_dir, config))
    if not plan_data or not summary_data:
        raise ValueError("Missing checkpoints.")
    
    content_type = plan_data.get("content_type", "paper")
    
    origin_data = plan_data["origin"]
    origin = OriginalElements(
        tables=[TableInfo(
            table_id=t["id"],
            caption=t.get("caption", ""),
            html_content=t.get("html", ""),
        ) for t in origin_data.get("tables", [])],
        figures=[FigureInfo(
            figure_id=f["id"],
            caption=f.get("caption"),
            image_path=f.get("path", ""),
        ) for f in origin_data.get("figures", [])],
        base_path=origin_data.get("base_path", ""),
    )
    
    plan_dict = plan_data["plan"]
    tables_index = {t.table_id: t for t in origin.tables}
    figures_index = {f.figure_id: f for f in origin.figures}
    
    sections = []
    for s in plan_dict.get("sections", []):
        sections.append(Section(
            id=s.get("id", ""),
            title=s.get("title", ""),
            section_type=s.get("type", "content"),
            content=s.get("content", ""),
            tables=[TableRef(**t) for t in s.get("tables", [])],
            figures=[FigureRef(**f) for f in s.get("figures", [])],
        ))
    
    plan = ContentPlan(
        output_type=plan_dict.get("output_type", "slides"),
        sections=sections,
        tables_index=tables_index,
        figures_index=figures_index,
        metadata=plan_dict.get("metadata", {}),
    )
    
    if content_type == "paper":
        content = PaperContent(**summary_data["content"])
    else:
        content = GeneralContent(**summary_data["content"])
    
    gen_config = GenerationConfig(
        output_type=OutputType(config.get("output_type", "slides")),
        poster_density=PosterDensity(config.get("poster_density", "medium")),
        slides_length=SlidesLength(config.get("slides_length", "medium")),
        style=StyleType(config.get("style", "academic")),
        custom_style=config.get("custom_style"),
    )
    gen_input = GenerationInput(config=gen_config, content=content, origin=origin)
    
    logger.info("Generating images...")
    
    # Prepare output directory
    output_subdir = get_output_dir(config_dir)
    output_subdir.mkdir(parents=True, exist_ok=True)
    ext_map = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
    
    # Save callback: save each image immediately after generation
    def save_image_callback(img, index, total):
        ext = ext_map.get(img.mime_type, ".png")
        filepath = output_subdir / f"{img.section_id}{ext}"
        with open(filepath, "wb") as f:
            f.write(img.image_data)
        logger.info(f"  [{index+1}/{total}] Saved: {filepath.name}")
    
    generator = ImageGenerator()
    max_workers = config.get("max_workers", 1)
    images = generator.generate(plan, gen_input, max_workers=max_workers, save_callback=save_image_callback)
    logger.info(f"  Generated {len(images)} images")

    image_paths = []
    for img in images:
        ext = ext_map.get(img.mime_type, ".png")
        image_path = output_subdir / f"{img.section_id}{ext}"
        if image_path.exists():
            image_paths.append(str(image_path))
        else:
            logger.warning("Expected image missing: %s", image_path)
    
    # Generate PDF for slides
    output_type = config.get("output_type", "slides")
    if output_type == "slides" and len(images) > 1:
        pdf_path = output_subdir / "slides.pdf"
        save_images_as_pdf(images, str(pdf_path))
        logger.info(f"  Saved: slides.pdf")

    if output_type == "slides" and image_paths:
        from paper2slides.utils.export_service import ExportService

        pptx_path = output_subdir / "slides.pptx"
        try:
            ExportService.create_pptx_from_images(image_paths, str(pptx_path))
            logger.info("  Saved: slides.pptx")
        except Exception as exc:
            logger.warning("Failed to export PPTX: %s", exc)

        mineru_dir = ExportService.find_mineru_result_dir(str(base_dir / "rag_output"))
        if mineru_dir:
            editable_path = output_subdir / "slides_editable.pptx"
            try:
                ExportService.create_editable_pptx_from_mineru(
                    mineru_dir,
                    output_file=str(editable_path),
                    slide_width_pixels=1920,
                    slide_height_pixels=1080,
                )
                logger.info("  Saved: slides_editable.pptx")
            except Exception as exc:
                logger.warning("Failed to export editable PPTX: %s", exc)

        if config.get("extract_assets"):
            from paper2slides.utils.slide_assets import SlideAssetConfig, SlideAssetExtractor

            api_key = (
                config.get("image_api_key")
                or os.getenv("IMAGE_GEN_API_KEY")
                or os.getenv("GEMINI_API_KEY")
                or os.getenv("GOOGLE_API_KEY")
            )
            layout_model = config.get("layout_model") or os.getenv("LAYOUT_MODEL")
            image_model = config.get("image_model") or os.getenv("IMAGE_GEN_MODEL")
            max_retries = config.get("layout_max_retries", 1)
            max_tokens = config.get("layout_max_tokens") or os.getenv("LAYOUT_MAX_TOKENS")
            refine_assets = _resolve_asset_flag(config.get("refine_assets"), "REFINE_ASSETS", True)
            clean_assets = _resolve_asset_flag(config.get("clean_assets"), "CLEAN_ASSETS", True)
            refine_text_layout = _resolve_asset_flag(
                config.get("refine_text_layout"), "REFINE_TEXT_LAYOUT", True
            )
            refine_max_tokens = config.get("refine_max_tokens") or os.getenv("REFINE_MAX_TOKENS")
            refine_text_max_tokens = config.get("refine_text_max_tokens") or os.getenv(
                "REFINE_TEXT_MAX_TOKENS"
            )
            clean_max_retries = config.get("clean_max_retries") or os.getenv("CLEAN_MAX_RETRIES")
            clean_image_model = config.get("clean_image_model") or os.getenv("CLEAN_IMAGE_MODEL")
            clean_bg_tolerance = config.get("clean_bg_tolerance") or os.getenv(
                "CLEAN_BG_TOLERANCE"
            )

            try:
                if max_tokens is not None:
                    try:
                        max_tokens = int(max_tokens)
                    except (TypeError, ValueError):
                        max_tokens = None
                if refine_max_tokens is not None:
                    try:
                        refine_max_tokens = int(refine_max_tokens)
                    except (TypeError, ValueError):
                        refine_max_tokens = None
                if refine_text_max_tokens is not None:
                    try:
                        refine_text_max_tokens = int(refine_text_max_tokens)
                    except (TypeError, ValueError):
                        refine_text_max_tokens = None
                if clean_max_retries is not None:
                    try:
                        clean_max_retries = int(clean_max_retries)
                    except (TypeError, ValueError):
                        clean_max_retries = None
                if clean_bg_tolerance is not None:
                    try:
                        clean_bg_tolerance = int(clean_bg_tolerance)
                    except (TypeError, ValueError):
                        clean_bg_tolerance = None
                asset_config = SlideAssetConfig(
                    layout_model=layout_model or SlideAssetConfig().layout_model,
                    image_model=image_model or SlideAssetConfig().image_model,
                    max_retries=max_retries,
                    max_output_tokens=(
                        max_tokens if max_tokens else SlideAssetConfig().max_output_tokens
                    ),
                    refine_assets=refine_assets,
                    clean_assets=clean_assets,
                    refine_text_layout=refine_text_layout,
                    refine_text_max_tokens=(
                        refine_text_max_tokens
                        if refine_text_max_tokens
                        else SlideAssetConfig().refine_text_max_tokens
                    ),
                    refine_max_tokens=(
                        refine_max_tokens
                        if refine_max_tokens
                        else SlideAssetConfig().refine_max_tokens
                    ),
                    clean_max_retries=(
                        clean_max_retries
                        if clean_max_retries
                        else SlideAssetConfig().clean_max_retries
                    ),
                    clean_image_model=clean_image_model,
                    clean_bg_tolerance=(
                        clean_bg_tolerance
                        if clean_bg_tolerance is not None
                        else SlideAssetConfig().clean_bg_tolerance
                    ),
                )
                extractor = SlideAssetExtractor(api_key=api_key, config=asset_config)
                slide_dirs = extractor.extract_from_images(image_paths, output_subdir)
                assets_pptx = output_subdir / "slides_editable_assets.pptx"
                ExportService.create_editable_pptx_from_slide_assets(
                    [str(path) for path in slide_dirs],
                    str(assets_pptx),
                )
                logger.info("  Saved: slides_editable_assets.pptx")
            except Exception as exc:
                logger.warning("Failed to export asset-based PPTX: %s", exc)
    
    logger.info("")
    logger.info(f"Output: {output_subdir}")
    
    return {"output_dir": str(output_subdir), "num_images": len(images)}
