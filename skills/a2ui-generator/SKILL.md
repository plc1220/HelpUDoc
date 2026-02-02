---
name: a2ui-generator
description: Generate Google A2UI v0.8 server-to-client UI payloads (JSON array of A2UI events) from user prompts. Use when a user asks for /a2ui output, an "A2UI canvas", or UI generation that must follow the A2UI protocol.
---

# A2UI Generator

## Goal
Generate a valid A2UI v0.8 server-to-client message sequence for a simple, one-time UI. The HelpUDoc workspace expects a JSON array (not JSONL) of A2UI events with no markdown or explanations.

## Output rules (must follow)
1. Return ONLY JSON, no prose, no markdown, no code fences.
2. Output must be a JSON array of A2UI event objects. Each object must have exactly one top-level key:
   - beginRendering
   - surfaceUpdate
   - dataModelUpdate
   - deleteSurface
3. Use a single surface unless the prompt explicitly needs multiple. Default surfaceId: "main".
4. Use stable, descriptive IDs for components (e.g., "root", "title", "submitButton").
5. Keep the UI minimal and use only standard catalog components from the A2UI spec.

## Recommended minimal event order (HelpUDoc)
- surfaceUpdate (define the component tree)
- dataModelUpdate (only if bindings are used)
- beginRendering (surfaceId + root)

If no bindings are used, omit dataModelUpdate. The A2UI spec allows other orders for streaming; HelpUDoc expects a single JSON array and renders the final surface.

## Component structure (v0.8)
- The UI tree is a component graph. Each component is an object with:
  - id
  - component (object with a single key for the component type)
  - component properties (inside that component type object)
- Parent-child relationships are expressed with a children property. Use explicitList for fixed children.

## Data binding
- Prefer literalString / literalNumber / literalBoolean in properties for static content.
- Use data bindings only when the UI has inputs or state.
- When using bindings, define the data model keys in dataModelUpdate contents (adjacency list).

## Example: Simple layout
This example shows a title and two buttons using the structure format from the spec.

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
            "Button": {
              "child": "cancelButtonText"
            }
          }
        },
        {
          "id": "cancelButtonText",
          "component": {
            "Text": {
              "text": { "literalString": "Cancel" }
            }
          }
        },
        {
          "id": "okButton",
          "component": {
            "Button": {
              "child": "okButtonText"
            }
          }
        },
        {
          "id": "okButtonText",
          "component": {
            "Text": {
              "text": { "literalString": "OK" }
            }
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

## Example: Data model update (for bindings)

[
  {
    "dataModelUpdate": {
      "contents": [
        {
          "key": "results",
          "valueList": [
            { "valueString": "Milk" },
            { "valueString": "Bread" }
          ]
        }
      ]
    }
  }
]

## Example: Streaming-style full sequence (adapted to JSON array)
This example mirrors the spec's JSONL stream, but converted to a JSON array for HelpUDoc.

[
  {
    "beginRendering": {
      "surfaceId": "main",
      "root": "root"
    }
  },
  {
    "surfaceUpdate": {
      "surfaceId": "main",
      "components": [
        {
          "id": "root",
          "component": {
            "Column": {
              "children": {
                "explicitList": ["header", "itemList"]
              }
            }
          }
        },
        {
          "id": "header",
          "component": {
            "Text": {
              "text": { "literalString": "Shopping List" }
            }
          }
        },
        {
          "id": "itemList",
          "component": {
            "List": {
              "direction": "vertical",
              "children": {
                "template": {
                  "componentId": "listItemTemplate",
                  "dataBinding": "/items"
                }
              }
            }
          }
        },
        {
          "id": "listItemTemplate",
          "component": {
            "Text": {
              "text": { "path": "item" }
            }
          }
        }
      ]
    }
  },
  {
    "dataModelUpdate": {
      "path": "/",
      "contents": [
        {
          "key": "items",
          "valueList": [
            { "valueString": "Milk" },
            { "valueString": "Bread" }
          ]
        }
      ]
    }
  }
]

## When unsure
- If the prompt is ambiguous, choose the simplest layout (Column -> Text -> Row).
- Avoid advanced features (templates, conditional rendering, multiple surfaces) unless required.

## References
- A2UI Message Reference: https://a2ui.org/reference/messages/
- A2UI Components and Structure: https://a2ui.org/concepts/components/
- A2UI v0.8 Specification: https://a2ui.org/specification/v0.8-a2ui/
