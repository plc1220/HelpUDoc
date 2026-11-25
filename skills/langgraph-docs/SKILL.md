---
name: langgraph-docs
description: Use this skill for LangGraph questions by locating and summarizing official docs.
tools:
  - web_search
  - url_context
---

# langgraph-docs

## Overview
Use this skill to answer LangGraph questions with up‑to‑date documentation. Start from the docs index and then read the most relevant pages.

## Workflow
1. Use `web_search` to locate the LangGraph docs index (`llms.txt`).
2. From the index, pick 2–4 relevant documentation pages.
3. Use `url_context` to read the selected pages when available. Identify any guidance based only on search snippets.
4. Answer the user clearly and cite sources when possible.
