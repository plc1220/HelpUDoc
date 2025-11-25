# Insert Image to File Tool

## Overview

The `insert_image_to_file` tool allows the general agent to insert image references (with public MinIO/S3 URLs) into markdown or HTML files so they can be rendered in the frontend. This tool automatically:

1. Fetches the public URL for the image
2. Creates the appropriate image reference (markdown or HTML format)
3. Inserts it into the target file at the specified position

## Use Case

When a user asks the agent to "include chart.png into report.md", the agent can use this tool to:
- Find the image file
- Get its public URL from MinIO/S3
- Insert the proper markdown/HTML reference into the file
- Ensure the image renders correctly in the frontend

## Configuration

### Tool Registration

```yaml
tools:
  - name: insert_image_to_file
    kind: builtin
    description: Insert image references into markdown or HTML files with public URLs
```

### Agent Assignment

Available to the `general-assistant` agent:

```yaml
agents:
  - name: general-assistant
    tools:
      - google_search
      - gemini_image
      - get_image_url
      - insert_image_to_file
```

## How It Works

### Step-by-Step Process

1. **Fetch Image URL**: 
   - First tries to get the URL from `.workspace_metadata.json`
   - Falls back to constructing URL from file location

2. **Determine File Format**:
   - Detects if target file is markdown (`.md`) or HTML (`.html`)
   - Creates appropriate image reference

3. **Insert Reference**:
   - Inserts at specified position (start, end, or line number)
   - Maintains proper formatting with newlines

4. **Save File**:
   - Writes updated content back to file
   - Creates parent directories if needed

### Image Reference Formats

**Markdown** (`.md`, `.markdown`):
```markdown
![Alt Text](http://localhost:9000/helpudoc/workspace-123/charts/chart.png)
```

**HTML** (`.html`, `.htm`):
```html
<img src="http://localhost:9000/helpudoc/workspace-123/charts/chart.png" alt="Alt Text" />
```

## Usage Examples

### Example 1: Insert chart into markdown report

```python
# User: "Include sales_chart.png into report.md"
result = insert_image_to_file(
    image_file_name="sales_chart.png",
    target_file_path="/report.md"
)

# Output:
"""
✓ Successfully inserted image into report.md

Image: sales_chart.png
URL: http://localhost:9000/helpudoc/workspace-123/charts/sales_chart.png
Reference: ![Sales Chart](http://localhost:9000/helpudoc/workspace-123/charts/sales_chart.png)
Position: end

The image will now be rendered when viewing the file in the frontend.
"""
```

### Example 2: Insert diagram at the start of HTML file

```python
# User: "Add diagram.png to the top of index.html"
result = insert_image_to_file(
    image_file_name="diagram.png",
    target_file_path="/index.html",
    alt_text="System Architecture Diagram",
    position="start"
)

# Output:
"""
✓ Successfully inserted image into index.html

Image: diagram.png
URL: http://localhost:9000/helpudoc/workspace-123/diagram.png
Reference: <img src="http://localhost:9000/helpudoc/workspace-123/diagram.png" alt="System Architecture Diagram" />
Position: start

The image will now be rendered when viewing the file in the frontend.
"""
```

### Example 3: Insert at specific line number

```python
# User: "Insert chart.png at line 10 in analysis.md"
result = insert_image_to_file(
    image_file_name="chart.png",
    target_file_path="/analysis.md",
    alt_text="Revenue Analysis",
    position="10"
)
```

### Example 4: Custom alt text

```python
# User: "Add revenue_chart.png to report.md with description 'Q4 Revenue Growth'"
result = insert_image_to_file(
    image_file_name="revenue_chart.png",
    target_file_path="/report.md",
    alt_text="Q4 Revenue Growth"
)
```

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image_file_name` | string | Yes | - | Name of the image file (e.g., 'chart.png') |
| `target_file_path` | string | Yes | - | Path to target file relative to workspace root (e.g., '/report.md') |
| `alt_text` | string | No | Filename | Alternative text for the image |
| `position` | string | No | "end" | Where to insert: 'start', 'end', or line number |

## Position Options

- **`"end"`** (default): Appends image to the end of the file
- **`"start"`**: Prepends image to the beginning of the file
- **`"10"`** (line number): Inserts at specific line (0-indexed)

## Auto-Generated Alt Text

If no `alt_text` is provided, the tool automatically generates it from the filename:

- `sales_chart.png` → "Sales Chart"
- `revenue-analysis.png` → "Revenue Analysis"
- `diagram_2024.png` → "Diagram 2024"

## Common Use Cases

### 1. Data Agent Reports

After generating charts, insert them into analysis reports:

```python
# Generate chart
generate_chart_config(chart_title="Sales Trends", ...)

