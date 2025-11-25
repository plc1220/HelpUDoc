# Image Tools - Quick Reference Guide

## 🎯 Purpose

Enable the general agent to work with images stored in MinIO/S3, specifically to **insert image references into markdown/HTML files** so they render in the frontend.

## 🛠️ Two Tools Available

### 1. `get_image_url` - Get URL Only
```python
get_image_url("chart.png")
# Returns: "Public URL: http://localhost:9000/helpudoc/workspace-123/chart.png"
```

### 2. `insert_image_to_file` - Insert into File ⭐
```python
insert_image_to_file(
    image_file_name="chart.png",
    target_file_path="/report.md"
)
# Inserts: ![Chart](http://localhost:9000/helpudoc/workspace-123/chart.png)
```

## 🚀 Quick Start

### User Request Examples

**User**: "Include sales_chart.png in report.md"
```python
insert_image_to_file("sales_chart.png", "/report.md")
```

**User**: "Add diagram.png to the top of README"
```python
insert_image_to_file("diagram.png", "/README.md", position="start")
```

**User**: "Put revenue chart in analysis.md with description 'Q4 Growth'"
```python
insert_image_to_file("revenue_chart.png", "/analysis.md", alt_text="Q4 Growth")
```

## 📋 Parameters

### insert_image_to_file

| Parameter | Required | Default | Example |
|-----------|----------|---------|---------|
| `image_file_name` | ✅ Yes | - | `"chart.png"` |
| `target_file_path` | ✅ Yes | - | `"/report.md"` |
| `alt_text` | ❌ No | Auto-generated | `"Sales Chart"` |
| `position` | ❌ No | `"end"` | `"start"`, `"end"`, `"10"` |

## 📝 Output Formats

### Markdown Files (.md)
```markdown
![Alt Text](http://localhost:9000/helpudoc/workspace-123/chart.png)
```

### HTML Files (.html)
```html
<img src="http://localhost:9000/helpudoc/workspace-123/chart.png" alt="Alt Text" />
```

## 🎨 Position Options

- `"end"` (default) - Append to end of file
- `"start"` - Prepend to beginning of file  
- `"10"` (number) - Insert at line 10

## ✅ What It Does

1. ✅ Finds the image in the workspace
2. ✅ Gets the public MinIO/S3 URL
3. ✅ Creates proper markdown/HTML reference
4. ✅ Inserts at specified position
5. ✅ Creates file/directories if needed
6. ✅ Returns success confirmation

## 🔧 Configuration

Already configured and ready to use!

- ✅ Tool registered in `config/agents.yaml`
- ✅ Added to `general-assistant` agent
- ✅ Implementation in `helpudoc_agent/tools_and_schemas.py`

## 🧪 Testing

### Test insert_image_to_file
```bash
cd /Users/cmtest/Documents/HelpUDoc/agent
python test_insert_image_to_file.py
```

### Test get_image_url
```bash
cd /Users/cmtest/Documents/HelpUDoc/agent
python test_get_image_url.py
```

## 💡 Common Workflows

### Workflow 1: Data Agent Chart
```python
# 1. Generate chart
generate_chart_config(chart_title="Sales", ...)

# 2. Insert into report
insert_image_to_file("Sales.png", "/report.md")
```

### Workflow 2: Gemini Image
```python
# 1. Generate image
gemini_image(prompt="Create flowchart", output_name_prefix="flow")

# 2. Insert into README
insert_image_to_file("flow-1.png", "/README.md", position="start")
```

### Workflow 3: User Upload
```python
# User uploads diagram.png via frontend
# User asks: "Add diagram to technical section"

insert_image_to_file("diagram.png", "/sections/technical.md")
```

## 🌍 Environment Variables

- `S3_ENDPOINT` or `MINIO_ENDPOINT` → Default: `http://localhost:9000`
- `S3_BUCKET_NAME` → Default: `helpudoc`

## 📚 Documentation

- **`docs/insert_image_to_file_tool.md`** - Full documentation for insert_image_to_file
- **`docs/get_image_url_tool.md`** - Full documentation for get_image_url
- **`docs/IMPLEMENTATION_SUMMARY.md`** - Technical implementation details
- **`docs/backend_integration_example.ts`** - Backend integration guide

## ❓ When to Use Which Tool

### Use `insert_image_to_file` when:
- ✅ User wants to "include", "add", "insert" image into a file
- ✅ Need image to render in frontend
- ✅ Working with markdown or HTML files

### Use `get_image_url` when:
- ✅ Just need the URL for reference
- ✅ Want to manually construct image reference
- ✅ Using URL in non-standard format

## 🎯 Example Agent Conversations

### Example 1
**User**: "Include the sales chart in my report"

**Agent**: 
```
I'll add the sales chart to your report.

✓ Successfully inserted sales_chart.png into report.md!
The image will be visible when you view the report.
```

### Example 2
**User**: "Put the diagram at the top of the technical doc"

**Agent**:
```
I'll insert the diagram at the beginning of the technical document.

✓ Done! The diagram is now at the top of technical.md.
```

### Example 3
**User**: "Add revenue chart to analysis with description 'Q4 Revenue Growth'"

**Agent**:
```
I'll add the revenue chart with your description.

✓ Added revenue_chart.png to analysis.md with the description "Q4 Revenue Growth".
```

## ⚠️ Error Handling

### Image not found
```
Error: Image file 'chart.png' not found in workspace.
```

### Invalid line number
```
Error: Line number 100 is out of range (file has 50 lines)
```

## 🎁 Key Benefits

1. **Seamless Integration** - Natural language requests work perfectly
2. **Frontend Rendering** - Images render correctly with public URLs
3. **Format Smart** - Auto-detects markdown vs HTML
4. **Position Control** - Insert exactly where needed
5. **Auto Alt Text** - Generates from filename if not provided
6. **File Creation** - Creates files/directories automatically

## 🚀 Ready to Use!

Both tools are fully implemented and ready for production use. The agent can now handle user requests to include images in documents seamlessly!

---

**Need more details?** Check the comprehensive documentation in the `docs/` folder.
