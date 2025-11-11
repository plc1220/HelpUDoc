import os
from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model
from deepagents.backends import FilesystemBackend
from core.config import MODEL_NAME

AGENT_CACHE = {}


def create_workspace_agent(workspace: str):
    """Create or reuse a DeepAgent instance for a workspace."""
    if workspace in AGENT_CACHE:
        return AGENT_CACHE[workspace]

    # Load system prompt
    prompt_path = os.path.join(os.path.dirname(__file__), "prompts/default_system_prompt.md")
    with open(prompt_path, encoding="utf-8") as f:
        system_prompt = f.read()

    # Initialize chat model
    model = init_chat_model(model=MODEL_NAME)

    # Create DeepAgent
    agent = create_deep_agent(
        model=model,
        backend=FilesystemBackend(root_dir='/Users/cmtest/Documents/HelpUDoc/backend/workspaces/test/'),
        system_prompt=system_prompt
    )

    AGENT_CACHE[workspace] = agent
    return agent
