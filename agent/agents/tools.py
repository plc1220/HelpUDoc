from langchain_core.tools import tool
import google.generativeai as genai
import os

genai_client = genai.Client(
    vertexai=True,
    project='my-rd-coe-demo-gen-ai',
    location='us-central1',
)

@tool
def google_search(query: str):
    """Performs a Google search using the native Gemini API."""
    # This is a simplified implementation.
    # In a real-world scenario, you might want to handle the response more robustly.
    model = genai.ChatModel(model="gemini-2.5-flash")
    response = model.generate_content(
        query,
        tools=[{"google_search": {}}],
    )
    return response.text