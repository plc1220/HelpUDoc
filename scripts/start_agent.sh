#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/.."

# Navigate to project root
cd "$PROJECT_ROOT"

# Check if virtual environment exists and activate it
if [ -d "venv" ]; then
    source venv/bin/activate
elif [ -d ".venv" ]; then
    source .venv/bin/activate
fi

# Create logs directory if it doesn't exist
mkdir -p logs

echo "Starting Agent in background..."
nohup uvicorn agent.main:app --host 0.0.0.0 --port 8001 --reload > logs/agent.log 2>&1 &

PID=$!
echo "Agent started with PID: $PID"
echo "Logs are being written to logs/agent.log"
echo "To stop the agent, run: kill $PID"
