---
name: pdf
description: Work with PDF documents by reading the full text of the actual PDF, including querying tagged PDFs and creating simple image-based PDFs from workspace images.
tools:
  - read_tagged_document
  - create_pdf_from_images
  - request_clarification
---

# pdf

## Overview

Use this skill when the user asks about a `.pdf` file in the workspace, or asks to create a simple PDF from existing workspace images.

This skill reads the **actual PDF** — its full extracted text, every page — via `read_tagged_document`. It never relies on a derived-artifact summary, because summaries can omit details like fee tables, clause numbers, or specific figures.

## Rules

- Never call `read_file` on a raw `.pdf` (it is binary). Use `read_tagged_document` with the PDF's path.
- `read_tagged_document` returns the full original PDF text. If the response ends with a truncation marker, call it again with the given `offset` until you have read the entire document.
- Ground answers strictly in the PDF text you read. Do NOT rely on a derived-artifact summary, and do not use web search for a tagged-PDF question.
- If the user asks to stitch, combine, consolidate, or convert image files into a PDF, use `create_pdf_from_images` (preserve image order, one page per image; do not summarize or OCR them).
- Treat PDF answers as extraction-based. Be honest when scanned pages, figures, or dense tables may be incompletely captured by text extraction.

## Workflow

1. Determine the PDF task type.
   - Existing PDF question or extraction
   - New PDF assembled from images

2. For existing PDF questions, confirm which PDF is in scope.
   - If the user tagged a PDF, use that file.
   - If multiple PDFs are present and the target is unclear, call `request_clarification`.

3. Read the actual PDF.
   - Call `read_tagged_document` on the PDF path and read the whole document (page through with `offset` until complete) before answering.
   - Locate the specific content the user asked about (a fee, a section, a table row, a defined term) in the extracted text and quote/cite it.

4. Handle limitations explicitly.
   - If exact table values or figure-heavy/scanned content look incomplete in the extracted text, say so and offer to work from screenshots of the exact pages.

5. Keep claims grounded.
   - Do not invent content that was not in the extracted text. When extraction is partial, label the answer as partial.

6. For image-to-PDF creation:
   - Use the tagged image paths or explicitly named image files, in the user's requested order.
   - Call `create_pdf_from_images` and reply with the created PDF path only after the tool succeeds.

## Good uses

- Answer a specific question about a tagged PDF (e.g. "what is the authorization fee?") by reading the full PDF text
- Summarize or extract key findings from a report PDF
- Pull out named sections, fees, tables, or cited claims from the actual PDF text
- Stitch PNG/JPG images into a multi-page PDF

## Avoid

- Answering from a derived-artifact summary instead of the actual PDF text
- Pretending you inspected raw PDF bytes directly
- Claiming exact visual layout fidelity when only extracted text was available
