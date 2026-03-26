import fs from 'node:fs/promises';
import path from 'node:path';

const distDir = path.resolve('dist/assets');

const isIdentifierBoundary = (char) => !char || !/[A-Za-z0-9_$]/.test(char);

const findMatchingParen = (code, openIndex) => {
  let depth = 0;
  let inString = false;
  let stringQuote = '';
  let inTemplate = false;
  let templateDepth = 0;
  let escaped = false;

  for (let index = openIndex; index < code.length; index += 1) {
    const char = code[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (inTemplate) {
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '`' && templateDepth === 0) {
        inTemplate = false;
        continue;
      }
      if (char === '$' && code[index + 1] === '{') {
        templateDepth += 1;
        index += 1;
        continue;
      }
      if (char === '}' && templateDepth > 0) {
        templateDepth -= 1;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === '`') {
      inTemplate = true;
      templateDepth = 0;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
};

const splitTopLevelArgs = (argsSource) => {
  const args = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inString = false;
  let stringQuote = '';
  let inTemplate = false;
  let templateDepth = 0;
  let escaped = false;
  let start = 0;

  for (let index = 0; index < argsSource.length; index += 1) {
    const char = argsSource[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (inTemplate) {
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '`' && templateDepth === 0) {
        inTemplate = false;
        continue;
      }
      if (char === '$' && argsSource[index + 1] === '{') {
        templateDepth += 1;
        index += 1;
        continue;
      }
      if (char === '}' && templateDepth > 0) {
        templateDepth -= 1;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === '`') {
      inTemplate = true;
      templateDepth = 0;
      continue;
    }

    if (char === '(') {
      depthParen += 1;
      continue;
    }

    if (char === ')') {
      depthParen -= 1;
      continue;
    }

    if (char === '{') {
      depthBrace += 1;
      continue;
    }

    if (char === '}') {
      depthBrace -= 1;
      continue;
    }

    if (char === '[') {
      depthBracket += 1;
      continue;
    }

    if (char === ']') {
      depthBracket -= 1;
      continue;
    }

    if (char === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      args.push(argsSource.slice(start, index).trim());
      start = index + 1;
    }
  }

  args.push(argsSource.slice(start).trim());
  return args;
};

const stripMonacoHelperCalls = (code) => {
  const helperImportMatch = code.match(/import\{_ as (\w+)\}from"\.\/monaco-[^"]+\.js";/);
  if (!helperImportMatch) {
    return code;
  }

  const helperName = helperImportMatch[1];
  let nextCode = code
    .replace(/const __vite__mapDeps=.*?;\n?/, '')
    .replace(/import\{_ as \w+\}from"\.\/monaco-[^"]+\.js";/g, '');

  let cursor = 0;
  while (cursor < nextCode.length) {
    const callStart = nextCode.indexOf(`${helperName}(`, cursor);
    if (callStart === -1) {
      break;
    }

    const before = nextCode[callStart - 1];
    const after = nextCode[callStart + helperName.length + 1];
    if (!isIdentifierBoundary(before) || (!after && after !== undefined)) {
      cursor = callStart + helperName.length + 1;
      continue;
    }

    const openParenIndex = callStart + helperName.length;
    const closeParenIndex = findMatchingParen(nextCode, openParenIndex);
    if (closeParenIndex === -1) {
      break;
    }

    const argsSource = nextCode.slice(openParenIndex + 1, closeParenIndex);
    const args = splitTopLevelArgs(argsSource);
    if (args.length === 2 && /^__vite__mapDeps\(\[[^\]]*\]\)$/.test(args[1])) {
      const replacement = `(${args[0]})()`;
      nextCode = `${nextCode.slice(0, callStart)}${replacement}${nextCode.slice(closeParenIndex + 1)}`;
      cursor = callStart + replacement.length;
      continue;
    }

    cursor = closeParenIndex + 1;
  }

  return nextCode;
};

const stripImports = (code) =>
  stripMonacoHelperCalls(
    code
      .replace(/import"\.\/vendor-[^"]+\.js";/g, '')
      .replace(/import"\.\/plotly-[^"]+\.js";/g, '')
      .replace(/import"\.\/monaco-[^"]+\.js";/g, ''),
  );

const shouldStripStartupImports = (file) => (
  file.startsWith('main-') ||
  file.startsWith('ProtectedShell-')
);

const assetFiles = (await fs.readdir(distDir)).filter((file) => file.endsWith('.js'));

for (const file of assetFiles) {
  const filePath = path.join(distDir, file);
  const code = await fs.readFile(filePath, 'utf8');
  const nextCode = shouldStripStartupImports(file) ? stripImports(code) : stripMonacoHelperCalls(code);
  if (nextCode !== code) {
    await fs.writeFile(filePath, nextCode);
    console.log(`Stripped preload helpers from ${file}`);
  }
}
