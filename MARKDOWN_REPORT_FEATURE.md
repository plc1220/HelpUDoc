# Markdown Report Generation Feature

## Overview
The data agent now automatically generates a comprehensive markdown report for every analysis session. When the agent calls `generate_summary`, it creates a timestamped markdown file in the `reports/` directory.

## What's Included in the Report

Each report contains:

1. **Header with timestamp** - When the analysis was performed
2. **Summary** - Overview of the analytical steps taken
3. **Key Insights** - Bullet points with concrete findings and numbers
4. **SQL Query** - The actual SQL query executed (formatted as code block)
5. **Query Results** - Metadata about the results (row count, columns)
6. **Sample Data** - First 10 rows of the query results in markdown table format
7. **Visualizations** - References to any charts generated (PNG images or Chart.js configs)

## File Location

Reports are saved to: `workspace/{workspace_id}/reports/analysis_report_{timestamp}.md`

Example: `reports/analysis_report_20241124_165300.md`

## Benefits

✅ **Persistent record** - Users have a permanent record of each analysis  
✅ **Shareable** - Markdown files can be easily shared with team members  
✅ **Readable** - Clean, formatted markdown with tables and code blocks  
✅ **Complete** - Includes queries, data, insights, and chart references  
✅ **Timestamped** - Each report has a unique timestamp for tracking  

## Example Output

See [example_analysis_report.md](file:///Users/cmtest/Documents/HelpUDoc/example_analysis_report.md) for a sample of what the generated reports look like.

## Changes Made

### 1. Updated `generate_summary` tool ([data_agent_tools.py](file:///Users/cmtest/Documents/HelpUDoc/agent/helpudoc_agent/data_agent_tools.py#L556-L681))

- Added markdown report generation logic
- Creates `reports/` directory if it doesn't exist
- Generates timestamped filename
- Includes summary, insights, SQL query, results, and chart references
- Dispatches artifact event to notify the UI
- Returns success message with file path

### 2. Updated summary prompt ([summary.md](file:///Users/cmtest/Documents/HelpUDoc/agent/prompts/data_agent/summary.md))

- Added note about automatic report generation
- Explains what's included in the report
- Helps the agent understand the feature

## Usage

No changes needed from the user's perspective! The agent automatically creates the report when it generates the summary. Users will see:

1. The summary and insights in the chat
2. A message indicating the report was saved: `📄 Full report saved to: reports/analysis_report_20241124_165300.md`
3. The report file appears in the workspace files list
4. Users can open and read the markdown file directly
