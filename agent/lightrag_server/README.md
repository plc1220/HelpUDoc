# LightRAG server helper

This folder holds the minimal local configuration needed to run `lightrag-server` against Gemini's OpenAI-compatible endpoint.

It is optional and is not part of the default HelpUDoc startup path.

## Files

- `env.example`: sample environment file for local LightRAG runs

## Quick start

```bash
cd agent
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cd lightrag_server
cp env.example .env
# Replace the placeholder value before starting
../.venv/bin/lightrag-server
```

The server reads `.env` from the current working directory.

## Notes

- The example config uses `EMBEDDING_BINDING=openai` with Gemini's OpenAI-compatible endpoint.
- The embedding model is set to `gemini-embedding-001`.
- If you need custom embedding dimensionality, you may need a direct `google-genai` integration instead of the compatibility layer.
