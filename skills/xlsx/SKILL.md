---
name: xlsx
description: Create, inspect, edit, recalculate, and validate Excel .xlsx workbooks using sandboxed Python, openpyxl, pandas, and LibreOffice.
tools:
  - run_skill_python_script
sandbox_scripts:
  - name: inspect
    path: scripts/inspect_workbook.py
    sha256: "7dded9d1157a19ca6328ce43eb306482f127e9628c21d6f5617e6e82a9e460ba"
    timeout_seconds: 60
    outputs:
      - outputs/inspection.json
      - outputs/inspection.md
  - name: edit_workbook
    path: scripts/edit_workbook.py
    sha256: "11403b8a077e0d8d39332ed4f378259b1145ad8e8001d89488e65f2ba60149d4"
    timeout_seconds: 120
    outputs:
      - outputs/workbook.xlsx
      - outputs/result.json
  - name: recalc
    path: scripts/recalc.py
    sha256: "6950f8c2963254f6326e484d573f9774aae0fcea8a9ce518d9d6769f6f3fe0ca"
    timeout_seconds: 120
    outputs:
      - outputs/recalculated.xlsx
      - outputs/recalc.json
---

# xlsx

Use this skill when the primary input or output is an Excel `.xlsx` workbook and the user wants to inspect, create, edit, format, calculate, or validate workbook content.

## Rules

- Do not read `.xlsx` as plain text.
- Preserve existing workbook structure and formatting unless the user asks for a new workbook or redesign.
- Prefer formulas over hardcoded calculated values so the workbook remains dynamic.
- Recalculate and validate after writing formulas.
- For financial models, use standard conventions unless the workbook has its own style:
  - Blue font for hardcoded inputs.
  - Black font for formulas.
  - Green font for same-workbook links.
  - Red font for external links.
  - Yellow fill for key assumptions.
  - Negative numbers in parentheses.
  - Zeros displayed as `-`.
- If exact formulas, hidden rows, pivots, charts, macros, or legacy `.xls` behavior matters, say what the sandbox can and cannot preserve.

## Available Scripts

### inspect

Inspect workbook sheets, dimensions, tables, merged ranges, formula counts, cached formula errors, and a small preview.

Call:

```text
run_skill_python_script(script_name="inspect", input_paths=["/workbook.xlsx"], args=["workbook.xlsx"])
```

Outputs:

- `outputs/inspection.json`
- `outputs/inspection.md`

### edit_workbook

Create a new workbook or edit an existing workbook using JSON operations. This supports:

- `add_sheet`
- `set_cell`
- `append_row`
- `insert_rows`
- `delete_rows`
- `insert_cols`
- `delete_cols`
- `set_column_width`
- `freeze_panes`

For a new workbook:

```text
run_skill_python_script(
  script_name="edit_workbook",
  args=[
    "--operations-json",
    "[{\"op\":\"set_cell\",\"sheet\":\"Summary\",\"cell\":\"A1\",\"value\":\"Revenue\",\"font\":{\"bold\":true}}]"
  ]
)
```

For an existing workbook:

```text
run_skill_python_script(
  script_name="edit_workbook",
  input_paths=["/model.xlsx"],
  args=["--input", "model.xlsx", "--operations-json", "[...]"]
)
```

Outputs:

- `outputs/workbook.xlsx`
- `outputs/result.json`

### recalc

Recalculate formulas with LibreOffice and scan cached values for Excel errors.

Call:

```text
run_skill_python_script(script_name="recalc", input_paths=["/workbook.xlsx"], args=["workbook.xlsx", "30"])
```

Outputs:

- `outputs/recalculated.xlsx`
- `outputs/recalc.json`

## Workflow

1. Load this skill.
2. Inspect the workbook when modifying an existing file.
3. Use `edit_workbook` to create or modify the workbook.
4. If formulas were created or changed, run `recalc` on the produced workbook.
5. If `recalc.json` reports `errors_found`, fix the workbook and recalculate again.
6. Return the final `.xlsx` path and summarize any formula validation results.
