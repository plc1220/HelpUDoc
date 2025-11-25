#!/usr/bin/env python3
"""
Test script for the insert_image_to_file tool

This script demonstrates how the insert_image_to_file tool works.
"""

import json
import sys
from pathlib import Path

# Add the agent package to the path
agent_path = Path(__file__).resolve().parent.parent / "helpudoc_agent"
sys.path.insert(0, str(agent_path.parent))

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools_and_schemas import ToolFactory


def create_test_workspace(workspace_id: str = "test-insert-image") -> WorkspaceState:
    """Create a test workspace with sample files."""
    test_root = Path("/tmp/helpudoc-test") / workspace_id
    test_root.mkdir(parents=True, exist_ok=True)
    
    # Create test image files
    charts_dir = test_root / "charts"
    charts_dir.mkdir(exist_ok=True)
    (charts_dir / "sales_chart.png").write_text("fake png data")
    (charts_dir / "revenue_chart.png").write_text("fake png data")
    
    # Create test markdown file
    (test_root / "existing_report.md").write_text(
        "# Sales Report\n\n"
        "This is an existing report.\n\n"
        "## Analysis\n\n"
        "Some analysis here.\n"
    )
    
    # Create metadata file
    metadata = {
        "files": [
            {
                "name": "sales_chart.png",
                "publicUrl": "http://localhost:9000/helpudoc/test-insert-image/charts/sales_chart.png",
                "mimeType": "image/png",
                "storageType": "s3"
            }
        ]
    }
    (test_root / ".workspace_metadata.json").write_text(json.dumps(metadata, indent=2))
    
    return WorkspaceState(workspace_id=workspace_id, root_path=test_root)


def test_insert_to_new_markdown(tool, workspace_state: WorkspaceState):
    """Test inserting image into a new markdown file."""
    print("\n" + "="*70)
    print("TEST 1: Insert image into NEW markdown file")
    print("="*70)
    
    result = tool.invoke({
        "image_file_name": "sales_chart.png",
        "target_file_path": "/new_report.md"
    })
    print(result)
    
    # Show the file content
    file_path = workspace_state.root_path / "new_report.md"
    if file_path.exists():
        print("\n--- File Content ---")
        print(file_path.read_text())


def test_insert_to_existing_markdown(tool, workspace_state: WorkspaceState):
    """Test inserting image into existing markdown file."""
    print("\n" + "="*70)
    print("TEST 2: Insert image into EXISTING markdown file (at end)")
    print("="*70)
    
    result = tool.invoke({
        "image_file_name": "revenue_chart.png",
        "target_file_path": "/existing_report.md",
        "alt_text": "Revenue Analysis Chart"
    })
    print(result)
    
    # Show the file content
    file_path = workspace_state.root_path / "existing_report.md"
    if file_path.exists():
        print("\n--- File Content ---")
        print(file_path.read_text())


def test_insert_at_start(tool, workspace_state: WorkspaceState):
    """Test inserting image at the start of a file."""
    print("\n" + "="*70)
    print("TEST 3: Insert image at START of file")
    print("="*70)
    
    result = tool.invoke({
        "image_file_name": "sales_chart.png",
        "target_file_path": "/report_with_header.md",
        "position": "start"
    })
    print(result)
    
    # Show the file content
    file_path = workspace_state.root_path / "report_with_header.md"
    if file_path.exists():
        print("\n--- File Content ---")
        print(file_path.read_text())


def test_insert_html(tool, workspace_state: WorkspaceState):
    """Test inserting image into HTML file."""
    print("\n" + "="*70)
    print("TEST 4: Insert image into HTML file")
    print("="*70)
    
    # Create a simple HTML file first
    html_file = workspace_state.root_path / "dashboard.html"
    html_file.write_text(
        "<!DOCTYPE html>\n"
        "<html>\n"
        "<head><title>Dashboard</title></head>\n"
        "<body>\n"
        "<h1>Sales Dashboard</h1>\n"
        "</body>\n"
        "</html>\n"
    )
    
    result = tool.invoke({
        "image_file_name": "sales_chart.png",
        "target_file_path": "/dashboard.html",
        "alt_text": "Sales Performance Chart"
    })
    print(result)
    
    # Show the file content
    if html_file.exists():
        print("\n--- File Content ---")
        print(html_file.read_text())


def test_insert_at_line_number(tool, workspace_state: WorkspaceState):
    """Test inserting image at specific line number."""
    print("\n" + "="*70)
    print("TEST 5: Insert image at specific line number (line 3)")
    print("="*70)
    
    # Create a file with multiple lines
    test_file = workspace_state.root_path / "detailed_report.md"
    test_file.write_text(
        "# Report\n"
        "## Section 1\n"
        "Content here.\n"
        "## Section 2\n"
        "More content.\n"
    )
    
    result = tool.invoke({
        "image_file_name": "revenue_chart.png",
        "target_file_path": "/detailed_report.md",
        "alt_text": "Revenue Chart",
        "position": "3"
    })
    print(result)
    
    # Show the file content
    if test_file.exists():
        print("\n--- File Content ---")
        print(test_file.read_text())


def test_error_cases(tool, workspace_state: WorkspaceState):
    """Test error handling."""
    print("\n" + "="*70)
    print("TEST 6: Error Cases")
    print("="*70)
    
    # Test 1: Image not found
    print("\n1. Image not found:")
    result = tool.invoke({
        "image_file_name": "nonexistent.png",
        "target_file_path": "/report.md"
    })
    print(result)
    
    # Test 2: Invalid line number
    print("\n2. Invalid line number:")
    result = tool.invoke({
        "image_file_name": "sales_chart.png",
        "target_file_path": "/existing_report.md",
        "position": "1000"
    })
    print(result)


def main():
    """Run all tests."""
    print("="*70)
    print("Testing insert_image_to_file Tool")
    print("="*70)
    
    # Create test workspace
    print("\nSetting up test workspace...")
    workspace_state = create_test_workspace()
    print(f"✓ Created test workspace at: {workspace_state.root_path}")
    
    # Create ToolFactory
    class MockSettings:
        def get_tool(self, name):
            class MockToolConfig:
                name = "insert_image_to_file"
                kind = "builtin"
            return MockToolConfig()
    
    class MockSourceTracker:
        pass
    
    class MockGeminiManager:
        pass
    
    settings = MockSettings()
    source_tracker = MockSourceTracker()
    gemini_manager = MockGeminiManager()
    
    factory = ToolFactory(settings, source_tracker, gemini_manager)
    tool = factory._build_insert_image_to_file_tool(workspace_state)
    print(f"✓ Created insert_image_to_file tool")
    
    # Run tests
    test_insert_to_new_markdown(tool, workspace_state)
    test_insert_to_existing_markdown(tool, workspace_state)
    test_insert_at_start(tool, workspace_state)
    test_insert_html(tool, workspace_state)
    test_insert_at_line_number(tool, workspace_state)
    test_error_cases(tool, workspace_state)
    
    print("\n" + "="*70)
    print("All tests completed!")
    print("="*70)
    print(f"\nTest workspace location: {workspace_state.root_path}")
    print("You can inspect the generated files to verify the image references.")


if __name__ == "__main__":
    main()
