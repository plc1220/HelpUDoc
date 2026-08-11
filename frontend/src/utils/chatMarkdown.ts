/**
 * Removes stale frontend-slides UI instructions without changing Markdown
 * structure. In particular, blank lines and list indentation must survive.
 */
export const stripDeadFrontendSlidesUiReferences = (text: string): string => (
  text
    .replace(/\b(?:I have|I've)\s+(?:created|prepared|provided|opened|set up)\b[^.!?]*(?:Presentation Context|context)[^.!?]*\bform\b[^.!?]*[.!?]/gis, '')
    .replace(/\bPlease\s+(?:fill out|complete|submit)\b[^.!?]*\b(?:form|questions?)\s+(?:above|below)\b[^.!?]*[.!?]/gis, '')
    .replace(/\bPlease\s+(?:review\s+and\s+)?(?:select|choose|pick)\b[^.!?]*\b(?:interactive\s+)?(?:selector|chooser|form)\s+(?:above|below)\b[^.!?]*[.!?]/gis, '')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);
