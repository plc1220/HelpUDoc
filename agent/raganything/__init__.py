from pathlib import Path

_vendored_pkg_dir = (
    Path(__file__).resolve().parent.parent / "paper2slides" / "raganything"
)
if _vendored_pkg_dir.exists():
    __path__.append(str(_vendored_pkg_dir))

from .config import RAGAnythingConfig as RAGAnythingConfig
from .raganything import RAGAnything as RAGAnything

__all__ = ["RAGAnything", "RAGAnythingConfig"]
