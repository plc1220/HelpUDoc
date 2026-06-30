"use strict";

const readline = require("node:readline");

const SERVER_NAME = "data-artifacts";
const SERVER_VERSION = "0.1.0";

const LIMITS = {
  maxDatasets: 50,
  maxRowsPerDataset: 2000,
  maxPayloadBytes: 3_000_000,
  maxInlineSourceChars: 200_000,
  maxWidgetRows: 2000,
  maxWidgetColumns: 80,
};

const TOOL_NAMES = {
  validateArtifact: "validate_data_artifact",
  renderArtifact: "render_artifact",
  renderChart: "render_chart",
  renderTable: "render_table",
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function payloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
}

function textResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

function validateRows(rows, path, errors) {
  if (!Array.isArray(rows)) {
    errors.push(`${path} must be an array of row objects.`);
    return;
  }
  if (rows.length > LIMITS.maxRowsPerDataset) {
    errors.push(`${path} has ${rows.length} rows; limit is ${LIMITS.maxRowsPerDataset}.`);
  }
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    if (!isPlainObject(rows[i])) {
      errors.push(`${path}[${i}] must be an object.`);
      break;
    }
  }
}

function validateSnapshot(snapshot) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(snapshot)) {
    return { valid: false, errors: ["snapshot must be an object."], warnings };
  }
  if (payloadBytes(snapshot) > LIMITS.maxPayloadBytes) {
    errors.push(`snapshot exceeds ${LIMITS.maxPayloadBytes} bytes.`);
  }
  const datasets = snapshot.datasets;
  if (!isPlainObject(datasets)) {
    errors.push("snapshot.datasets must be an object keyed by dataset id.");
  } else {
    const ids = Object.keys(datasets);
    if (ids.length > LIMITS.maxDatasets) {
      errors.push(`snapshot.datasets has ${ids.length} datasets; limit is ${LIMITS.maxDatasets}.`);
    }
    for (const id of ids) {
      const value = datasets[id];
      if (isPlainObject(value) && Array.isArray(value.rows)) {
        errors.push(`snapshot.datasets.${id} must be a plain row array, not { rows: [...] }.`);
      } else {
        validateRows(value, `snapshot.datasets.${id}`, errors);
      }
    }
  }
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const inlineChars = sources.reduce((sum, source) => {
    if (!isPlainObject(source)) return sum;
    const inline = source.inline || source.content || source.text || "";
    return sum + (typeof inline === "string" ? inline.length : 0);
  }, 0);
  if (inlineChars > LIMITS.maxInlineSourceChars) {
    errors.push(`snapshot inline source text has ${inlineChars} characters; limit is ${LIMITS.maxInlineSourceChars}.`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ["manifest must be an object."], warnings };
  }
  if (!String(manifest.title || "").trim()) {
    errors.push("manifest.title is required.");
  }
  if (!Array.isArray(manifest.blocks)) {
    errors.push("manifest.blocks must be an array.");
  }
  const chartBlocks = Array.isArray(manifest.blocks)
    ? manifest.blocks.filter((block) => isPlainObject(block) && /chart|visual/i.test(String(block.type || block.kind || "")))
    : [];
  if (Array.isArray(manifest.blocks) && chartBlocks.length === 0) {
    warnings.push("manifest.blocks has no explicit chart/visualization block.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

function validateArtifactPayload(args) {
  const manifestCheck = validateManifest(args.manifest);
  const snapshotCheck = validateSnapshot(args.snapshot);
  const errors = [...manifestCheck.errors, ...snapshotCheck.errors];
  const warnings = [...manifestCheck.warnings, ...snapshotCheck.warnings];
  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    errors,
    warnings,
    limits: LIMITS,
  };
}

function validateWidgetRows(rows, errors, path) {
  if (!Array.isArray(rows)) {
    errors.push(`${path} must be an array.`);
    return [];
  }
  if (rows.length > LIMITS.maxWidgetRows) {
    errors.push(`${path} has ${rows.length} rows; limit is ${LIMITS.maxWidgetRows}.`);
  }
  const fields = new Set();
  for (const row of rows.slice(0, Math.min(rows.length, 100))) {
    if (!isPlainObject(row)) {
      errors.push(`${path} must contain row objects.`);
      break;
    }
    for (const key of Object.keys(row)) fields.add(key);
  }
  if (fields.size > LIMITS.maxWidgetColumns) {
    errors.push(`${path} has ${fields.size} columns; limit is ${LIMITS.maxWidgetColumns}.`);
  }
  return Array.from(fields);
}

function renderChart(args) {
  const errors = [];
  const table = isPlainObject(args.table) ? args.table : {};
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const fields = validateWidgetRows(rows, errors, "table.rows");
  const chart = isPlainObject(args.chart) ? args.chart : {};
  if (!String(chart.type || "").trim()) errors.push("chart.type is required.");
  const display = isPlainObject(args.display) ? args.display : {};
  const payload = {
    ok: errors.length === 0,
    widget_type: "chart",
    source: isPlainObject(args.source) ? args.source : {},
    table: { ...table, row_count: Number(table.row_count || rows.length), fields },
    chart,
    display,
    errors,
  };
  if (errors.length) throw new Error(errors.join(" "));
  return payload;
}

function renderTable(args) {
  const errors = [];
  const table = isPlainObject(args.table) ? args.table : args;
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const fields = validateWidgetRows(rows, errors, "table.rows");
  const payload = {
    ok: errors.length === 0,
    widget_type: "table",
    source: isPlainObject(args.source) ? args.source : {},
    table: { ...table, row_count: Number(table.row_count || rows.length), fields },
    display: isPlainObject(args.display) ? args.display : {},
    errors,
  };
  if (errors.length) throw new Error(errors.join(" "));
  return payload;
}

function renderArtifact(args) {
  const validation = validateArtifactPayload(args);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }
  return {
    ok: true,
    widget_type: "artifact",
    manifest: args.manifest,
    snapshot: args.snapshot,
    validation,
  };
}

