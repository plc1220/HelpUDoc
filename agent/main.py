from fastapi import FastAPI, Form
from fastapi.responses import JSONResponse

from agents.manager import create_workspace_agent

app = FastAPI(title="DeepAgent Service", version="0.1")


@app.post("/workspace/{workspace}/chat")
async def chat(workspace: str, message: str = Form(...)):
    agent = create_workspace_agent(workspace)
    result = agent.invoke({"messages": [{"role": "user", "content": message}]})
    return JSONResponse({"reply": result})