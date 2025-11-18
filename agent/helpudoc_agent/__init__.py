"""
LangChain DeepAgents service package.
"""
from __future__ import annotations

from importlib.metadata import version, PackageNotFoundError

try:
  __version__ = version("helpudoc-agent")
except PackageNotFoundError:  # pragma: no cover
  __version__ = "0.1.0"

__all__ = ["__version__"]
