export type SlideStyle = {
  id: string; name: string; description: string; tags: string[]; group: string;
  scheme: string; palette: string[]; editorial: boolean; previewPath: string; designPath: string;
  thumbnail?: { src: string; width: number; height: number; sourceHash: string; fonts: string[] };
};

export type BrowseSlideStylesRequest = {
  workspaceId: string; interactionId: string;
  onSelect: (style: SlideStyle) => Promise<void>;
};

export function isHtmlSlideDeck(name: string, html: string): boolean {
  return /\.html?$/i.test(name) && !/\.style-preview-/i.test(name)
    && /(?:class\s*=\s*["'][^"']*\bslide\b|data-slide(?:-index)?\s*=|reveal[\s\S]{0,100}slides)/i.test(html);
}

export function stylePreviewPath(source: string, token: string): string {
  if (!/^[a-z0-9-]+$/i.test(token)) throw new Error('Invalid preview identifier.');
  return source.replace(/[^/]+$/, `.style-preview-${token}.html`);
}

export function buildStylePreviewPrompt(source: string, output: string, style: SlideStyle): string {
  return [
    `SLIDE_STYLE_PREVIEW ${JSON.stringify({ source, output })}`,
    `Restyle the existing HTML deck ${JSON.stringify(source)} using the ${style.name} style.`,
    'This is a preview of an existing deck, not a new presentation. Load frontend-slides in Mode C; skip all creation/setup gates.',
    `The style is already selected. Read ${JSON.stringify(style.designPath)} inside frontend-slides, then read the current source deck.`,
    `Write the complete restyled deck ONLY to ${JSON.stringify(output)}. Do not modify the source, shared assets, or any other file.`,
    'Keep every slide, its content, order, density, and relative asset references. Change only typography, colors, layout and visual treatments.',
    'Use inline CSS and existing assets. Preserve a responsive fixed 16:9 stage. Do not use scripts, shell tools, subagents or external tools to write files.',
    'Validate the HTML and deliver that preview file without asking for another style selection. The UI handles comparison and explicit Apply.',
  ].join('\n');
}

export function assertUnchangedDeck(base: { content: string; version?: number }, latest: { content?: string; version?: number }) {
  if (!base.version || latest.version !== base.version || latest.content !== base.content) {
    throw new Error('This deck changed since the preview was requested. Generate a fresh preview before applying.');
  }
}

export function withActiveSlideContext(prompt: string, source: string | undefined): string {
  if (!source || /\b(?:start over|start from scratch)\b|\b(?:new|another|separate)\s+(?:html\s+)?(?:deck|presentation)\b/i.test(prompt)) return prompt;
  // An explicit file reference always beats the open canvas.
  if (/\.html?\b/i.test(prompt)) return prompt;
  const edit = /\b(?:edit|revise|update|fix|polish|adjust|change|improve|restyle|redesign|shorten|simplify|replace|remove|add|insert|move|reorder|switch|use|apply|make)\b/i;
  const subject = /\b(?:it|this|that|slides?|deck|presentation|title|font|colou?r|layout|style|chart|image|summary|conclusion|bullet|typography|background)\b/i;
  if (!edit.test(prompt) || !subject.test(prompt)) return prompt;
  return `${prompt}\n\nContinue editing the currently open HTML deck ${JSON.stringify(source)}. Read that existing file first; do not restart presentation setup or switch to a previously delivered deck. Keep its filename and content except for the requested changes.`;
}