# Insert into report
insert_image_to_file("Sales_Trends.png", "/analysis_report.md")
```

### 2. Proposal Documents

Add diagrams to proposal sections:

```python
# User: "Add the architecture diagram to the technical section"
insert_image_to_file(
    image_file_name="architecture.png",
    target_file_path="/sections/technical.md",
    alt_text="System Architecture"
)
```

### 3. Documentation

Include screenshots or diagrams in documentation:

```python
# User: "Put the workflow diagram in the README"
insert_image_to_file("workflow.png", "/README.md", position="start")
```

### 4. HTML Dashboards

Add charts to HTML dashboards:

```python
insert_image_to_file(
    image_file_name="dashboard_chart.png",
    target_file_path="/dashboard.html",
    alt_text="Performance Dashboard"
)
```

## Error Handling

The tool handles various error scenarios:

1. **Image not found**:
   ```
   Error: Image file 'chart.png' not found in workspace.
   ```

2. **Invalid line number**:
   ```
   Error: Line number 100 is out of range (file has 50 lines)
   ```

3. **File system errors**: Returns detailed error with traceback

## Integration with Other Tools

### Combined Workflow

```python
# 1. Generate image with Gemini
gemini_image(prompt="Create a sales chart", output_name_prefix="sales_chart")

# 2. Insert into markdown file
insert_image_to_file("sales_chart-1.png", "/report.md")

# Result: Image is generated and automatically included in the report
```

### With Data Agent

```python
# 1. Generate chart from data
generate_chart_config(chart_title="Revenue Analysis", python_code="...")

# 2. Insert into report
insert_image_to_file("Revenue_Analysis.png", "/reports/analysis.md")
```

## File Creation

If the target file doesn't exist, the tool will:
- Create the file
- Create parent directories if needed
- Insert the image reference

## Environment Variables

Uses the same environment variables as `get_image_url`:

- `S3_ENDPOINT` or `MINIO_ENDPOINT`: MinIO endpoint (default: `http://localhost:9000`)
- `S3_BUCKET_NAME`: S3 bucket name (default: `helpudoc`)

## Best Practices

1. **Use descriptive alt text**: Helps with accessibility and SEO
2. **Insert at logical positions**: Use line numbers for precise placement
3. **Check file format**: Tool auto-detects but verify markdown vs HTML
4. **Verify image exists**: Tool will error if image not found
5. **Use relative paths**: Always use paths relative to workspace root

## Limitations

1. Only supports markdown and HTML formats
2. Inserts one image at a time (not batch operations)
3. Requires image to exist in workspace
4. Line number insertion is 0-indexed

## Future Enhancements

1. **Batch insertion**: Insert multiple images at once
2. **Image sizing**: Support width/height parameters
3. **Caption support**: Add captions below images
4. **Smart positioning**: Auto-detect best insertion point based on context
5. **Image validation**: Verify image is accessible before inserting
6. **Markdown table support**: Insert images in table cells
7. **Relative path URLs**: Option to use relative paths instead of absolute URLs

## Comparison with get_image_url

| Feature | `get_image_url` | `insert_image_to_file` |
|---------|-----------------|------------------------|
| Purpose | Get URL only | Get URL + Insert into file |
| Returns | URL string | Success message |
| Modifies files | No | Yes |
| Use case | Reference URL elsewhere | Embed in markdown/HTML |

## Example Agent Conversation

**User**: "Include the sales chart in my report"

**Agent**: 
```
I'll insert the sales chart into your report.

[Calls insert_image_to_file("sales_chart.png", "/report.md")]

✓ Successfully inserted the sales chart into report.md! 
The image will now be visible when you view the report in the frontend.
```

**User**: "Add the diagram to the top of the technical section"

**Agent**:
```
I'll add the diagram at the beginning of the technical section.

[Calls insert_image_to_file("diagram.png", "/sections/technical.md", position="start")]

✓ Done! The diagram is now at the top of the technical section.
```
