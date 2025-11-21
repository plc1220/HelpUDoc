# Subagents and their Tools

Here is a list of subagents and the tools tied to each:

## general-purpose
*   **Description**: General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. This agent has access to all tools as the main agent.
*   **Tools**: `write_todos`, `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `task`, `get_table_schema`, `run_sql_query`, `generate_chart_config`, `generate_summary`

## schema-agent
*   **Description**: Inspects table structures before any SQL runs.
*   **Tools**: `get_table_schema`

## sql-agent
*   **Description**: Crafts and executes DuckDB queries based on the schema plan.
*   **Tools**: `run_sql_query`

## chart-agent
*   **Description**: Builds chart configurations or artifacts from the latest query result.
*   **Tools**: `generate_chart_config`

## file-agent
*   **Description**: Manages generated artifacts and ensures they are documented.
*   **Tools**: `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`

## summary-agent
*   **Description**: Writes the final answer after queries/charts are complete.
*   **Tools**: `generate_summary`
