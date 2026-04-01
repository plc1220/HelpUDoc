---
name: sheets
description: Handle spreadsheets and tabular files safely; use text reads only for text tables and avoid treating Excel or Parquet binaries as UTF-8 files.
tools:
  - data_agent_tools
  - request_clarification
---

# sheets

## Overview

Use this skill for spreadsheet and tabular file requests, including `.csv`, `.tsv`, `.xlsx`, `.xls`, `.ods`, and `.parquet`.

## Rules

- Do not call `read_file` on `.xlsx`, `.xls`, `.ods`, or `.parquet`.
- Only treat `.csv` and `.tsv` as text files.
- Use the data tools for structured analysis when the task is analytical rather than purely editorial.
- Be explicit when a binary spreadsheet format needs conversion before the agent can inspect it reliably.

## Workflow

1. Identify the actual table format.
   - Text tabular formats: `.csv`, `.tsv`
   - Binary spreadsheet formats: `.xlsx`, `.xls`, `.ods`
   - Columnar binary data: `.parquet`

2. Choose the safest path.
   - For `.csv` and `.tsv`:
     - You may use normal text-file workflows.
     - If the user wants analysis, prefer the data toolchain.
   - For `.parquet`:
     - Prefer the data toolchain.
     - Do not attempt UTF-8 decoding.
   - For `.xlsx`, `.xls`, `.ods`:
     - Do not pretend the workbook is directly readable if no converter is available.
     - Ask for a CSV export of the relevant sheet when exact cell inspection is required.

3. Set expectations for workbook files.
   - If the user asks to inspect formulas, multiple tabs, or formatting from Excel files, say the current runtime does not have native workbook parsing in the core file tools.
   - Ask for the specific sheet exported as CSV if needed.

4. Stay honest about scope.
   - Do not fabricate sheet names, formulas, or hidden-tab content.
   - If only partial tabular data is accessible, say exactly what was inspected.

## Good uses

- Analyze CSV exports
- Work with Parquet-backed data through the data toolchain
- Help the user decide how to convert a workbook for agent analysis

## Avoid

- Calling `read_file` on Excel binaries
- Claiming workbook-level insight without a readable export
