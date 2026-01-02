#!/usr/bin/env node
/**
 * End-to-end smoke test:
 * - create two workspaces
 * - upload one text file into each workspace
 * - assert backend enqueued a Redis stream job for each upload
 * - wait for agent RAG query (workspace-isolated) to retrieve the right content
 *
 * Prereqs:
 * - backend running (default: http://localhost:3000)
 * - redis running (default: redis://localhost:6379)
 * - agent running (default: http://localhost:8001) with RAG worker enabled
 */

import crypto from "node:crypto";
import process from "node:process";

import { createClient } from "redis";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000/api";
const AGENT_BASE_URL = process.env.AGENT_BASE_URL ?? "http://localhost:8001";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const RAG_INDEX_STREAM = process.env.RAG_INDEX_STREAM ?? "helpudoc:rag:index-jobs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

async function createWorkspace(name) {
  return jsonFetch(`${API_BASE_URL}/workspaces`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

async function uploadTextFile(workspaceId, filename, content) {
  const form = new FormData();
  const bytes = new TextEncoder().encode(content);
  form.append("file", new Blob([bytes], { type: "text/plain" }), filename);

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

async function findStreamEvent(redis, predicate, { attempts = 30, delayMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    // Fetch recent entries (newest first)
    const entries = await redis.xRevRange(RAG_INDEX_STREAM, "+", "-", { COUNT: 50 }).catch(() => []);
    for (const entry of entries) {
      const fields = entry.message ?? entry.fields ?? entry[1] ?? {};
      if (predicate(fields)) return { id: entry.id ?? entry[0], fields };
    }
    await sleep(delayMs);
  }
  return null;
}

async function ragQuery(workspaceId, query, { onlyNeedContext = true, mode = "local" } = {}) {
  return jsonFetch(`${AGENT_BASE_URL}/rag/workspaces/${workspaceId}/query`, {
    method: "POST",
    body: JSON.stringify({ query, mode, onlyNeedContext }),
  });
}

async function waitForRagContains(workspaceId, query, expectedNeedle, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await ragQuery(workspaceId, query, { onlyNeedContext: true, mode: "naive" });
      const responseText = typeof result?.response === "string" ? result.response : JSON.stringify(result);
      if (responseText.includes(expectedNeedle)) return responseText;
    } catch {
      // agent may not be ready; retry
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for RAG to contain needle: ${expectedNeedle}`);
}

async function main() {
  const runId = crypto.randomBytes(4).toString("hex");
  const uniqueA = `ALPHA_UNIQUE_${runId}`;
  const uniqueB = `BETA_UNIQUE_${runId}`;

  console.log("Using:", { API_BASE_URL, AGENT_BASE_URL, REDIS_URL, RAG_INDEX_STREAM });

  const redis = createClient({ url: REDIS_URL });
  await redis.connect();

  try {
    const wsA = await createWorkspace(`rag-test-a-${runId}`);
    const wsB = await createWorkspace(`rag-test-b-${runId}`);
    assert(wsA?.id && wsB?.id, "Workspace creation did not return id");

    const fileA = await uploadTextFile(wsA.id, "alpha.txt", `Hello from A. ${uniqueA}\n`);
    const fileB = await uploadTextFile(wsB.id, "beta.txt", `Hello from B. ${uniqueB}\n`);
    assert(Number.isFinite(fileA?.id), "Upload A did not return numeric file id");
    assert(Number.isFinite(fileB?.id), "Upload B did not return numeric file id");

    const eventA = await findStreamEvent(redis, (fields) =>
      fields.workspaceId === wsA.id && String(fields.fileId) === String(fileA.id)
    );
    assert(eventA, "Did not find Redis enqueue event for workspace A upload");

    const eventB = await findStreamEvent(redis, (fields) =>
      fields.workspaceId === wsB.id && String(fields.fileId) === String(fileB.id)
    );
    assert(eventB, "Did not find Redis enqueue event for workspace B upload");

    console.log("Enqueue events found:", { eventA: eventA.id, eventB: eventB.id });

    // Wait for indexer to process and verify workspace isolation via retrieval-only query.
    await waitForRagContains(wsA.id, uniqueA, uniqueA);
    await waitForRagContains(wsB.id, uniqueB, uniqueB);

    const crossA = await ragQuery(wsA.id, uniqueB, { onlyNeedContext: true, mode: "naive" });
    const crossAText = String(crossA?.response ?? "");
    assert(!crossAText.includes(uniqueB), "Workspace A query unexpectedly retrieved workspace B content");

    const crossB = await ragQuery(wsB.id, uniqueA, { onlyNeedContext: true, mode: "naive" });
    const crossBText = String(crossB?.response ?? "");
    assert(!crossBText.includes(uniqueA), "Workspace B query unexpectedly retrieved workspace A content");

    console.log("PASS: upload → enqueue → index → workspace-isolated query");
  } finally {
    await redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
