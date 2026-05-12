"""Legacy shim for the Paper2Slides PDF-to-PPTX exporter."""

from presentation_pipeline.export_pptx import main

__all__ = ["main"]


if __name__ == "__main__":
    main()

