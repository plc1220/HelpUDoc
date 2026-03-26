import fs from 'node:fs/promises';
import path from 'node:path';

const distDir = path.resolve('dist/assets');

const stripImports = (code) =>
  code
    .replace(/import"\.\/vendor-[^"]+\.js";/g, '')
    .replace(/import"\.\/plotly-[^"]+\.js";/g, '')
    .replace(/import"\.\/monaco-[^"]+\.js";/g, '');

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
