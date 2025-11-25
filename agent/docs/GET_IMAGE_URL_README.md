# get_image_url Tool - Quick Reference

## What is it?

A new tool for the general agent to fetch public URLs of images stored in MinIO/S3.

## Quick Start

### 1. The tool is already configured and ready to use!

The `get_image_url` tool has been added to:
- Tool registry in `config/agents.yaml`
- General assistant agent's available tools
- Implementation in `helpudoc_agent/tools_and_schemas.py`

### 2. How to use it

From the general agent, simply call:

```python
get_image_url("chart.png")
```

### 3. What it returns

**With metadata file:**
```
File: chart.png
Public URL: http://localhost:9000/helpudoc/workspace-123/charts/chart.png
MIME Type: image/png
```

**Without metadata file (fallback):**
```
File found: chart.png
Local path: /charts/chart.png
Potential public URL: http://localhost:9000/helpudoc/workspace-123/charts/chart.png

Note: This URL is constructed based on the file location. 
If the file hasn't been uploaded to MinIO/S3 yet, the URL may not be accessible.
```

## Test the Implementation

Run the test script:

```bash
cd /Users/cmtest/Documents/HelpUDoc/agent
python test_get_image_url.py
```

This will:
- Create a test workspace with sample images
- Test with metadata file (preferred approach)
- Test without metadata file (fallback approach)
- Show all possible scenarios and outputs

## Files Modified

1. **`helpudoc_agent/tools_and_schemas.py`** - Tool implementation
2. **`config/agents.yaml`** - Tool registration and agent assignment

## Documentation

- **`docs/get_image_url_tool.md`** - Comprehensive documentation
- **`docs/backend_integration_example.ts`** - Backend integration example
- **`docs/IMPLEMENTATION_SUMMARY.md`** - Implementation details

## Environment Variables

The tool uses these environment variables (with defaults):

- `S3_ENDPOINT` or `MINIO_ENDPOINT` → Default: `http://localhost:9000`
- `S3_BUCKET_NAME` → Default: `helpudoc`

## Optional Enhancement

For more reliable results, implement backend integration to maintain `.workspace_metadata.json`:

See `docs/backend_integration_example.ts` for implementation details.

## Use Cases

1. **Data Agent**: Get URLs for generated charts
2. **General Assistant**: Share image links with users
3. **Proposal Agent**: Reference uploaded diagrams
4. **Documentation**: Include image URLs in markdown

## Example Usage in Agent

```python
# After generating a chart
chart_result = generate_chart_config(...)

# Get the public URL
url_result = get_image_url("sales_chart.png")

# Use in response
response = f"I've created a sales chart. You can view it here: {url_result}"
```

## Need Help?

- Check `docs/get_image_url_tool.md` for detailed documentation
- Run `python test_get_image_url.py` to see it in action
- See `docs/IMPLEMENTATION_SUMMARY.md` for technical details
