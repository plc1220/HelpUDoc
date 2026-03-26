import fs from 'node:fs/promises';
import path from 'node:path';

const distDir = path.resolve('dist/assets');

const stripProtectedShellPreload = (code) => {
  const helperImportMatch = code.match(/import\{_ as (\w+)\}from"\.\/monaco-[^"]+\.js";/);
  if (!helperImportMatch) {
    return code;
  }

  const helperName = helperImportMatch[1];

  return code
    .replace(/const __vite__mapDeps=.*?;\n?/, '')
    .replace(/import\{_ as \w+\}from"\.\/monaco-[^"]+\.js";/g, '')
    .replace(
      new RegExp(`\\(\\)=>${helperName}\\(\\(\\)=>import\\("(\\.\\/ProtectedShell-[^"]+\\.js)"\\),__vite__mapDeps\\(\\[[^\\]]*\\]\\)\\)`, 'g'),
      '()=>import("$1")',
    );
};

const stripImports = (code) =>
  stripProtectedShellPreload(
    code
      .replace(/import"\.\/vendor-[^"]+\.js";/g, '')
      .replace(/import"\.\/plotly-[^"]+\.js";/g, '')
      .replace(/import"\.\/monaco-[^"]+\.js";/g, ''),
  );

const mainFiles = (await fs.readdir(distDir)).filter((file) => /^main-[^.]+\.js$/.test(file));

for (const file of mainFiles) {
  const filePath = path.join(distDir, file);
  const code = await fs.readFile(filePath, 'utf8');
  const nextCode = stripImports(code);
  if (nextCode !== code) {
    await fs.writeFile(filePath, nextCode);
    console.log(`Stripped startup preloads from ${file}`);
  }
}
