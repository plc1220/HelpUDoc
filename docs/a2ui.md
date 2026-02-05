# A2UI in HelpUDoc

This document explains how the `/a2ui` flow works in HelpUDoc, how to save A2UI canvases as workspace artifacts, and what payload format the renderer expects.

## What is A2UI?
A2UI is a declarative server-to-client UI protocol. A response is a sequence of events like `surfaceUpdate`, `dataModelUpdate`, and `beginRendering`. HelpUDoc expects a JSON array of these events (not JSONL).

## User flow
1. In the chat pane, type `/a2ui` followed by your instructions.
   - Example: `/a2ui design a restaurant list with cards, images, and a primary button`
2. The agent returns a JSON array of A2UI events.
3. The canvas pane renders the A2UI result.
4. Click **Save A2UI** to store the payload as a workspace artifact (default extension: `.a2ui.json`).
5. Reopen the saved file from the file list to re-render the A2UI canvas.

## Payload requirements
- The agent must return **only JSON** with no markdown, no code fences, and no additional text.
- The top-level value must be a **JSON array** of event objects.
- Each object must have exactly one top-level key:
  - `beginRendering`
  - `surfaceUpdate`
  - `dataModelUpdate`
  - `deleteSurface`

## Recommended event order
HelpUDoc renders the final surface from a single array, so we recommend:

1. `surfaceUpdate`
2. `dataModelUpdate` (only if bindings are used)
3. `beginRendering`

The A2UI spec also allows streaming-style orders; those can still be converted into a JSON array.

## Example payload (minimal)

[
  {
    "surfaceUpdate": {
      "surfaceId": "main",
      "components": [
        {
          "id": "root",
          "component": {
            "Column": {
              "children": {
                "explicitList": ["title", "buttons"]
              }
            }
          }
        },
        {
          "id": "title",
          "component": {
            "Text": {
              "text": { "literalString": "Welcome" }
            }
          }
        },
        {
          "id": "buttons",
          "component": {
            "Row": {
              "children": {
                "explicitList": ["cancelButton", "okButton"]
              }
            }
          }
        },
        {
          "id": "cancelButton",
          "component": {
            "Button": { "child": "cancelButtonText" }
          }
        },
        {
          "id": "cancelButtonText",
          "component": {
            "Text": { "text": { "literalString": "Cancel" } }
          }
        },
        {
          "id": "okButton",
          "component": {
            "Button": { "child": "okButtonText" }
          }
        },
        {
          "id": "okButtonText",
          "component": {
            "Text": { "text": { "literalString": "OK" } }
          }
        }
      ]
    }
  },
  {
    "beginRendering": {
      "surfaceId": "main",
      "root": "root"
    }
  }
]

## Renderer implementation notes
- The canvas uses CopilotKit’s `@copilotkit/a2ui-renderer` (React) to render A2UI payloads.
- The renderer expects a JSON array of A2UI events and converts `surfaceUpdate` + `dataModelUpdate` into a component tree and data model.
- If a payload is invalid (not an array, unknown event keys, etc.), the renderer shows an error message.

## Troubleshooting
- **“A2UI payload must be a JSON array of events.”**
  - The response included extra text or was not valid JSON. Re-run `/a2ui` and ensure the prompt tells the agent to return JSON only.
- **“Unsupported A2UI event type.”**
  - The payload contained an event not supported by the renderer. Use only the standard event types listed above.
- **Nothing renders after saving.**
  - Open the `.a2ui.json` file again from the workspace list to re-render.
