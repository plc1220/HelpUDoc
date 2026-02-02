# Image Tools Architecture & Flow

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER REQUEST                             │
│  "Include sales_chart.png into report.md"                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GENERAL AGENT                               │
│  Interprets request and calls appropriate tool                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  insert_image_to_file                            │
│  (image_file_name="sales_chart.png",                            │
│   target_file_path="/report.md")                                │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
        ▼                                         ▼
┌──────────────────┐                    ┌──────────────────┐
│  STEP 1: FIND    │                    │  STEP 2: GET     │
│  IMAGE FILE      │                    │  PUBLIC URL      │
│                  │                    │                  │
│ • Search in      │                    │ • Check metadata │
│   workspace      │                    │   file           │
│ • Match filename │                    │ • Construct URL  │
│                  │                    │   if needed      │
└────────┬─────────┘                    └────────┬─────────┘
         │                                       │
         └───────────────┬───────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────────┐
        │  STEP 3: CREATE IMAGE REFERENCE        │
        │                                        │
        │  Markdown: ![Alt](url)                │
        │  HTML: <img src="url" alt="Alt" />    │
        └────────────────┬───────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────────┐
        │  STEP 4: INSERT INTO FILE              │
        │                                        │
        │  • Read existing content               │
        │  • Insert at position                  │
        │  • Write back to file                  │
        └────────────────┬───────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SUCCESS RESPONSE                            │
│  "✓ Successfully inserted image into report.md"                 │
│  "The image will now be rendered in the frontend."              │
└─────────────────────────────────────────────────────────────────┘
```

## Tool Comparison

```
┌──────────────────────┬──────────────────────┬─────────────────────┐
│                      │   get_image_url      │ insert_image_to_file│
├──────────────────────┼──────────────────────┼─────────────────────┤
│ Purpose              │ Get URL only         │ Get URL + Insert    │
│ Modifies files       │ No                   │ Yes                 │
│ Returns              │ URL string           │ Success message     │
│ Parameters           │ 1 (filename)         │ 4 (file, target,    │
│                      │                      │    alt, position)   │
│ Use case             │ Reference elsewhere  │ Embed in docs       │
│ Frontend rendering   │ Manual               │ Automatic           │
└──────────────────────┴──────────────────────┴─────────────────────┘
```

## Data Flow

### Scenario 1: With Metadata File

```
User Request
    │
    ▼
