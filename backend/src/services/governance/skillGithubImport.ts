import crypto from 'crypto';
import path from 'path';
import { HttpError } from '../../errors';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 30;
const textExtensions = new Set(['.md', '.txt', '.py', '.js', '.ts', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.html', '.css', '.sql', '.sh']);
export function parseGithubSkillUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, 'Enter a public GitHub repository, folder, or SKILL.md URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search) {
    throw new HttpError(400, 'Use an HTTPS github.com link without credentials or query parameters');
  }
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent);
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part)) || !/^[\w.-]+$/.test(parts[0] || '') || !/^[\w.-]+$/.test(parts[1] || '')) throw new HttpError(400, 'Invalid GitHub path');
  if (parts.length > 2 && (!['tree', 'blob'].includes(parts[2]) || !parts[3])) throw new HttpError(400, 'Use a repository, tree, or blob GitHub URL');
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, ''), ref: parts[3] || 'HEAD', folder: parts.slice(4).join('/'), blob: parts[2] === 'blob' };
}

// Only a fixed GitHub API origin is reachable. Never follow repository-controlled URLs or redirects.
async function githubJson(apiPath: string, fetcher: typeof fetch, signal: AbortSignal): Promise<any> {
  const response = await fetcher(`https://api.github.com${apiPath}`, { redirect: 'error', signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HelpUDoc-Skill-Creator' } });
  if (!response.ok) throw new HttpError(400, response.status === 404 ? 'Public repository or ref not found. For branch names containing slashes, use a commit permalink.' : `GitHub import failed (${response.status}); check the public link or retry after rate limits reset`);
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(400, 'GitHub returned an empty response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 8 * MAX_BYTES) { await reader.cancel(); throw new HttpError(400, 'GitHub response is too large'); } chunks.push(next.value); }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

export async function importGithubSkill(url: string, fetcher: typeof fetch = fetch) {
  const parsed = parseGithubSkillUrl(url);
  const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const signal = AbortSignal.timeout(45000);
  const commit = await githubJson(`${base}/commits/${encodeURIComponent(parsed.ref)}`, fetcher, signal);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new HttpError(400, 'GitHub did not resolve an immutable commit');
  const tree = await githubJson(`${base}/git/trees/${commit.sha}?recursive=1`, fetcher, signal);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new HttpError(400, 'Repository tree is too large to import safely');
  let folder = parsed.folder;
  if (parsed.blob) {
    if (path.posix.basename(folder) !== 'SKILL.md') throw new HttpError(400, 'Select a SKILL.md file or skill folder');
    folder = path.posix.dirname(folder); if (folder === '.') folder = '';
  }
  const skillPath = folder ? `${folder}/SKILL.md` : 'SKILL.md';
  if (!tree.tree.some((entry: any) => entry.path === skillPath && entry.type === 'blob' && entry.mode === '100644')) {
    const choices = tree.tree.filter((entry: any) => /(^|\/)SKILL\.md$/.test(entry.path)).slice(0, 10).map((entry: any) => entry.path);
    throw new HttpError(400, `Select a folder containing SKILL.md.${choices.length ? ` Found: ${choices.join(', ')}` : ''}`);
  }
  const entries = tree.tree.filter((entry: any) => entry.type !== 'tree' && (!folder || entry.path.startsWith(`${folder}/`)));
  if (entries.length > MAX_FILES) throw new HttpError(400, `Select a smaller skill folder (maximum ${MAX_FILES} files)`);
  const files: Array<{ path: string; content: string; sha256: string }> = [];
  let size = 0;
  for (const entry of entries) {
    const relative = folder ? entry.path.slice(folder.length + 1) : entry.path;
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob' || relative.split('/').some((p: string) => !p || p === '.' || p === '..') || relative.includes('\\')) throw new HttpError(400, 'Skill imports cannot contain symlinks, submodules, or unsafe paths');
    if (!textExtensions.has(path.posix.extname(relative).toLowerCase()) && !/^(LICENSE|NOTICE)(\.[\w-]+)?$/i.test(path.posix.basename(relative))) throw new HttpError(400, `Unsupported source file ${relative}. This import supports text skill packages; upload binary assets separately.`);
    size += Number(entry.size || 0);
    if (size > MAX_BYTES) throw new HttpError(400, 'Skill import exceeds 2 MB');
    if (!/^[a-f0-9]{40}$/.test(entry.sha)) throw new HttpError(400, 'Invalid GitHub blob');
    const blob = await githubJson(`${base}/git/blobs/${entry.sha}`, fetcher, signal);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new HttpError(400, 'Unsupported GitHub content');
    const bytes = Buffer.from(blob.content, 'base64');
    if (bytes.length !== entry.size || crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) throw new HttpError(400, 'GitHub file integrity check failed');
    let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new HttpError(400, `Non-text source file: ${relative}`); }
    if (content.includes('\0')) throw new HttpError(400, `Binary source file: ${relative}`);
    files.push({ path: relative, content, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  return { source: { url, repository: `${parsed.owner}/${parsed.repo}`, commit: commit.sha, folder, importedAt: new Date().toISOString() }, files };
}
