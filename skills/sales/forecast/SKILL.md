---
name: forecast
description: Generate a weighted sales forecast from CSV, Sheets, or CRM data. This skill remains CRM-ready, but should succeed with Sheets or pasted pipeline context instead of assuming a connected CRM.
argument-hint: "<period>"
---

# /forecast

Use this skill for forecast reviews, gap-to-quota analysis, and commit versus upside planning.

## Usage

```text
/forecast [period]
```

Generate a forecast for: $ARGUMENTS

If a file is referenced: @$1

## Operating Rules

- Prefer Google Sheets or uploaded CSV data first.
- Use CRM as enrichment when present, not as a prerequisite.
- Keep the output analytical and brief-first.
- If the user tagged a pipeline file, use that before asking for more data.

## Data Preference Order

1. Tagged pipeline files
2. Google Sheets trackers or exports
3. Uploaded CSV exports
4. Pasted deal lists
5. CRM data when available

## Output

Produce:

- quota and attainment summary
- weighted forecast
- best, likely, and worst cases
- commit versus upside breakdown
- gap analysis
- top recommendations

## Notes

- This skill is secondary to the GWS-first seller workflows.
- Keep the workflow usable for teams whose pipeline currently lives in Sheets rather than a CRM.
