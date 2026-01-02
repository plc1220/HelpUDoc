# LightRAG server (local)

This folder contains a minimal `env.example` for running `lightrag-server` against Gemini.

## Quick start

```bash
cd agent/lightrag_server
cp env.example .env
sed -i '' 's/YOUR_GEMINI_API_KEY/REPLACE_ME/' .env

../.venv/bin/lightrag-server
```

The server reads `.env` from the current folder (see `lightrag/api/config.py` in the installed package).

## Notes

- Embeddings: this setup uses `EMBEDDING_BINDING=openai` pointing at Gemini's OpenAI-compatible endpoint, with `EMBEDDING_MODEL=gemini-embedding-001`.
- If you want smaller vectors (e.g. 1536/768), the OpenAI-compatible embeddings path may not expose dimensionality controls; if that becomes a requirement we should wire embeddings directly through `google-genai` instead.

