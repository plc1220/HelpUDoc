# Skills Cleanup Recommendations

This note captures conservative cleanup candidates after adding the fuller DOCX and PPTX runtime skills.

## Recommended removals or merges

### 1. Merge `image-to-pdf` into `pdf`

Status: removed.

Why: `pdf` already declares `create_pdf_from_images` and contains the same image-to-PDF workflow: preserve order, one image per page, no OCR or rewriting. Keeping both skills creates routing ambiguity for image stitching requests.

Implemented path:

- Kept the `pdf` skill.
- Removed `skills/image-to-pdf/`.
- Updated `tests/test_image_to_pdf_skill.py` to assert the `pdf` skill owns image-to-PDF creation.

Risk: low. The same tool is already available through `pdf`.

### 2. Merge `sheets` into `xlsx` plus `data/*`

Status: removed.

Why: `sheets` is now mostly a safety/router stub. Native workbook creation/editing belongs to `xlsx`; analytical tabular work belongs to `data/explore`, `data/query`, or `data/analyze`. The current `sheets` skill still mentions `.xlsx`, `.csv`, and `.tsv`, which overlaps with the stronger `xlsx` skill and data skills.

Implemented path:

- Moved binary-read cautions and routing guidance into `xlsx` and the `data` hub.
- Removed `skills/sheets/`.
- Updated document-format tests to assert `xlsx` remains discoverable and `sheets` is gone.

Risk: medium. Some users may still say "sheets" when they mean Google Sheets. If Google Sheets connector routing is available, that should be handled by Google Workspace tools/plugin guidance rather than this local file skill.

### 3. Keep `frontend-slides`, but narrow it further over time

Status: keep for now.

Why: it still owns browser-native HTML/animated web presentations and has A2UI gate tests. It should not handle PPTX/PowerPoint/native deck work now that `pptx` exists.

Suggested path:

- Keep `frontend-slides` until A2UI gates are generalized and a replacement HTML deck path exists.
- Continue removing stale PPTX conversion language from docs as touched.

Risk: high if removed now. Runtime and frontend tests still exercise frontend-slides-specific gates.

### 4. Evaluate `toc-analysis`

Status: possible future merge.

Why: it is a narrow document-structure helper. Some of its scope overlaps with `docx`, `pdf`, `proposal-writing`, and `research`, depending on the input document type.

Suggested path:

- Keep until there is evidence it misroutes.
- If removed, move its table-of-contents checklist into `docx`/`pdf` or a general document-analysis section.

Risk: low to medium, depending on whether users actively invoke outline analysis.

### 5. Keep `langgraph-docs`

Status: keep.

Why: it is intentionally narrow and current-docs-oriented. It does not overlap with the Office skill cleanup.

Risk: low.

## Cleanup already applied

- `pptx` owns `.ppt`, `.pptx`, PowerPoint, Google Slides, native deck creation/editing/templates, and PPTX output.
- `frontend-slides` is restricted to browser-native HTML/web presentations.
- Sales handoff skills now point native deck requests to `pptx` and only point HTML/web presentation requests to `frontend-slides`.
- `pdf` now owns image-to-PDF creation.
- `xlsx` and `data/*` now own local spreadsheet file workflows that were previously covered by the `sheets` router stub.
