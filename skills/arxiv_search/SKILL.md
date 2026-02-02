---
name: arxiv-search
description: Find and summarize relevant arXiv papers for a research topic.
tools:
  - google_search
---

# arxiv-search

## Overview
Use this skill to locate relevant arXiv papers and summarize the most important findings.

## Workflow
1. Extract 3–5 key phrases from the user query.
2. Use `google_search` with `site:arxiv.org` to find recent and relevant papers.
3. Select 3–8 papers based on title, abstract, and recency.
4. Summarize each paper (problem, method, key results) and include the arXiv link.
