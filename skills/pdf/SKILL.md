---
name: pdf
description: Work with PDF documents without treating them as plain UTF-8 text; prefer RAG-grounded extraction and be explicit about layout and OCR limits.
tools:
  - rag_query
  - request_clarification
---

# pdf

## Overview

Use this skill when the user asks about a `.pdf` file in the workspace.

This skill exists to prevent broken flows like calling `read_file` on binary PDF bytes.

## Rules

- Never call `read_file` on a raw `.pdf`.
- Prefer `rag_query` against the tagged PDF or the explicitly named workspace PDF.
- Treat PDF answers as extraction-based, not layout-perfect.
- Be honest when tables, charts, equations, scanned pages, or figure-heavy sections may be incomplete.

## Workflow

1. Confirm which PDF is in scope.
   - If the user tagged a PDF, use that file.
   - If multiple PDFs are present and the target is unclear, call `request_clarification`.

2. Query the indexed content first.
   - Use `rag_query` with the concrete task:
     - summarize
     - extract key findings
     - answer a specific question
     - locate a section, table, or figure reference
   - Ask for grounded output tied to the target file path when possible.

3. Handle limitations explicitly.
   - If the user asks for exact table values, figure details, or page-layout-sensitive content and the retrieved context is weak, say so clearly.
   - State that the current runtime is RAG-first for PDFs and may miss visual structure, OCR-heavy content, or dense tables.
   - Offer the next best path:
     - answer from the indexed text anyway
     - ask the user for a text/markdown export
     - ask the user for screenshots of the exact pages or figures

4. Keep claims grounded.
   - Do not invent content that was not retrieved.
   - When extraction is partial, label the answer as partial.

## Good uses

- Summarize a report PDF
- Extract key findings from a whitepaper
- Answer questions about a PDF the user uploaded
- Pull out named sections or cited claims from indexed PDF text

## Avoid

- Pretending you inspected raw PDF bytes directly
- Claiming exact visual layout fidelity when only RAG text was available
