type SlideTurn = {
  frontendSlidesEditExisting?: boolean;
  prompt?: string;
  messageContent?: Array<{ type: string; [key: string]: unknown }>;
  history?: Array<{ role: string; content: string }>;
};

const newDeck = /\b(?:start over|start from scratch)\b|\b(?:create|build|generate|start)\b[^.!?\n]{0,60}\b(?:new|another|separate)\s+(?:html\s+)?(?:deck|presentation)\b/i;
const edit = /\b(?:edit|revise|update|modify|fix|polish|adjust|change|improve|enhance|iterate|restyle|redesign|reword|rewrite|shorten|simplify|replace|remove|delete|add|insert|move|reorder|enlarge|reduce|switch|use|apply)\b|\bmake\s+(?:it|this|that|the|slide|slides)\b/i;
const slideReference = /\b(?:it|this|that|slides?|deck|presentation|title|font|colou?r|layout|style|chart|image|summary|conclusion|bullet|typography|background)\b/i;
const htmlArtifact = /(?:^|[\s`"'(@/])[^\s`"'<>]+\.html?\b/i;

export function isFrontendSlidesEditExistingRun(params: SlideTurn): boolean {
  const current = [params.prompt || '', ...(params.messageContent || [])
    .filter(block => block.type === 'text')
    .map(block => String(block.text || ''))].join(' ');
  if (newDeck.test(current)) return false;
  if (params.frontendSlidesEditExisting === true) return true;
  if (!edit.test(current)) return false;
  // User-targeted HTML and explicit existing-deck references work in new chats.
  if (htmlArtifact.test(current) || /\b(?:existing|current)\s+(?:deck|slides|presentation)\b/i.test(current)) return true;
  // A previous user request for an HTML output is not evidence of delivery.
  const deliveredDeck = (params.history || []).some(entry =>
    /^(?:assistant|ai)$/i.test(entry.role)
    && htmlArtifact.test(entry.content.replace(/\S*(?:slide-previews\/|style-[abc]\.html|\.style-preview-)\S*/gi, '')));
  return deliveredDeck && slideReference.test(current);
}

export function slideEditArtifactCandidates(params: SlideTurn): string[] {
  const texts = [params.prompt || '', ...(params.history || [])
    .filter(entry => /^(assistant|ai)$/i.test(entry.role)).reverse().map(entry => entry.content)];
  for (const text of texts) {
    const paths = (text.match(/[^\s`"'<>()[\]]+\.html?\b/gi) || [])
      .map(path => path.replace(/^@/, ''))
      .filter(path => !/slide-previews\/|\.style-preview-|(?:^|\/)style-[abc]\.html?$/i.test(path));
    if (paths.length) return [...new Set(paths)];
  }
  return [];
}
