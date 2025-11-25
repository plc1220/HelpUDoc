import type { PresentationSourceFile } from '../types/presentation';
import { marked } from 'marked';

export type PresentationPromptInput = {
  brief?: string;
  files: PresentationSourceFile[];
};

const PRESENTATION_HTML_PROMPT = `You are the HelpUDoc presentation generator. Produce a polished but concise single-page HTML deck using ONLY the provided files—do not ask the user for more input.

Hard requirements:
1) Output MUST be a complete HTML document (<html>…</html>) with inline <style>; never wrap in backticks or Markdown.
2) Use only facts from the supplied files; summarize and paraphrase instead of copying long paragraphs. No speculation or TODOs.
3) Keep it tight: hero/title + 4-8 sections + a short close/next-steps; aim for < 900 words. Always include textual summary bullets even if diagrams are present—never return diagrams alone.
4) Use semantic HTML for emphasis (blockquote, strong, code). If the source contains Mermaid fences, preserve them as <pre class="mermaid">…</pre>.
5) Bullet where helpful (3-6 bullets per section). Highlight key numbers/quotes.
6) If a brief is provided, reflect its tone/angle; otherwise infer the main goal from the files.
7) No JSON, no Markdown, no placeholders.
`;

export const buildPresentationHtmlPrompt = ({ brief, files }: PresentationPromptInput): string => {
  const fileSections = files.map((file) => {
    const header = `### ${file.name}`;
    const content = typeof file.content === 'string' ? file.content : '';
    return `${header}\n${content}`.trim();
  });
  const promptParts = [
    PRESENTATION_HTML_PROMPT.trim(),
    `Presentation brief: ${brief?.trim() || '(none provided)'}`,
    'Tagged files:',
    fileSections.join('\n\n'),
  ].filter(Boolean);

  return promptParts.join('\n\n');
};

const stripHtmlCodeFence = (payload: string): string => {
  const fenceMatch = payload.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return payload.trim();
};

const convertMermaidBlocks = (payload: string): string => {
  let body = payload;
  const mermaidFence = /```mermaid\s*([\s\S]*?)```/gi;
  if (mermaidFence.test(body)) {
    body = body.replace(mermaidFence, (_, code) => `<pre class="mermaid">${code.trim()}</pre>`);
  }
  // Handle unfenced mermaid blocks that start with the keyword.
  if (/^mermaid\b/i.test(body)) {
    const withoutKeyword = body.replace(/^mermaid\s*/i, '');
    body = `<pre class="mermaid">${withoutKeyword.trim() || body.trim()}</pre>`;
  }
  return body;
};

const convertSimpleMarkdown = (payload: string): string => {
  // Light markdown-to-HTML to avoid raw text responses from the model.
  let body = convertMermaidBlocks(payload);

  // If the entire response is just a mermaid block, keep it intact.
  if (/^<pre class="mermaid">[\s\S]*<\/pre>$/i.test(body.trim())) {
    return body.trim();
  }

  body = body.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
  body = body.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
  body = body.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
  body = body.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  body = body.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  body = body.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  body = body.replace(/^---$/gm, '<hr />');

  // Convert bullet lists (single-level).
  const lines = body.split('\n');
  const output: string[] = [];
  let inList = false;
  for (const line of lines) {
    const match = /^\s*[-*]\s+(.*)$/.exec(line);
    if (match) {
      if (!inList) {
        output.push('<ul>');
        inList = true;
      }
      output.push(`<li>${match[1]}</li>`);
    } else {
      if (inList) {
        output.push('</ul>');
        inList = false;
      }
      output.push(line);
    }
  }
  if (inList) {
    output.push('</ul>');
  }

  // Wrap loose lines into paragraphs when they are plain text.
  const joined = output.join('\n');
  return joined
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('<pre') || trimmed.startsWith('<hr')) {
        return trimmed;
      }
      return `<p>${trimmed}</p>`;
    })
    .filter(Boolean)
    .join('\n');
};

const DEFAULT_STYLES = `
:root {
  color-scheme: light;
}
body {
  font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  margin: 0;
  padding: 2rem;
  background: #f5f7fb;
  color: #0f172a;
}
.deck {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.section {
  background: white;
  border-radius: 24px;
  padding: 2rem;
  box-shadow: 0 20px 45px rgba(15, 23, 42, 0.08);
  border: 1px solid rgba(15, 23, 42, 0.05);
}
.section h2 {
  margin-top: 0;
}
ul {
  padding-left: 1.25rem;
}
blockquote {
  margin: 1rem 0;
  padding-left: 1rem;
  border-left: 4px solid #94a3b8;
  color: #475569;
}
`;

const wrapHtmlDocument = (payload: string): string => {
  if (/<!DOCTYPE\s+html>/i.test(payload) || /<html[\s>]/i.test(payload)) {
    return payload;
  }
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generated Presentation</title>
    <style>${DEFAULT_STYLES}</style>
  </head>
  <body>
    <div class="deck">
      <div class="section">
        ${payload}
      </div>
    </div>
  </body>
</html>`;
};

const humanizeFileName = (name: string): string => {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;
};

export const renderFallbackPresentation = (files: PresentationSourceFile[], brief?: string): string => {
  if (!files.length) {
    throw new Error('No files supplied for presentation fallback');
  }

  const title = (brief && brief.trim()) || 'Generated Presentation';
  const sourceList = files.map((f) => humanizeFileName(f.name)).join(', ');

  const sectionBlocks = files.map((file) => {
    const sectionTitle = humanizeFileName(file.name);
    const content = typeof file.content === 'string' ? file.content : '';
    const html = marked.parse(content || '') as string;
    return `<div class="section">
  <h2>${sectionTitle}</h2>
  ${html}
</div>`;
  });

  const nextSteps = `<div class="section">
  <h2>Next Steps</h2>
  <ul>
    <li>Review this deck for accuracy and tone.</li>
    <li>Update any figures or timelines based on latest inputs.</li>
    <li>Share with stakeholders for sign-off.</li>
  </ul>
</div>`;

  const hero = `<div class="section">
  <h1>${title}</h1>
  <p>Compiled from: ${sourceList}</p>
</div>`;

  const body = [hero, ...sectionBlocks, nextSteps].join('\n');
  return wrapHtmlDocument(body);
};

export const extractHtmlFromAgentResponse = (raw: string): string => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    throw new Error('Agent returned an empty response');
  }
  const withoutFence = stripHtmlCodeFence(trimmed);
  if (/<!DOCTYPE\s+html>/i.test(withoutFence) || /<html[\s>]/i.test(withoutFence)) {
    return withoutFence;
  }

  const hasHtmlTags = /<(h[1-6]|p|ul|ol|li|section|div|blockquote|pre)\b/i.test(withoutFence);
  const normalized = hasHtmlTags ? convertMermaidBlocks(withoutFence) : convertSimpleMarkdown(withoutFence);

  // Basic validation: require at least one heading and a minimum content length to avoid empty/mermaid-only outputs.
  const textStripped = normalized.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/<h[1-6][^>]*>/i.test(normalized) || textStripped.split(' ').length < 40) {
    throw new Error('Agent returned insufficient presentation content');
  }

  return wrapHtmlDocument(normalized);
};
