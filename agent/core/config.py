import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)

WORKSPACES_PATH = os.getenv("WORKSPACES_PATH", os.path.join(PROJECT_ROOT, "../backend/workspaces"))
MODEL_NAME = os.getenv("AGENT_MODEL", "gemini-2.5-flash")