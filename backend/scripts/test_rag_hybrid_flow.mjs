#!/usr/bin/env node
/**
 * RAG hybrid-only test (no agent run).
 * - Ensures file exists in workspace (optionally uploads)
 * - Queries agent RAG endpoint with mode=hybrid
 */

import fs from "node:fs/promises";
import path from "node:path";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000/api";
const AGENT_BASE_URL = process.env.AGENT_BASE_URL ?? "http://localhost:8001";
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "e48581c6-07b9-48c0-b292-58d3c10dc032";
const FILE_PATH = process.env.FILE_PATH ?? "/Users/cmtest/Documents/HelpUDoc/backend/workspaces/e48581c6-07b9-48c0-b292-58d3c10dc032/STATEMENT OF WORK for Phase 0 1.0.pdf";
const QUERY = process.env.QUERY ?? "Generate a requirements list and points that require extra care.";
const SKIP_UPLOAD = (process.env.SKIP_UPLOAD ?? "false").toLowerCase() === "true";

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

async function ragQuery(workspaceId, query) {
  const res = await fetch(`${AGENT_BASE_URL}/rag/workspaces/${workspaceId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, mode: "hybrid", onlyNeedContext: true }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RAG query failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const fileName = path.basename(FILE_PATH);
  console.log("Using:", {
    API_BASE_URL,
    AGENT_BASE_URL,
    WORKSPACE_ID,
    FILE_PATH,
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

  const result = await ragQuery(WORKSPACE_ID, QUERY);
  const responseText = typeof result?.response === "string" ? result.response.trim() : "";
  if (responseText) {
    console.log("Hybrid RAG context sample:", responseText.slice(0, 400));
  } else {
    console.warn("Hybrid RAG returned empty context.");
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
