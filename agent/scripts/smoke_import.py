"""Minimal runtime import smoke check for the agent container."""
from __future__ import annotations

import importlib.metadata as metadata
import io
import sys
from pathlib import Path


AGENT_ROOT = Path(__file__).resolve().parents[1]
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))


def _version(name: str) -> str:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return "missing"


def main() -> None:
    # LangGraph runtime symbols can shift between minor versions.
    # Import the module itself as the stable smoke target.
    import langgraph.runtime as _langgraph_runtime  # noqa: F401
    from langchain.agents import create_agent  # noqa: F401
    import deepagents  # noqa: F401
    from deepagents.backends import FilesystemBackend  # noqa: F401
    from helpudoc_agent.api.app import create_app  # noqa: F401
    # Verify the reporting wheels that previously fell back to an incompatible
    # matplotlib source build, including their native NumPy integration.
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import pyplot
    figure, axes = pyplot.subplots()
    try:
        axes.plot([0, 1], [0, 1])
        image = io.BytesIO()
        figure.savefig(image, format="png")
        assert image.getvalue().startswith(b"\x89PNG\r\n\x1a\n")
    finally:
        pyplot.close(figure)

    versions = {
        "deepagents": _version("deepagents"),
        "langchain": _version("langchain"),
        "langchain-core": _version("langchain-core"),
        "langgraph": _version("langgraph"),
        "langchain-google-genai": _version("langchain-google-genai"),
        "google-genai": _version("google-genai"),
        "langchain-google-vertexai": _version("langchain-google-vertexai"),
        "matplotlib": _version("matplotlib"),
        "numpy": _version("numpy"),
    }
    print("AGENT_IMPORT_SMOKE_OK", versions)


if __name__ == "__main__":
    main()
