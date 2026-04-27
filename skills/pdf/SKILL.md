---
name: pdf
description: Work with PDF documents safely, including querying existing PDFs and creating simple image-based PDFs from workspace images.
tools:
  - rag_query
  - create_pdf_from_images
  - request_clarification
---

# pdf

## Overview

Use this skill when the user asks about a `.pdf` file in the workspace, or asks to create a simple PDF from existing workspace images.

This skill exists to prevent broken flows like calling `read_file` on binary PDF bytes, or rewriting image content into text when the user asked for an image-based PDF.

## Rules

- Never call `read_file` on a raw `.pdf`.
- If the user asks to stitch, combine, consolidate, or convert image files into a PDF, use `create_pdf_from_images`.
- For image-to-PDF tasks, preserve the user's requested image order and create one PDF page per input image.
- Do not summarize, OCR, rewrite, or reinterpret images when the user asked to combine them into a PDF.
- Prefer `rag_query` against the tagged PDF or the explicitly named workspace PDF.
- Treat PDF answers as extraction-based, not layout-perfect.
- Be honest when tables, charts, equations, scanned pages, or figure-heavy sections may be incomplete.

## Workflow

1. Determine the PDF task type.
   - Existing PDF question or extraction
   - New PDF assembled from images

2. For image-to-PDF creation:
   - Use the tagged image paths or explicitly named image files.
   - Call `create_pdf_from_images` with those paths in the same order.
   - Choose a concise output path such as `/stitched_images.pdf` unless the user names one.
   - Reply with the created PDF path only after the tool succeeds.

3. For existing PDF questions, confirm which PDF is in scope.
   - If the user tagged a PDF, use that file.
   - If multiple PDFs are present and the target is unclear, call `request_clarification`.

4. Query the indexed content first.
   - Use `rag_query` with the concrete task:
     - summarize
     - extract key findings
     - answer a specific question
     - locate a section, table, or figure reference
   - Ask for grounded output tied to the target file path when possible.

5. Handle limitations explicitly.
   - If the user asks for exact table values, figure details, or page-layout-sensitive content and the retrieved context is weak, say so clearly.
   - State that the current runtime is RAG-first for PDFs and may miss visual structure, OCR-heavy content, or dense tables.
   - Offer the next best path:
     - answer from the indexed text anyway
     - ask the user for a text/markdown export
     - ask the user for screenshots of the exact pages or figures

6. Keep claims grounded.
   - Do not invent content that was not retrieved.
   - When extraction is partial, label the answer as partial.

## Good uses

- Summarize a report PDF
- Extract key findings from a whitepaper
- Answer questions about a PDF the user uploaded
- Pull out named sections or cited claims from indexed PDF text
- Stitch PNG/JPG images into a multi-page PDF
- Convert tagged images into a one-image-per-page PDF

## Avoid

- Pretending you inspected raw PDF bytes directly
- Claiming exact visual layout fidelity when only RAG text was available
