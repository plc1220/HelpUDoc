# Get Image URL Tool

## Overview

The `get_image_url` tool allows the general agent to fetch public URLs for images (PNG, JPG, etc.) that are stored in MinIO/S3. This tool is particularly useful when the agent needs to reference uploaded images in responses or share image links with users.

## Configuration

### Tool Registration

The tool is registered in `/agent/config/runtime.yaml`:

```yaml
tools:
  - name: get_image_url
    kind: builtin
    description: Get public URLs for images stored in MinIO/S3
```

### Agent Assignment

The tool is available to the `general-assistant` agent:

```yaml
agents:
  - name: general-assistant
    display_name: General Assistant
    tools:
      - google_search
      - gemini_image
      - get_image_url
```

## How It Works

The tool uses a two-tier approach to find image URLs:

### 1. Metadata File Approach (Preferred)

If a `.workspace_metadata.json` file exists in the workspace root, the tool reads file information from it:

```json
{
  "files": [
    {
      "name": "chart.png",
      "publicUrl": "http://localhost:9000/helpudoc/workspace-123/charts/chart.png",
      "mimeType": "image/png",
      "storageType": "s3"
    }
  ]
}
```

### 2. File System Fallback

If no metadata file exists, the tool:
1. Searches the workspace for the file
2. Constructs a potential MinIO URL based on:
   - Environment variables (`S3_ENDPOINT`, `MINIO_ENDPOINT`, `S3_BUCKET_NAME`)
   - Default values (endpoint: `http://localhost:9000`, bucket: `helpudoc`)
3. Returns the constructed URL with a note that it may not be accessible if the file hasn't been uploaded

## Usage Examples

### Example 1: Get URL for a specific image

```python
# Agent calls the tool
result = get_image_url("chart.png")

# Possible responses:
# Success with metadata:
"""
File: chart.png
Public URL: http://localhost:9000/helpudoc/workspace-123/charts/chart.png
MIME Type: image/png
"""

# Success with file system fallback:
"""
File found: chart.png
Local path: /charts/chart.png
Potential public URL: http://localhost:9000/helpudoc/workspace-123/charts/chart.png

Note: This URL is constructed based on the file location. If the file hasn't been uploaded to MinIO/S3 yet, the URL may not be accessible.
"""

# File not found:
"""
Error: No file found with name 'chart.png' in the workspace.
"""
```

### Example 2: Partial filename match

```python
# If exact match fails, the tool tries partial matching
result = get_image_url("chart")

# Might match "sales_chart.png", "chart_2024.png", etc.
```

## Environment Variables

The tool respects the following environment variables:

- `S3_ENDPOINT` or `MINIO_ENDPOINT`: MinIO/S3 endpoint URL (default: `http://localhost:9000`)
- `S3_BUCKET_NAME`: S3 bucket name (default: `helpudoc`)

## Integration with Backend

### Creating the Metadata File (Optional Enhancement)

To enable the metadata file approach, the backend can create/update `.workspace_metadata.json` when files are uploaded:

```typescript
// In fileService.ts, after uploading to S3
const metadataPath = path.join(workspacePath, '.workspace_metadata.json');
let metadata = { files: [] };

if (fs.existsSync(metadataPath)) {
  metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
}

metadata.files.push({
  name: fileName,
  publicUrl: result.publicUrl,
  mimeType: mimeType,
  storageType: 's3'
});

fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
```

## Error Handling

The tool handles various error scenarios:

1. **File not found**: Returns a clear error message
2. **No public URL**: Indicates if the file is stored locally and needs to be uploaded
3. **Exception during execution**: Returns the error message with traceback for debugging

## Use Cases

1. **Data Agent**: After generating a chart, get its public URL to include in reports
2. **General Assistant**: Share image links with users
3. **Proposal Agent**: Reference uploaded diagrams or images in proposals
4. **Documentation**: Include image URLs in generated markdown files

## Limitations

1. The tool searches within the current workspace only
2. Partial matching returns the first match found
3. Constructed URLs (fallback mode) may not be accessible if files haven't been uploaded to MinIO/S3
4. The metadata file approach requires backend integration to maintain the `.workspace_metadata.json` file

## Future Enhancements

1. **Backend Integration**: Automatically maintain `.workspace_metadata.json` when files are uploaded
2. **Batch URL Retrieval**: Support getting URLs for multiple files at once
3. **URL Validation**: Check if the URL is actually accessible before returning
4. **Signed URLs**: Support generating temporary signed URLs for private files
5. **Image Metadata**: Include additional information like dimensions, file size, etc.
