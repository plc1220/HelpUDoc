---
name: general
description: General assistant behavior, including skill routing and file/tool usage.
tools:
  - google_search
  - gemini_image
  - get_image_url
  - rag_query
---
# general

## Overview

Use this skill for general requests and as a router to other skills when specialized workflows are needed.

## Instructions

1. **Skill routing**

   - Scan `/skills` and select the most relevant skill(s).
   - Read only the chosen `SKILL.md` files (progressive disclosure).
   - When executing a skill, use only the tools listed in its frontmatter.
   - Route common document formats to the dedicated format skill before attempting file reads:
     - `.pdf` -> `pdf`
     - `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.webp`, `.svg` -> `image`
     - `.csv`, `.tsv`, `.xlsx`, `.xls`, `.ods`, `.parquet` -> `sheets`
     - `.pptx`, `.ppt`, `.key` -> `pptx`
2. **Workspace files**

   - Use `read_file` before editing text files.
   - Do not use `read_file` on common binary document formats such as images, PDFs, PowerPoint files, Excel files, or Parquet files.
   - If a file is binary, load the matching format skill first and follow that workflow instead of attempting UTF-8 text decoding.
   - Use `write_file` for new files and `edit_file` for modifications.
3. **Web research**

   - Use `google_search` when internet information is required.
4. **Tagged files**

   - If the user provided tagged files, prefer using only those files.
   - Use `rag_query` first if it returns relevant chunks for those file paths.
   - If `rag_query` returns no chunks (often because the file is new / not indexed), use `read_file` (or `grep`) on the tagged file(s) instead of getting stuck on RAG.

5. **Image generation and editing**

   - Treat the request as authorizing `gemini_image` whenever the user asks for image generation or image editing in substance, even if they do not name the tool.
   - This includes prompts asking for an image, PNG, JPG, diagram image, mockup, illustration, rendered visual, or requests such as `use gemini image`, `use gemini_image`, or `generate this as an image with Gemini`.
   - If the user asks for an image derived from a tagged workspace file, read the tagged file first, extract the relevant content, then call `gemini_image` without adding an extra approval/planning detour unless essential information is missing.
   - When making the image call, restate that the user asked for image generation or editing so downstream tool guards can see the authorization in context.
   - Do not call `gemini_image` for routine document or code tasks unless the user explicitly wants a visual artifact.

Always be concise, accurate, and efficient.
