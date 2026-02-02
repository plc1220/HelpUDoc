# Final Implementation: get_image_url Tool

## ✅ Simplified Approach

After reviewing DeepAgents' built-in capabilities, we've simplified the implementation to **only provide `get_image_url`**. 

### Why?

DeepAgents already provides comprehensive file system tools:
- ✅ `ls` - list files
- ✅ `read_file` - read file contents
- ✅ `write_file` - write to files
- ✅ **`edit_file`** - edit files ⭐
- ✅ `glob` - pattern matching
- ✅ `grep` - search in files

**The agent can use `edit_file` to insert image references itself!**

---

## 🎯 What We Provide

### Single Tool: `get_image_url`

**Purpose**: Fetch the public MinIO/S3 URL for an image file

**Usage**:
```python
url = get_image_url("chart.png")
# Returns: "Public URL: http://localhost:9000/helpudoc/workspace-123/charts/chart.png"
```

---

## 💡 How It Works in Practice

### User Request: "Include sales_chart.png in report.md"

**Agent's Workflow**:

1. **Get the image URL**:
   ```python
   url_result = get_image_url("sales_chart.png")
   # Returns: "Public URL: http://localhost:9000/helpudoc/ws-123/charts/sales_chart.png"
   ```

2. **Use DeepAgents' built-in `edit_file` to insert the reference**:
   ```python
   edit_file(
       path="/report.md",
       instructions="Append the following markdown image reference at the end: ![Sales Chart](http://localhost:9000/helpudoc/ws-123/charts/sales_chart.png)"
   )
   ```

3. **Done!** The image reference is now in the file and will render in the frontend.

---

## 📦 What Was Implemented

### Files Modified

1. **`helpudoc_agent/tools_and_schemas.py`**
   - Added `_build_get_image_url_tool()` method
   - Implements URL fetching with metadata file support and fallback

2. **`config/runtime.yaml`**
   - Registered `get_image_url` tool
   - Added to `general-assistant` agent

---

## 🔧 get_image_url Tool Details

### Features

- **Metadata File Support**: Reads from `.workspace_metadata.json` if available
- **Fallback Mode**: Searches workspace and constructs URL from file location
- **Exact & Partial Matching**: Finds files by exact name or partial match
- **Environment-Aware**: Uses `S3_ENDPOINT`, `MINIO_ENDPOINT`, `S3_BUCKET_NAME`
- **Comprehensive Error Handling**: Clear error messages

### How It Works

```
get_image_url("chart.png")
    │
    ├─► Check .workspace_metadata.json
    │       ├─► Found → Return publicUrl ✓
    │       └─► Not found → Continue to fallback
    │
    ├─► Search workspace filesystem
    │       ├─► Found file → Construct URL from location
    │       └─► Not found → Return error
    │
    └─► Return URL or error message
```

---

## 🎨 Example Agent Conversations

### Example 1: Simple Request

**User**: "Include sales_chart.png in report.md"

**Agent**:
```
I'll add the sales chart to your report.

[Calls get_image_url("sales_chart.png")]
[Gets URL: http://localhost:9000/helpudoc/ws-123/charts/sales_chart.png]

[Calls edit_file("/report.md", instructions="Append: ![Sales Chart](http://...)")]

✓ Done! The sales chart has been added to report.md and will be visible when you view the report.
```

### Example 2: Custom Position

**User**: "Add diagram.png to the top of README"

**Agent**:
```
I'll insert the diagram at the beginning of the README.

[Calls get_image_url("diagram.png")]
[Gets URL: http://localhost:9000/helpudoc/ws-123/diagram.png]

[Calls edit_file("/README.md", instructions="Prepend: ![Diagram](http://...)")]

✓ The diagram is now at the top of your README file.
```

### Example 3: HTML File

**User**: "Put chart.png in dashboard.html"

**Agent**:
```
I'll add the chart to your dashboard.

[Calls get_image_url("chart.png")]
[Gets URL: http://localhost:9000/helpudoc/ws-123/chart.png]

[Calls edit_file("/dashboard.html", instructions="Add: <img src='http://...' alt='Chart' />")]

✓ The chart has been added to dashboard.html.
```

---

## 🚀 Benefits of This Approach

### 1. **Simpler Implementation**
- Only one tool instead of two
- Less code to maintain
- Leverages DeepAgents' built-in capabilities

### 2. **More Flexible**
- Agent can decide how to insert the image
- Can handle complex editing scenarios
- Works with any file format

### 3. **Better Agent Reasoning**
- Agent understands the full context
- Can make intelligent decisions about placement
- Can combine with other file operations

### 4. **Consistent with DeepAgents**
- Uses the same file editing paradigm
- No custom file manipulation logic
- Follows DeepAgents best practices

---

## 📚 Documentation

- **`docs/get_image_url_tool.md`** - Comprehensive tool documentation
- **`docs/backend_integration_example.ts`** - Optional backend integration
- **`test_get_image_url.py`** - Test script

---

## 🧪 Testing

```bash
cd /Users/cmtest/Documents/HelpUDoc/agent
python test_get_image_url.py
```

---

## 🌍 Environment Variables

- `S3_ENDPOINT` or `MINIO_ENDPOINT` → Default: `http://localhost:9000`
- `S3_BUCKET_NAME` → Default: `helpudoc`

---

## 📝 Optional Enhancement

For more reliable URL retrieval, implement backend integration to maintain `.workspace_metadata.json`:

See `docs/backend_integration_example.ts` for implementation details.

---

## ✨ Summary

We provide **one focused tool** (`get_image_url`) that does one thing well: **fetch MinIO/S3 public URLs**.

The agent uses this in combination with DeepAgents' built-in `edit_file` tool to handle user requests like "include chart.png in report.md".

This approach is:
- ✅ **Simpler** - Less code, easier to maintain
- ✅ **More flexible** - Agent can handle any editing scenario
- ✅ **Better integrated** - Uses DeepAgents' native capabilities
- ✅ **More powerful** - Agent can reason about file edits intelligently

---

## 🎯 Key Takeaway

**We don't need a dedicated `insert_image_to_file` tool because DeepAgents already has `edit_file`.**

**We only need `get_image_url` to provide the MinIO/S3 public URL that the agent can then use with `edit_file`.**

This is the right level of abstraction! 🎉
