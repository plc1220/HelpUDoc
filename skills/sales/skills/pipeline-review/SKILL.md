---
name: pipeline-review
description: Analyze pipeline health from CSV, Sheets, or CRM data. This skill should stay usable for weekly reviews even when the team operates from Sheets or exports rather than a live CRM.
argument-hint: "<segment or rep>"
---

# /pipeline-review

Use this skill to review pipeline hygiene, prioritize deals, and generate a weekly action plan.

## Usage

```text
/pipeline-review [segment or rep]
```

Review pipeline for: $ARGUMENTS

If a file is referenced: @$1

## Operating Rules

- Prefer tagged files, Sheets, or CSV exports before assuming CRM access.
- Keep the review focused on actions and risk, not just reporting.
- Use Calendar context only if it sharpens the action plan for live deals.

## Data Preference Order

1. Tagged pipeline files
2. Google Sheets trackers or review tabs
3. Uploaded CSV exports
4. Pasted deal summaries
5. CRM data when available

## Output

Produce:

- pipeline health summary
- top weekly priorities
- stale or stuck deal flags
- hygiene issues
- recommended actions by deal

## Notes

- This skill remains CRM-aware, but the success path should still work for Sheets and CSV users.
- It should complement `daily-briefing`, not replace it.
