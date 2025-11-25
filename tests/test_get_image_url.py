#!/usr/bin/env python3
"""
Test script for the get_image_url tool

This script tests the get_image_url tool functionality without running the full agent.
"""

import json
import os
import sys
from pathlib import Path

# Add the agent package to the path
agent_path = Path(__file__).resolve().parent.parent / "helpudoc_agent"
sys.path.insert(0, str(agent_path.parent))

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools_and_schemas import ToolFactory
from helpudoc_agent.configuration import Settings, load_settings


def create_test_workspace(workspace_id: str = "test-workspace") -> WorkspaceState:
    """Create a test workspace with some sample files."""
    test_root = Path("/tmp/helpudoc-test") / workspace_id
    test_root.mkdir(parents=True, exist_ok=True)
    
    # Create some test image files
    charts_dir = test_root / "charts"
    charts_dir.mkdir(exist_ok=True)
    
    # Create dummy image files
    (charts_dir / "sales_chart.png").write_text("fake png data")
    (charts_dir / "revenue_chart.png").write_text("fake png data")
    (test_root / "diagram.jpg").write_text("fake jpg data")
    
    return WorkspaceState(workspace_id=workspace_id, root_path=test_root)


def create_test_metadata(workspace_state: WorkspaceState):
    """Create a test .workspace_metadata.json file."""
    metadata = {
        "files": [
            {
                "name": "sales_chart.png",
                "publicUrl": "http://localhost:9000/helpudoc/test-workspace/charts/sales_chart.png",
                "mimeType": "image/png",
                "storageType": "s3"
            },
            {
                "name": "diagram.jpg",
                "publicUrl": "http://localhost:9000/helpudoc/test-workspace/diagram.jpg",
                "mimeType": "image/jpeg",
                "storageType": "s3"
            },
            {
                "name": "local_file.png",
                "publicUrl": "",
                "mimeType": "image/png",
                "storageType": "local"
            }
        ],
        "lastUpdated": "2025-11-24T08:00:00Z"
    }
    
    metadata_file = workspace_state.root_path / ".workspace_metadata.json"
    metadata_file.write_text(json.dumps(metadata, indent=2))
    print(f"✓ Created metadata file: {metadata_file}")


def test_get_image_url_with_metadata(tool, workspace_state: WorkspaceState):
    """Test the tool with metadata file present."""
    print("\n" + "="*60)
    print("TEST 1: With Metadata File")
    print("="*60)
    
    # Test 1: Exact match with public URL
    print("\n1. Testing exact match with public URL (sales_chart.png):")
    result = tool.invoke({"file_name": "sales_chart.png"})
    print(result)
    
    # Test 2: Exact match with public URL (diagram.jpg)
    print("\n2. Testing exact match with public URL (diagram.jpg):")
    result = tool.invoke({"file_name": "diagram.jpg"})
    print(result)
    
    # Test 3: Local file without public URL
    print("\n3. Testing local file without public URL (local_file.png):")
    result = tool.invoke({"file_name": "local_file.png"})
    print(result)
    
    # Test 4: Partial match
    print("\n4. Testing partial match (sales):")
    result = tool.invoke({"file_name": "sales"})
    print(result)
    
    # Test 5: File not found
    print("\n5. Testing file not found (nonexistent.png):")
    result = tool.invoke({"file_name": "nonexistent.png"})
    print(result)


def test_get_image_url_without_metadata(tool, workspace_state: WorkspaceState):
    """Test the tool without metadata file (fallback mode)."""
    print("\n" + "="*60)
    print("TEST 2: Without Metadata File (Fallback Mode)")
    print("="*60)
    
    # Remove metadata file
    metadata_file = workspace_state.root_path / ".workspace_metadata.json"
    if metadata_file.exists():
        metadata_file.unlink()
        print("✓ Removed metadata file")
    
    # Test 1: Exact match - constructs URL
    print("\n1. Testing exact match with constructed URL (sales_chart.png):")
    result = tool.invoke({"file_name": "sales_chart.png"})
    print(result)
    
    # Test 2: Partial match
    print("\n2. Testing partial match (revenue):")
    result = tool.invoke({"file_name": "revenue"})
    print(result)
    
    # Test 3: File not found
    print("\n3. Testing file not found (nonexistent.png):")
    result = tool.invoke({"file_name": "nonexistent.png"})
    print(result)


def main():
    """Run all tests."""
    print("="*60)
    print("Testing get_image_url Tool")
    print("="*60)
    
    # Create test workspace
    print("\nSetting up test workspace...")
    workspace_state = create_test_workspace()
    print(f"✓ Created test workspace at: {workspace_state.root_path}")
    
    # Create test files
    print("✓ Created test image files")
    
    # Load settings (we need this to create the ToolFactory)
    # For testing, we'll create a minimal mock
    class MockSettings:
        def get_tool(self, name):
            class MockToolConfig:
                name = "get_image_url"
                kind = "builtin"
            return MockToolConfig()
    
    class MockSourceTracker:
        pass
    
    class MockGeminiManager:
        pass
    
    # Create ToolFactory
    settings = MockSettings()
    source_tracker = MockSourceTracker()
    gemini_manager = MockGeminiManager()
    
    factory = ToolFactory(settings, source_tracker, gemini_manager)
    
    # Build the get_image_url tool
    tool = factory._build_get_image_url_tool(workspace_state)
    print(f"✓ Created get_image_url tool")
    
    # Test with metadata
    create_test_metadata(workspace_state)
    test_get_image_url_with_metadata(tool, workspace_state)
    
    # Test without metadata (fallback)
    test_get_image_url_without_metadata(tool, workspace_state)
    
    print("\n" + "="*60)
    print("All tests completed!")
    print("="*60)
    
    # Cleanup
    print(f"\nTest workspace location: {workspace_state.root_path}")
    print("You can manually inspect the files or delete the directory.")


if __name__ == "__main__":
    main()
