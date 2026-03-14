# Clarification Form Design

This document captures the intended UX and transport contract for `request_clarification` when a skill needs guided human input rather than a simple yes/no approval.

## Goals

- Keep clarification visually aligned with the main chat UI.
- Let the agent ask concrete questions with suggested answers.
- Keep a visible freeform area for custom constraints or corrections.
- Make the primary confirmation action obvious and always in view.

## UX Pattern

The clarification card should contain:

1. A title and short description of what the agent needs.
2. Question groups, each with:
   - a section header
   - the actual question text
   - suggested answer tiles with short descriptions
3. A visible notes area that collects the selected answers and lets the user override them.
4. A primary `Continue` button near the notes heading so the action is not lost below the fold.

The user flow is:

1. Click suggested answers for any question.
2. The notes field is auto-populated with a structured draft.
3. Edit the draft if needed.
4. Click `Continue` to resume the agent run.

## Tool Contract

The heavy-weight contract lives in `request_clarification`, not in a skill-specific prompt workaround.

Recommended structured payload:

```json
{
  "title": "Presentation Setup",
  "description": "Confirm the inputs I should use before generating the deck.",
  "questions_json": [
    {
      "id": "purpose",
      "header": "Purpose",
      "question": "What is this presentation for?",
      "options": [
        {
          "id": "pitch",
          "label": "Pitch deck",
          "value": "Pitch deck",
          "description": "Selling an idea, product, or company to investors or clients"
        }
      ]
    }
  ],
  "allow_freeform": true,
  "placeholder": "Add any other constraints, references, or image paths here.",
  "submit_label": "Continue"
}
```

Notes:

- `options_json` is still fine for simple one-question clarification.
- `questions_json` is the preferred path for multi-question discovery forms.
- Bare section headers like `Purpose` or `Length` should not be used as the only options.

## Frontend Behavior

When `responseSpec.questions` exists, the frontend should:

- render the structured form UI
- keep the notes textarea visible at all times
- synthesize a structured draft from the selected tiles
- submit the textarea content back as the clarification response

If a legacy payload arrives with only flattened headers, the frontend may apply a local fallback for known flows such as `frontend-slides` so the user still sees a usable form.
