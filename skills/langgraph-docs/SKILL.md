---
name: langgraph-docs
description: Use this skill for LangGraph questions by locating and summarizing official docs.
tools:
  - google_search
---

# langgraph-docs

## Overview
Use this skill to answer LangGraph questions with up‑to‑date documentation. Start from the docs index and then read the most relevant pages.

## Workflow
1. Use `google_search` to locate the LangGraph docs index (`llms.txt`).
2. From the index, pick 2–4 relevant documentation pages.
3. Use `google_search` to open those pages and extract the needed guidance.
4. Answer the user clearly and cite sources when possible.
