/**
 * Extract the first YAML frontmatter block after leading `---` (settings-style).
 */
export function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }
  return match[1];
}
