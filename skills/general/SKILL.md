---
name: general
description: General assistant behavior, including skill routing and file/tool usage.
tools:
  - google_search
  - gemini_image
  - get_image_url
  - rag_query
source_skills:
  - general-core
---

# general

## Overview
Use this skill for general requests and as a router to other skills when specialized workflows are needed.

## Instructions
1. **Skill routing**
   - Scan `/skills` and select the most relevant skill(s).
   - Read only the chosen `SKILL.md` files (progressive disclosure).
   - When executing a skill, use only the tools listed in its frontmatter.

2. **Workspace files**
   - Use `read_file` before editing.
   - Use `write_file` for new files and `edit_file` for modifications.

3. **Web research**
   - Use `google_search` when internet information is required.

4. **Tagged files**
   - If the user provided tagged-file RAG context, use only that context.
   - Do not call other tools or request more files in that case.

Always be concise, accurate, and efficient.
