import os
from core.config import WORKSPACES_PATH

def get_workspace_path(name: str) -> str:
    ws_path = os.path.join(WORKSPACES_PATH, name)
    os.makedirs(ws_path, exist_ok=True)
    return ws_path

def validate_workspace(name: str):
    ws_path = get_workspace_path(name)
    if not os.path.exists(ws_path):
        raise FileNotFoundError(f"Workspace {name} not found")
    return ws_path