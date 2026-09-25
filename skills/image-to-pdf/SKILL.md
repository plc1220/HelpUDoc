---
name: image-to-pdf
description: Create a multi-page PDF from existing workspace images without OCR, summarization, or content rewriting.
tools:
  - create_pdf_from_images
  - request_clarification
---

# image-to-pdf

## Overview

Use this skill when the user asks to stitch, combine, consolidate, merge, or convert image files into a PDF.

## Rules

- Use the original workspace image files as PDF pages.
- Preserve the order requested by the user.
- Create one PDF page per input image.
- Do not summarize, OCR, rewrite, or reinterpret the image contents.
- Do not use data analysis or SQL tools for this workflow.
- Do not call `rag_query` unless the user asks a question about image-derived text rather than asking to create the PDF.

## Workflow

1. Identify the image paths from tagged files or explicitly named files.
2. If the target images are ambiguous, call `request_clarification`.
3. Call `create_pdf_from_images` with the image paths in order.
4. Reply with the created PDF path and page count.

## Good Uses

- Combine three PNG screenshots into a 3-page PDF
- Stitch JPG pages into a single PDF
- Convert selected workspace images into a shareable PDF
