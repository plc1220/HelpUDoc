# Updated Implementation Summary: Image Tools for General Agent

## Overview

Two complementary tools have been created for the general agent to work with images stored in MinIO/S3:

1. **`get_image_url`** - Fetch public URLs for images
2. **`insert_image_to_file`** - Insert image references into markdown/HTML files (NEW!)

## Primary Use Case

When a user asks: **"Include chart.png into report.md"**

The agent can now:
1. Find the image file in the workspace
2. Get its public MinIO/S3 URL
3. Insert the proper markdown/HTML reference into the file
4. Ensure the image renders correctly in the frontend

## Files Modified

### 1. `/agent/helpudoc_agent/tools_and_schemas.py`

**Changes:**
- Added `"get_image_url": self._build_get_image_url_tool` to `ToolFactory._builtin_map`
- Added `"insert_image_to_file": self._build_insert_image_to_file_tool` to `ToolFactory._builtin_map`
- Implemented `_build_get_image_url_tool()` method (lines 214-321)
- Implemented `_build_insert_image_to_file_tool()` method (lines 323-467)

### 2. `/agent/config/agents.yaml`

**Tool Definitions Added:**
```yaml
- name: get_image_url
  kind: builtin
  description: Get public URLs for images stored in MinIO/S3

- name: insert_image_to_file
  kind: builtin
  description: Insert image references into markdown or HTML files with public URLs
```

**Added to general-assistant agent:**
```yaml
tools:
  - google_search
  - gemini_image
  - get_image_url
  - insert_image_to_file
```

## Tool 1: get_image_url

### Purpose
Retrieve the public URL for an image file stored in MinIO/S3.

### Usage
```python
url = get_image_url("chart.png")
# Returns: "Public URL: http://localhost:9000/helpudoc/workspace-123/charts/chart.png"
```

### Features
- Reads from `.workspace_metadata.json` (preferred)
- Falls back to file system search + URL construction
- Supports exact and partial filename matching
- Comprehensive error messages

## Tool 2: insert_image_to_file (NEW!)

### Purpose
Insert an image reference with its public URL into a markdown or HTML file so it can be rendered in the frontend.

### Usage
```python
result = insert_image_to_file(
    image_file_name="chart.png",
    target_file_path="/report.md",
    alt_text="Sales Chart",  # optional
    position="end"  # optional: "start", "end", or line number
)
```

### What It Does

1. **Fetches the image URL** (using same logic as `get_image_url`)
2. **Creates appropriate reference**:
   - Markdown: `![Alt Text](url)`
   - HTML: `<img src="url" alt="Alt Text" />`
3. **Inserts into file** at specified position
4. **Creates file/directories** if they don't exist

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `image_file_name` | Yes | - | Name of image (e.g., 'chart.png') |
| `target_file_path` | Yes | - | Target file path (e.g., '/report.md') |
| `alt_text` | No | Auto-generated | Alternative text for image |
| `position` | No | "end" | "start", "end", or line number |

### Example Output

```
✓ Successfully inserted image into report.md

Image: sales_chart.png
URL: http://localhost:9000/helpudoc/workspace-123/charts/sales_chart.png
Reference: ![Sales Chart](http://localhost:9000/helpudoc/workspace-123/charts/sales_chart.png)
Position: end

The image will now be rendered when viewing the file in the frontend.
```

## Real-World Usage Scenarios

### Scenario 1: Data Agent Creates Chart

```python
# 1. Data agent generates a chart
generate_chart_config(chart_title="Revenue Analysis", ...)

# 2. User asks: "Add the revenue chart to my report"
# 3. Agent calls:
insert_image_to_file("Revenue_Analysis.png", "/analysis_report.md")

# Result: Chart is now visible in the report when viewed in frontend
```

### Scenario 2: User Uploads Image

```python
# 1. User uploads diagram.png via frontend
# 2. User asks: "Include the diagram in the technical section"
# 3. Agent calls:
insert_image_to_file(
    image_file_name="diagram.png",
    target_file_path="/sections/technical.md",
    alt_text="System Architecture",
    position="start"
)

# Result: Diagram appears at the top of the technical section
```

### Scenario 3: Gemini Generates Image

```python
# 1. User asks: "Create a flowchart and add it to the README"
# 2. Agent generates image:
gemini_image(prompt="Create a flowchart showing the process", output_name_prefix="flowchart")

# 3. Agent inserts it:
insert_image_to_file("flowchart-1.png", "/README.md", position="start")

# Result: Generated flowchart is now in the README
```

## Documentation Created

1. **`docs/get_image_url_tool.md`** - Documentation for get_image_url tool
2. **`docs/insert_image_to_file_tool.md`** - Comprehensive documentation for insert_image_to_file tool
3. **`docs/backend_integration_example.ts`** - Backend integration example
4. **`docs/GET_IMAGE_URL_README.md`** - Quick reference guide
5. **`test_get_image_url.py`** - Test script for get_image_url

