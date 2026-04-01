---
name: image
description: Work with image files safely; do not decode them as text, use image URLs for referencing, and use Gemini only for generation or editing requests.
tools:
  - gemini_image
  - get_image_url
  - request_clarification
---

# image

## Overview

Use this skill for image files such as `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.webp`, and `.svg`.

## Rules

- Never call `read_file` on a binary image.
- Use `get_image_url` when the user needs to reference an uploaded workspace image in Markdown, HTML, or chat.
- Use `gemini_image` only when the user wants image generation or image editing.
- Do not claim to have visually inspected an image if the runtime only has file metadata and no vision input path for that file.

## Workflow

1. Determine the request type.
   - Reference an existing workspace image
   - Generate a new image
   - Edit an existing image
   - Describe or inspect image content

2. Reference flow.
   - If the task is to include or share an existing workspace image, call `get_image_url`.
   - Use the returned public URL in the output artifact or response.

3. Generation or editing flow.
   - If the user is asking for creation or editing in substance, use `gemini_image`.
   - Keep the prompt grounded in the user's stated goal.

4. Visual-inspection limitation handling.
   - If the user asks what is inside a workspace image and there is no supported vision-read path for that file in the current runtime, say so plainly.
   - Ask for either:
     - a direct description request using a supported image input path
     - a screenshot embedded in a PDF or document that can be queried another way
     - the specific text/context they want extracted

## Good uses

- Insert or share uploaded charts and diagrams with public URLs
- Generate a new illustration, concept image, or mockup
- Edit or restyle an image with Gemini

## Avoid

- Treating PNG or JPG bytes as text
- Pretending an image was visually analyzed when it was not