function toolDefinitions() {
  return [
    {
      name: TOOL_NAMES.validateArtifact,
      title: "Validate Data Artifact",
      description: "Validate a bounded Data Analytics artifact manifest and snapshot before rendering.",
      inputSchema: {
        type: "object",
        properties: {
          manifest: { type: "object", additionalProperties: true },
          snapshot: { type: "object", additionalProperties: true },
        },
        required: ["manifest", "snapshot"],
        additionalProperties: true,
      },
    },
    {
      name: TOOL_NAMES.renderArtifact,
      title: "Render Artifact",
      description: "Return a validated Data Analytics report or dashboard artifact payload.",
      inputSchema: {
        type: "object",
        properties: {
          manifest: { type: "object", additionalProperties: true },
          snapshot: { type: "object", additionalProperties: true },
        },
        required: ["manifest", "snapshot"],
        additionalProperties: true,
      },
    },
    {
      name: TOOL_NAMES.renderChart,
      title: "Render Chart",
      description: "Return a validated chart payload from reviewed source rows and declarative chart fields.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "object", additionalProperties: true },
          table: { type: "object", additionalProperties: true },
          chart: { type: "object", additionalProperties: true },
          display: { type: "object", additionalProperties: true },
        },
        required: ["table", "chart"],
        additionalProperties: true,
      },
    },
    {
      name: TOOL_NAMES.renderTable,
      title: "Render Table",
      description: "Return a validated table payload from reviewed source rows.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "object", additionalProperties: true },
          table: { type: "object", additionalProperties: true },
          display: { type: "object", additionalProperties: true },
        },
        required: ["table"],
        additionalProperties: true,
      },
    },
  ];
}

function callTool(name, args) {
  if (name === TOOL_NAMES.validateArtifact) return validateArtifactPayload(args || {});
  if (name === TOOL_NAMES.renderArtifact) return renderArtifact(args || {});
  if (name === TOOL_NAMES.renderChart) return renderChart(args || {});
  if (name === TOOL_NAMES.renderTable) return renderTable(args || {});
  throw new Error(`unknown tool: ${name}`);
}

function rpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(message) {
  if (!isPlainObject(message)) return rpcError(null, -32600, "Invalid Request");
  const id = message.id;
  const method = message.method;
  const params = isPlainObject(message.params) ? message.params : {};
  if (typeof method !== "string") return id != null ? rpcError(id, -32600, "Invalid Request") : null;
  if (method.startsWith("notifications/") || method === "$/cancelRequest") return null;
  try {
    if (method === "initialize") {
      return rpcResponse(id, {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: {
          name: SERVER_NAME,
          title: "Data Artifacts",
          version: SERVER_VERSION,
          description: "Validate and render Data Analytics chart, table, report, and dashboard payloads.",
        },
        instructions: [
          "Use validate_data_artifact before render_artifact.",
          "Keep snapshots bounded and source-backed.",
          "This server is additive and does not replace native DashboardCanvas packages.",
        ].join(" "),
      });
    }
    if (method === "ping") return rpcResponse(id, {});
    if (method === "tools/list") return rpcResponse(id, { tools: toolDefinitions() });
    if (method === "tools/call") {
      const name = params.name;
      if (typeof name !== "string") return rpcError(id, -32602, "tools/call requires name.");
      try {
        return rpcResponse(id, textResult(callTool(name, params.arguments || {})));
      } catch (error) {
        return rpcResponse(id, textResult({ ok: false, error: error && error.message ? error.message : String(error) }, true));
      }
    }
    if (method === "resources/list") return rpcResponse(id, { resources: [] });
    if (method === "resources/read") return rpcError(id, -32602, "No resources are exposed by data-artifacts.");
    if (method === "resources/templates/list") return rpcResponse(id, { resourceTemplates: [] });
    if (method === "prompts/list") return rpcResponse(id, { prompts: [] });
  } catch (error) {
    return rpcError(id, -32000, error && error.message ? error.message : String(error));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function writeRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function runStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let decoded;
    try {
      decoded = JSON.parse(trimmed);
    } catch (error) {
      writeRpc(rpcError(null, -32700, `Parse error: ${error.message}`));
      return;
    }
    if (Array.isArray(decoded)) {
      const responses = [];
      for (const request of decoded) {
        const response = await handleRpc(request);
        if (response) responses.push(response);
      }
      if (responses.length) writeRpc(responses);
      return;
    }
    const response = await handleRpc(decoded);
    if (response) writeRpc(response);
  });
}

module.exports = {
  LIMITS,
  TOOL_NAMES,
  callTool,
  handleRpc,
  toolDefinitions,
  validateArtifactPayload,
};

if (require.main === module) {
  runStdio();
}
