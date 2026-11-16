import { z } from 'zod';
import { signAgentContextToken } from './agentToken';
import { CalendarError } from './calendarModel';
import { readBoundedResponse } from './calendarBrief';

const MAX_BYTES = 8 * 1024 * 1024;
const supported = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const resultSchema = z.object({ text: z.string().max(12000), gaps: z.array(z.string().max(500)).max(20) }).strict();

/** Runs deterministic bounded parsing on the existing Agent service. The caller
 * must already verify linked-source permission and explicit content consent. */
export class CalendarDocumentText {
  constructor(private readonly transport: typeof fetch = fetch, private readonly agentUrl = process.env.AGENT_URL || 'http://localhost:8001') {}
  async read(userId: string, bytes: Buffer, mime: string, filename: string): Promise<{ text: string; gaps: string[] }> {
    if (!supported.has(mime)) throw new CalendarError(422, 'UNSUPPORTED_SOURCE', 'This document format is not supported for briefing text.');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw new CalendarError(413, 'SOURCE_TOO_LARGE', 'Document exceeds the 8 MiB briefing input limit.');
    const parts = filename.split(/[\\/]/);
    const safeName = parts[parts.length - 1]?.replace(/[\x00-\x1f:]/g, '_').slice(0, 200) || 'document';
    const token = signAgentContextToken({ sub: userId, userId, isAdmin: false, skillAllowIds: [], mcpServerAllowIds: [], exp: Math.floor(Date.now() / 1000) + 30 });
    if (!token) throw new CalendarError(503, 'DOCUMENT_TEXT_UNAVAILABLE', 'Document text extraction is unavailable.');
    let response: Response;
    try {
      response = await this.transport(`${this.agentUrl.replace(/\/$/, '')}/internal/calendar/document-text`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: safeName, mime_type: mime, content: bytes.toString('base64') }), signal: AbortSignal.timeout(10000),
      });
    } catch { throw new CalendarError(503, 'DOCUMENT_TEXT_UNAVAILABLE', 'Document text extraction could not finish within briefing limits.'); }
    if (!response.ok) throw new CalendarError(response.status === 413 ? 413 : response.status === 422 ? 422 : 503, 'DOCUMENT_TEXT_UNAVAILABLE', 'Document text was unavailable within supported briefing limits.');
    try { return resultSchema.parse(JSON.parse(await readBoundedResponse(response, 65536))); }
    catch { throw new CalendarError(422, 'DOCUMENT_TEXT_UNREADABLE', 'Document text extraction did not return supported bounded text.'); }
  }
}