insert_image_to_file("chart.png", "/report.md")
    │
    ├─► Check .workspace_metadata.json
    │       │
    │       ├─► Found: chart.png
    │       │       publicUrl: http://localhost:9000/helpudoc/ws-123/chart.png
    │       │
    │       └─► Use this URL ✓
    │
    ├─► Detect file type: report.md → Markdown
    │
    ├─► Create reference: ![Chart](http://localhost:9000/...)
    │
    ├─► Insert into report.md at position "end"
    │
    └─► Return success message
```

### Scenario 2: Without Metadata File (Fallback)

```
User Request
    │
    ▼
insert_image_to_file("chart.png", "/report.md")
    │
    ├─► Check .workspace_metadata.json
    │       │
    │       └─► Not found ✗
    │
    ├─► Search workspace filesystem
    │       │
    │       ├─► Found: /charts/chart.png
    │       │
    │       └─► Construct URL:
    │           S3_ENDPOINT + BUCKET + workspace_id + /charts/chart.png
    │           = http://localhost:9000/helpudoc/ws-123/charts/chart.png
    │
    ├─► Detect file type: report.md → Markdown
    │
    ├─► Create reference: ![Chart](http://localhost:9000/...)
    │
    ├─► Insert into report.md at position "end"
    │
    └─► Return success message with note about constructed URL
```

## File Format Detection

```
Target File Extension
    │
    ├─► .md or .markdown
    │       │
    │       └─► Output: ![Alt Text](url)
    │
    ├─► .html or .htm
    │       │
    │       └─► Output: <img src="url" alt="Alt Text" />
    │
    └─► Other
            │
            └─► Default to Markdown format
```

## Position Handling

```
Position Parameter
    │
    ├─► "start"
    │       │
    │       └─► Insert at beginning:
    │           ![Image](url)\n\n<existing content>
    │
    ├─► "end" (default)
    │       │
    │       └─► Append to end:
    │           <existing content>\n\n![Image](url)\n
    │
    └─► "10" (line number)
            │
            └─► Insert at line 10:
                Split content at line 10
                Insert image reference
                Rejoin content
```

## Integration Points

```
┌─────────────────────────────────────────────────────────────────┐
│                        WORKSPACE                                 │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │   Images       │  │   Documents    │  │    Metadata      │  │
│  │                │  │                │  │                  │  │
│  │ • chart.png    │  │ • report.md    │  │ .workspace_      │  │
│  │ • diagram.jpg  │  │ • index.html   │  │  metadata.json   │  │
│  │ • flow.png     │  │ • README.md    │  │                  │  │
│  └────────┬───────┘  └────────┬───────┘  └────────┬─────────┘  │
│           │                   │                    │             │
└───────────┼───────────────────┼────────────────────┼─────────────┘
            │                   │                    │
            ▼                   ▼                    ▼
    ┌───────────────┐   ┌──────────────┐   ┌────────────────┐
    │ MinIO/S3      │   │  Frontend    │   │  Backend       │
    │ Storage       │   │  Renderer    │   │  (Optional)    │
    │               │   │              │   │                │
    │ Public URLs   │   │ Displays     │   │ Maintains      │
    │ for images    │   │ images       │   │ metadata file  │
    └───────────────┘   └──────────────┘   └────────────────┘
```

## Workflow Examples

### Example 1: Data Agent Chart

```
1. Data Agent generates chart
   generate_chart_config(...) → /charts/Revenue_Analysis.png

2. User asks: "Add the revenue chart to my report"

3. Agent calls:
   insert_image_to_file("Revenue_Analysis.png", "/report.md")

4. Tool execution:
   • Finds: /charts/Revenue_Analysis.png
   • Gets URL: http://localhost:9000/helpudoc/ws-123/charts/Revenue_Analysis.png
   • Creates: ![Revenue Analysis](http://localhost:9000/...)
   • Inserts into: /report.md

5. Result:
   report.md now contains the image reference
   Frontend renders the chart when viewing report.md
```

### Example 2: Gemini Image

```
1. User asks: "Create a flowchart and add it to the README"

2. Agent generates image:
   gemini_image(prompt="flowchart", ...) → /flowchart-1.png

3. Agent inserts:
   insert_image_to_file("flowchart-1.png", "/README.md", position="start")

4. Tool execution:
   • Finds: /flowchart-1.png
   • Gets URL: http://localhost:9000/helpudoc/ws-123/flowchart-1.png
   • Creates: ![Flowchart 1](http://localhost:9000/...)
   • Inserts at start of: /README.md

5. Result:
   README.md starts with the flowchart image
```

## Error Handling Flow

```
insert_image_to_file(image_file_name, target_file_path)
    │
    ├─► Try to find image
    │       │
    │       ├─► Found ✓ → Continue
    │       │
    │       └─► Not Found ✗
    │               │
    │               └─► Return: "Error: Image file 'xxx' not found"
    │
    ├─► Try to get URL
    │       │
    │       ├─► Got URL ✓ → Continue
    │       │
    │       └─► No URL ✗
    │               │
    │               └─► Construct URL from file location
    │
    ├─► Try to insert at position
    │       │
    │       ├─► Valid position ✓ → Continue
    │       │
    │       └─► Invalid line number ✗
    │               │
    │               └─► Return: "Error: Line number out of range"
    │
    └─► Try to write file
            │
            ├─► Success ✓ → Return success message
            │
            └─► Error ✗ → Return error with traceback
```

## Configuration Architecture

```
config/runtime.yaml
    │
    ├─► tools:
    │       ├─► get_image_url (builtin)
    │       └─► insert_image_to_file (builtin)
    │
    └─► agents:
            └─► general-assistant:
                    └─► tools:
                            ├─► google_search
                            ├─► gemini_image
                            ├─► get_image_url
                            └─► insert_image_to_file

helpudoc_agent/tools_and_schemas.py
    │
    └─► ToolFactory:
            └─► _builtin_map:
                    ├─► "get_image_url" → _build_get_image_url_tool()
                    └─► "insert_image_to_file" → _build_insert_image_to_file_tool()
```

## Summary

The image tools provide a complete solution for working with images in the HelpUDoc system:

1. **Automatic URL Resolution**: Finds images and gets their public URLs
2. **Format Detection**: Automatically uses markdown or HTML format
3. **Flexible Positioning**: Insert at start, end, or specific line
4. **Error Handling**: Comprehensive error messages and fallbacks
5. **Frontend Ready**: Images render correctly when viewing files

The tools work seamlessly together to enable natural language requests like:
- "Include chart.png in report.md"
- "Add diagram to the top of README"
- "Put the revenue chart in analysis with description 'Q4 Growth'"
