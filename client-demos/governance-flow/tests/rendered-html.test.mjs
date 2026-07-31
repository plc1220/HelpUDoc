import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the HelpUDoc UI scenario prototype", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>HelpUDoc Governance UI Prototype<\/title>/i);
  assert.match(html, /HelpUDoc governance scenarios/);
  assert.match(html, /Private workspaces/);
  assert.match(html, /Team workspaces/);
  assert.match(html, /Customer research/);
  assert.match(html, /Configure team workspace/);
  assert.match(html, /Edit in Freeflow/);
  assert.match(html, /Publisher change feed/);
  assert.match(html, /Propose skill improvement/);
  assert.match(html, /Team Lead skill review/);
  assert.match(html, /Cross-team skill coverage/);
  assert.match(html, /Annotate published work/);
  assert.match(html, /Turn discussion into proposal/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});
