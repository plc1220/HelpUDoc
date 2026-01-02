#!/usr/bin/env node
/**
 * Replicates the frontend flow for sending a prompt:
 * - POST /agent/runs (no RAG status polling)
 * - GET /agent/runs/:runId/stream (JSONL stream)
 */

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000/api";
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "e48581c6-07b9-48c0-b292-58d3c10dc032";
const PERSONA = process.env.PERSONA ?? "general-assistant";
const PROMPT =
  process.env.PROMPT ??
  "read @STATEMENT OF WORK for Phase 0 1.0.pdf and generate a requirements list, and points that requires extra care";
const TURN_ID = process.env.TURN_ID;
const FORCE_RESET = (process.env.FORCE_RESET ?? "false").toLowerCase() === "true";
const STREAM_EVENTS = (process.env.STREAM_EVENTS ?? "false").toLowerCase() === "true";

const HISTORY_JSON = process.env.HISTORY_JSON;
const HISTORY = HISTORY_JSON ? JSON.parse(HISTORY_JSON) : undefined;

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      "content-type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function startRun() {
  return jsonFetch(`${API_BASE_URL}/agent/runs`, {
    method: "POST",
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      persona: PERSONA,
      prompt: PROMPT,
      history: HISTORY,
      forceReset: FORCE_RESET,
      ...(TURN_ID ? { turnId: TURN_ID } : {}),
    }),
  });
}

async function streamRun(runId) {
  const res = await fetch(`${API_BASE_URL}/agent/runs/${runId}/stream`, { method: "GET" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stream failed (${res.status}): ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("Streaming not supported by this environment.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;

  const handleChunk = (chunk) => {
    eventCount += 1;
    if (STREAM_EVENTS) {
      console.log(JSON.stringify(chunk));
      return;
    }
    if (chunk?.type === "token" || chunk?.type === "chunk") {
      if (typeof chunk.content === "string") {
        process.stdout.write(chunk.content);
      }
      return;
    }
    if (chunk?.type === "error") {
      console.error(`\n[stream error] ${chunk.message || "unknown error"}`);
      return;
    }
    if (chunk?.type === "tool_start") {
      console.error(`\n[tool_start] ${chunk.name || "unknown"}`);
      return;
    }
    if (chunk?.type === "tool_end") {
      console.error(`\n[tool_end] ${chunk.name || "unknown"}`);
      return;
    }
    if (chunk?.type === "thought") {
      console.error(`\n[thought] ${chunk.content || ""}`);
      return;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const chunk = JSON.parse(line);
          handleChunk(chunk);
        } catch (error) {
          console.error("Failed to parse stream chunk:", error, line);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer.trim());
      handleChunk(chunk);
    } catch (error) {
      console.error("Failed to parse trailing stream chunk:", error, buffer);
    }
  }

  if (!STREAM_EVENTS) {
    process.stdout.write("\n");
  }
  return eventCount;
}

async function main() {
  console.log("Starting run:", {
    API_BASE_URL,
    WORKSPACE_ID,
    PERSONA,
    TURN_ID,
    FORCE_RESET,
    STREAM_EVENTS,
  });

  const started = await startRun();
  console.log("Run started:", started);
  const eventCount = await streamRun(started.runId);
  console.log("Stream complete:", { runId: started.runId, eventCount });
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
