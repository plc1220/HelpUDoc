"""
CLI helper to export PPTX from a PDF file.
"""
import argparse
import logging
from pathlib import Path

from paper2slides.utils import setup_logging
from paper2slides.utils.export_service import ExportService

logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export PPTX from a PDF file")
    parser.add_argument("--input", "-i", required=True, help="Input PDF path")
    parser.add_argument("--output", "-o", help="Output PPTX path (defaults to input name)")
    parser.add_argument("--width", type=int, default=1920, help="Slide width in pixels")
    parser.add_argument("--height", type=int, default=1080, help="Slide height in pixels")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    setup_logging(level=logging.DEBUG if args.debug else logging.INFO)

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input PDF not found: {input_path}")

    output_path = Path(args.output).expanduser().resolve() if args.output else input_path.with_suffix(".pptx")

    logger.info("Exporting PPTX from %s", input_path)
    ExportService.create_pptx_from_pdf(
        str(input_path),
        output_file=str(output_path),
        slide_width_px=args.width,
        slide_height_px=args.height,
    )
    if not output_path.exists():
        raise RuntimeError("PPTX export did not produce an output file")
    logger.info("Saved: %s", output_path)


if __name__ == "__main__":
    main()

