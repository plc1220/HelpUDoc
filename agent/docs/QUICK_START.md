# get_image_url - Quick Reference

## 🎯 Purpose

Fetch public MinIO/S3 URLs for images. The agent then uses DeepAgents' built-in `edit_file` to insert the image reference.

---

## 🚀 Usage

```python
get_image_url("chart.png")
# Returns: "Public URL: http://localhost:9000/helpudoc/workspace-123/charts/chart.png"
```

---

## 💡 How Agent Uses It

**User**: "Include sales_chart.png in report.md"

**Agent's Steps**:
1. Call `get_image_url("sales_chart.png")` → Get URL
2. Call `edit_file("/report.md", ...)` → Insert `![Sales Chart](url)`
3. Done! ✅

---

## ✨ Why This Approach?

DeepAgents already has:
- ✅ `edit_file` - Edit files
- ✅ `read_file` - Read files  
- ✅ `write_file` - Write files
- ✅ `grep` - Search files
- ✅ `ls`, `glob` - List files

**We only need to provide the MinIO URL!**

---

## 📦 What's Included

### Single Tool
- **`get_image_url`** - Fetch MinIO/S3 public URLs

### Configuration
- ✅ Registered in `config/runtime.yaml`
- ✅ Added to `general-assistant` agent
- ✅ Implementation in `helpudoc_agent/tools_and_schemas.py`

---

## 🧪 Test

```bash
python test_get_image_url.py
```

---

## 📚 Documentation

- **`docs/get_image_url_tool.md`** - Full documentation
- **`docs/FINAL_IMPLEMENTATION.md`** - Implementation details
- **`docs/backend_integration_example.ts`** - Backend integration

---

## 🌍 Environment Variables

- `S3_ENDPOINT` or `MINIO_ENDPOINT` → `http://localhost:9000`
- `S3_BUCKET_NAME` → `helpudoc`

---

## ✅ Ready to Use!

The tool is implemented and ready. The agent can now handle requests like:
- "Include chart.png in report.md"
- "Add diagram to README"
- "Put image in dashboard.html"

**Simple, focused, and leverages DeepAgents' built-in capabilities!** 🎉
