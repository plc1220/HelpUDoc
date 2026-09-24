import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import type { FileProvenanceDocument, FileProvenanceEvent } from '../types';
import {
  fetchFileProvenance,
  downloadFileProvenance,
  verifyFileProvenance,
  type FileProvenanceVerification,
} from '../services/fileProvenanceApi';

/**
 * Where a document came from: who touched it, and for anything the agent wrote,
 * the prompt and sources behind it.
 */

const EVENT_LABELS: Record<string, string> = {
  'file.created': 'Created',
  'file.content_updated': 'Edited',
  'file.agent_generated': 'Written by the agent',
  'file.renamed': 'Renamed',
  'file.moved': 'Moved',
  'file.restored': 'Restored from an earlier version',
  'file.deleted': 'Deleted',
  'file.synced_from_publication': 'Arrived from another workspace',
  'file.tombstoned_by_sync': 'Removed by a sync',
  'file.workspace_published': 'Included in a workspace release',
  'file.workspace_withdrawn': 'Workspace release withdrawn',
  'status.submitted': 'Submitted for review',
  'status.approved': 'Approved',
  'status.changes_requested': 'Changes requested',
  'status.published': 'Published',
  'status.reverted': 'Sent back',
  'status.unpublished': 'Unpublished',
  'status.inherited': 'Status inherited from Shared',
};

const formatWhen = (value?: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

const actorName = (event: FileProvenanceEvent) =>
  event.actor?.displayName || event.actor?.userId || 'system';

/** The prompt, sources and reply behind an agent-written version. */
const AgentDetail: React.FC<{ event: FileProvenanceEvent }> = ({ event }) => {
  const provenance = event.provenance;
  if (!provenance) return null;

  const chunks = provenance.knowledgeChunksRetrieved ?? [];
  const skills = provenance.skillsInvoked ?? [];

  return (
    <VStack gap={2} paddingInline={3} paddingBlock={2}>
      {provenance.userPrompt && (
        <VStack gap={0.5}>
          <Text type="label">Asked</Text>
          <Text type="body">{provenance.userPrompt}</Text>
        </VStack>
      )}

      {provenance.responseText && (
        <VStack gap={0.5}>
          <Text type="label">Answered</Text>
          <Text type="supporting" maxLines={6}>{provenance.responseText}</Text>
        </VStack>
      )}

      {skills.length > 0 && (
        <HStack gap={1} wrap="wrap">
          <Text type="label">Skills</Text>
          {skills.map((skill) => (
            <Badge key={skill.skillId} variant="teal" label={skill.skillId} />
          ))}
        </HStack>
      )}

      {chunks.length > 0 && (
        <VStack gap={0.5}>
          <Text type="label">{`Read ${chunks.length} passage${chunks.length === 1 ? '' : 's'}`}</Text>
          {chunks.slice(0, 8).map((chunk) => (
            <Text key={`${chunk.path}-${chunk.snapshotId ?? ''}`} type="supporting">
              {chunk.title || chunk.path}
              {(chunk.sourceLocations?.length ?? 0) > 0
                ? ` · pages ${(chunk.sourceLocations as Array<{ pageStart?: number; pageEnd?: number }>)
                  .map((l) => (l.pageStart === l.pageEnd ? l.pageStart : `${l.pageStart}-${l.pageEnd}`))
                  .join(', ')}`
                : ''}
            </Text>
          ))}
          {chunks.length > 8 && (
            <Text type="supporting">{`and ${chunks.length - 8} more`}</Text>
          )}
        </VStack>
      )}

      {provenance.langfuseTraceUrl && (
        <Text type="supporting">
          <a href={provenance.langfuseTraceUrl} target="_blank" rel="noreferrer">
            View the full trace
          </a>
        </Text>
      )}
    </VStack>
  );
};

const EventRow: React.FC<{ event: FileProvenanceEvent }> = ({ event }) => {
  const label = EVENT_LABELS[event.eventType] || event.eventType;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const summary = (
    <HStack gap={2} hAlign="between" width="100%">
      <VStack gap={0}>
        <HStack gap={1.5}>
          <Text type="body" weight="medium">{label}</Text>
          {event.actorType === 'agent' && <Badge variant="purple" label="agent" />}
          {event.chain === 'prior' && <Badge variant="neutral" label="before publication" />}
        </HStack>
        <Text type="supporting">
          {actorName(event)}
          {event.fileVersion ? ` · v${event.fileVersion}` : ''}
          {` · ${formatWhen(event.occurredAt)}`}
        </Text>
        {typeof payload.reason === 'string' && payload.reason && (
          <Text type="supporting">{`“${payload.reason}”`}</Text>
        )}
        {typeof payload.previousPath === 'string' && (
          <Text type="supporting">{`was ${payload.previousPath}`}</Text>
        )}
      </VStack>
    </HStack>
  );

  // Only agent events have anything worth expanding into.
  return event.provenance
    ? <Collapsible trigger={summary} defaultIsOpen={false}><AgentDetail event={event} /></Collapsible>
    : <VStack paddingBlock={1}>{summary}</VStack>;
};

export const FileProvenanceDialog: React.FC<{
  isOpen: boolean;
  workspaceId: string;
  fileId: number | string;
  onOpenChange: (isOpen: boolean) => void;
}> = ({ isOpen, workspaceId, fileId, onOpenChange }) => {
  const [document, setDocument] = useState<FileProvenanceDocument | null>(null);
  const [verification, setVerification] = useState<FileProvenanceVerification | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [doc, check] = await Promise.all([
        fetchFileProvenance(workspaceId, fileId),
        // Integrity is checked separately so a failure here does not hide the
        // history itself.
        verifyFileProvenance(workspaceId, fileId).catch(() => null),
      ]);
      setDocument(doc);
      setVerification(check);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load file history');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fileId]);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  const events = document?.events ?? [];

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={720} purpose="info">
      <DialogHeader
        title="File history"
        subtitle={document?.file.name}
        onOpenChange={onOpenChange}
      />
      <VStack gap={2} padding={3} isScrollable>
        {loading && <Text type="supporting">Loading…</Text>}
        {error && <Text type="body" color="accent">{error}</Text>}

        {document && (
          <HStack gap={2} hAlign="between">
            <Text type="supporting">
              {`${document.integrity.eventCount} event${document.integrity.eventCount === 1 ? '' : 's'}`}
              {document.origin.priorWorkspace
                ? ' · continues from another workspace'
                : ''}
            </Text>
            {verification && (
              <Badge
                variant={verification.valid ? 'success' : 'error'}
                label={verification.valid ? 'History intact' : `Altered at event ${verification.brokenAtSeq}`}
              />
            )}
          </HStack>
        )}

        {events.length === 0 && !loading && !error && (
          <Text type="supporting">Nothing has been recorded for this file yet.</Text>
        )}

        {/* Newest first: the most recent change is what a reader is usually after. */}
        {[...events].reverse().map((event) => (
          <EventRow key={`${event.chain}-${event.seq}`} event={event} />
        ))}

        {document && (
          <HStack gap={2}>
            <Button
              variant="secondary"
              label="Download as JSON"
              clickAction={() => downloadFileProvenance(workspaceId, fileId)}
            />
          </HStack>
        )}
      </VStack>
    </Dialog>
  );
};

export default FileProvenanceDialog;
