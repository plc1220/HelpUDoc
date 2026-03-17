from pathlib import Path
import sys


CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

AGENT_DIR = CURRENT_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from helpudoc_agent.configuration import Settings  # noqa: E402
from helpudoc_agent.mcp_manager import describe_mcp_servers  # noqa: E402


def _build_settings(payload):
    try:
        return Settings.model_validate(payload)
    except AttributeError:
        return Settings.parse_obj(payload)


def test_mcp_server_config_accepts_delegated_auth_provider_camelcase():
    settings = _build_settings(
        {
            "model": {},
            "backend": {"workspace_root": "backend/workspaces"},
            "tools": {},
            "mcp_servers": {
                "google-workspace": {
                    "name": "google-workspace",
                    "transport": "http",
                    "url": "https://workspace.example.com/mcp",
                    "delegatedAuthProvider": "google",
                    "defaultAccess": "allow",
                }
            },
        }
    )

    server = settings.mcp_servers["google-workspace"]
    assert server.delegated_auth_provider == "google"
    assert server.default_access == "allow"


def test_describe_mcp_servers_includes_delegated_auth_provider():
    settings = _build_settings(
        {
            "model": {},
            "backend": {"workspace_root": "backend/workspaces"},
            "tools": {},
            "mcp_servers": {
                "google-workspace": {
                    "name": "google-workspace",
                    "transport": "http",
                    "url": "https://workspace.example.com/mcp",
                    "delegated_auth_provider": "google",
                }
            },
        }
    )

    described = describe_mcp_servers(settings)

    assert described == [
        {
            "name": "google-workspace",
            "transport": "http",
            "endpoint": "https://workspace.example.com/mcp",
            "description": None,
            "delegated_auth_provider": "google",
            "default_access": "allow",
        }
    ]
