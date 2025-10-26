import os
from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model
from deepagents.middleware.filesystem import FilesystemMiddleware
from core.workspace import get_workspace_path
from core.config import MODEL_NAME

AGENT_CACHE = {}

def create_workspace_agent(workspace: str):
    """Create or reuse a DeepAgent instance for a workspace"""
    if workspace in AGENT_CACHE:
        return AGENT_CACHE[workspace]

    prompt_path = os.path.join(os.path.dirname(__file__), "prompts/default_system_prompt.md")
    with open(prompt_path) as f:
        system_prompt = f.read()

    model = init_chat_model(model=MODEL_NAME)
    fs = FilesystemMiddleware(
        root_dir=get_workspace_path(workspace),
        system_prompt="Only use tools within this workspace."
    )

    agent = create_deep_agent(
        model=model,
        middleware=[fs],
        system_prompt=system_prompt
    )

    AGENT_CACHE[workspace] = agent
    return agent