#!/usr/bin/env node
/**
 * Smoke test for tagged-file RAG behavior:
 * - upload a file to a workspace (to enqueue indexing)
 * - wait for RAG to return any context
 * - run agent stream with @filename tag and confirm rag_query tool usage
 *
 * Prereqs:
 * - backend running (default: http://localhost:3000)
 * - agent running (default: http://localhost:8001) with RAG worker enabled
 */

import fs from "node:fs/promises";
import path from "node:path";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000/api";
const AGENT_BASE_URL = process.env.AGENT_BASE_URL ?? "http://localhost:8001";
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "e48581c6-07b9-48c0-b292-58d3c10dc032";
const FILE_PATH = process.env.FILE_PATH ?? "/Users/cmtest/Documents/HelpUDoc/backend/workspaces/e48581c6-07b9-48c0-b292-58d3c10dc032/STATEMENT OF WORK for Phase 0 1.0.pdf";
const PERSONA = process.env.PERSONA ?? "fast";
const QUERY = process.env.QUERY ?? "Generate a requirements list and points that require extra care.";
const SKIP_UPLOAD = (process.env.SKIP_UPLOAD ?? "false").toLowerCase() === "true";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function uploadFile(workspaceId, filePath) {
  const fileName = path.basename(filePath);
  const buffer = await fs.readFile(filePath);
  const blob = new Blob([buffer], { type: "application/pdf" });
  const form = new FormData();
  form.append("file", blob, fileName);

  const res = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/files`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function listFiles(workspaceId) {
  const res = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/files`);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`List files failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

async function ragQuery(workspaceId, query, { onlyNeedContext = true, mode = "local" } = {}) {
  return jsonFetch(`${AGENT_BASE_URL}/rag/workspaces/${workspaceId}/query`, {
    method: "POST",
    body: JSON.stringify({ query, mode, onlyNeedContext }),
  });
}

async function waitForAnyRagContext(workspaceId, query, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await ragQuery(workspaceId, query, { onlyNeedContext: true, mode: "hybrid" });
      const responseText = typeof result?.response === "string" ? result.response.trim() : "";
      if (responseText) return responseText;
    } catch {
      // agent may not be ready; retry
    }
    await sleep(1000);
  }
  throw new Error("Timed out waiting for RAG context.");
}

async function streamAgentRun(workspaceId, persona, prompt, { timeoutMs = 480_000 } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${API_BASE_URL}/agent/run-stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, persona, prompt }),
    signal: controller.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Agent stream failed (${res.status}): ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("Streaming not supported by this environment.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  const readWithTimeout = () =>
    Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Stream read timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);

  while (true) {
    const { value, done } = await readWithTimeout();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const chunk = JSON.parse(line);
          events.push(chunk);
        } catch {
          // ignore malformed lines
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer.trim());
      events.push(chunk);
    } catch {
      // ignore trailing parse errors
    }
  }

  return events;
}

async function main() {
  const fileName = path.basename(FILE_PATH);
  console.log("Using:", {
    API_BASE_URL,
    AGENT_BASE_URL,
    WORKSPACE_ID,
    FILE_PATH,
    PERSONA,
    QUERY,
    SKIP_UPLOAD,
  });

  await fs.access(FILE_PATH);

  const existingFiles = await listFiles(WORKSPACE_ID);
  const existing = existingFiles.find((file) => file?.name === fileName);
  if (existing) {
    console.log("File already exists in workspace:", { id: existing?.id, name: existing?.name });
  } else if (!SKIP_UPLOAD) {
    const uploaded = await uploadFile(WORKSPACE_ID, FILE_PATH);
    console.log("Uploaded file:", { id: uploaded?.id, name: uploaded?.name });
  } else {
    console.log("Skipping upload (SKIP_UPLOAD=true)");
  }

  const ragContext = await waitForAnyRagContext(WORKSPACE_ID, "Phase 0");
  console.log("RAG context sample:", ragContext.slice(0, 240));

  const prompt = [
    `@${fileName}`,
    QUERY,
    "Use rag_query and restrict file_paths to the tagged file list.",
  ].join("\n");

  const events = await streamAgentRun(WORKSPACE_ID, PERSONA, prompt, { timeoutMs: 480_000 });

  const toolStarts = events.filter((event) => event?.type === "tool_start");
  const toolEnds = events.filter((event) => event?.type === "tool_end");
  const ragTool = toolStarts.find((event) => event?.name === "rag_query");
  const ragOutput = toolEnds.find((event) => event?.name === "rag_query");
  const answerText = events
    .filter((event) => event?.type === "token" || event?.type === "chunk")
    .map((event) => event?.content || "")
    .join("")
    .trim();

  console.log("Tool starts:", toolStarts.map((event) => event?.name).filter(Boolean));
  if (ragTool) {
    console.log("rag_query tool invoked.");
  } else {
    console.warn("rag_query tool not observed in stream.");
  }

  if (ragOutput?.content) {
    console.log("rag_query output sample:", String(ragOutput.content).slice(0, 240));
  }

  if (answerText) {
    console.log("Final answer sample:", answerText.slice(0, 240));
  } else {
    console.warn("No final answer tokens received.");
  }

  if (!events.length) {
    console.warn("No stream events received.");
  } else {
    const tail = events.slice(-5).map((event) => ({
      type: event?.type,
      name: event?.name,
      content: typeof event?.content === "string" ? event.content.slice(0, 120) : undefined,
    }));
    console.log("Last events:", tail);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
