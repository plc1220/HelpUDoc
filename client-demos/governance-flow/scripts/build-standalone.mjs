import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = resolve(projectRoot, "HelpUDoc-governance-demo.html");

const bundle = await build({
  bundle: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  entryPoints: [resolve(projectRoot, "app/standalone-entry.tsx")],
  format: "iife",
  jsx: "automatic",
  minify: true,
  platform: "browser",
  target: ["es2020"],
  write: false,
});

const script = bundle.outputFiles[0].text;
const css = (await readFile(resolve(projectRoot, "app/globals.css"), "utf8"))
  .replace('@import "tailwindcss";', "")
  .replace(
    "font-family: var(--font-geist-sans), Inter, Arial, sans-serif;",
    "font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;",
  );

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="A clickable HelpUDoc UI prototype demonstrating governed workspace collaboration, skills, tools, MCP servers, knowledge, and sandbox execution.">
    <title>HelpUDoc Governance UI Prototype</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="helpudoc-demo"></div>
    <script>${script}</script>
  </body>
</html>
`;

await writeFile(outputFile, html);
console.log(outputFile);