## Key Features

### Both Tools
- ✅ Work with or without `.workspace_metadata.json`
- ✅ Automatic URL construction fallback
- ✅ Support for MinIO/S3 environment variables
- ✅ Comprehensive error handling
- ✅ Exact and partial filename matching

### insert_image_to_file Specific
- ✅ Auto-detects markdown vs HTML format
- ✅ Auto-generates alt text from filename
- ✅ Flexible positioning (start, end, line number)
- ✅ Creates files and directories as needed
- ✅ Proper formatting with newlines

## Environment Variables

Both tools respect these environment variables:

- `S3_ENDPOINT` or `MINIO_ENDPOINT` → Default: `http://localhost:9000`
- `S3_BUCKET_NAME` → Default: `helpudoc`

## Testing

### Test get_image_url
```bash
cd /Users/cmtest/Documents/HelpUDoc/agent
python test_get_image_url.py
```

### Manual Test insert_image_to_file

1. Create a test workspace with an image
2. Create a markdown file
3. Call the tool:
   ```python
   insert_image_to_file("test.png", "/test.md")
   ```
4. Verify the markdown file contains the image reference
5. Open in frontend to verify rendering

## Agent Behavior Examples

### Example 1: Simple Request

**User**: "Include sales_chart.png in report.md"

**Agent**:
```
I'll add the sales chart to your report.

[Calls insert_image_to_file("sales_chart.png", "/report.md")]

✓ Done! The sales chart has been added to report.md and will be visible when you view the report.
```

### Example 2: Specific Position

**User**: "Add the diagram to the top of the README"

**Agent**:
```
I'll insert the diagram at the beginning of the README.

[Calls insert_image_to_file("diagram.png", "/README.md", position="start")]

✓ The diagram is now at the top of your README file.
```

### Example 3: Custom Description

**User**: "Put revenue_chart.png in the analysis with the description 'Q4 Revenue Growth'"

**Agent**:
```
I'll add the revenue chart to the analysis with your description.

[Calls insert_image_to_file("revenue_chart.png", "/analysis.md", alt_text="Q4 Revenue Growth")]

✓ Added the revenue chart to analysis.md with the description "Q4 Revenue Growth".
```

## Optional Backend Enhancement

For more reliable URL retrieval, implement backend integration to maintain `.workspace_metadata.json`:

See `docs/backend_integration_example.ts` for implementation details.

When implemented, the backend should:
1. Create/update `.workspace_metadata.json` when files are uploaded to S3
2. Remove entries when files are deleted
3. Update entries when files are renamed

## Benefits

1. **Seamless Image Embedding**: Users can easily include images in documents
2. **Frontend Rendering**: Images render correctly with proper public URLs
3. **Format Flexibility**: Works with both markdown and HTML
4. **User-Friendly**: Natural language requests like "add chart to report"
5. **Automatic URL Management**: No need to manually copy/paste URLs
6. **Position Control**: Insert images exactly where needed
7. **Accessibility**: Auto-generated or custom alt text for images

## Comparison: get_image_url vs insert_image_to_file

| Feature | get_image_url | insert_image_to_file |
|---------|---------------|----------------------|
| **Purpose** | Get URL only | Get URL + Insert reference |
| **Returns** | URL string | Success message |
| **Modifies files** | No | Yes |
| **Use case** | Reference URL elsewhere | Embed in markdown/HTML |
| **Parameters** | 1 (filename) | 4 (filename, target, alt, position) |
| **Output format** | Plain text URL | Formatted image reference |

## When to Use Which Tool

### Use `get_image_url` when:
- You just need the URL for reference
- You want to manually construct the image reference
- You're using the URL in a non-standard format
- You need the URL for API calls or external use

### Use `insert_image_to_file` when:
- User asks to "include", "add", "insert" image into a file
- You want to embed image in markdown/HTML
- You need the image to render in the frontend
- You want automatic format detection and insertion

## Future Enhancements

1. **Batch insertion**: Insert multiple images at once
2. **Image sizing**: Support width/height parameters for HTML
3. **Caption support**: Add captions below images
4. **Smart positioning**: Auto-detect best insertion point
5. **URL validation**: Verify URL is accessible before inserting
6. **Relative paths**: Option to use relative vs absolute URLs
7. **Image gallery**: Create image galleries in markdown/HTML

## Summary

Two powerful tools are now available to the general agent:

1. **`get_image_url`**: Fetches public URLs for images
2. **`insert_image_to_file`**: Inserts images into markdown/HTML files with proper formatting

Together, these tools enable the agent to seamlessly work with images, making it easy for users to include charts, diagrams, and other images in their documents with simple natural language requests.

The tools work immediately without backend changes, and can be enhanced with optional backend integration for more reliable URL retrieval.
