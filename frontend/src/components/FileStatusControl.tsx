import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { FileStatus, FileStatusState, FileStatusTransition } from '../types';
import {
  FILE_STATUS_LABELS,
  changeFileStatus,
  fetchFileStatus,
} from '../services/fileProvenanceApi';

/**
 * Moves a file through its editorial lifecycle.
 *
 * Only the transitions the server says this user may make are offered. The
 * server still enforces them — this just avoids showing actions that would be
 * refused.
 */

/** Publishing freezes the prompt history permanently; say so before it happens. */
const PUBLISH_NOTICE =
  'Publishing exports this file and its full history, including any prompts and '
  + 'agent replies, as a permanent record that cannot later be edited or removed.';

export const FileStatusControl: React.FC<{
  workspaceId: string;
  fileId: number | string;
  onChanged?: (state: FileStatusState) => void;
}> = ({ workspaceId, fileId, onChanged }) => {
  const [state, setState] = useState<FileStatusState | null>(null);
  const [pending, setPending] = useState<FileStatusTransition | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await fetchFileStatus(workspaceId, fileId));
    } catch {
      setState(null);
    }
  }, [workspaceId, fileId]);

  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async (transition: FileStatusTransition, withReason: string) => {
    setError('');
    try {
      const next = await changeFileStatus(workspaceId, fileId, {
        toStatus: transition.toStatus,
        ...(withReason ? { reason: withReason } : {}),
        // Refuses the change if someone edited the file since it was read.
        ...(state ? { expectedVersion: state.version } : {}),
      });
      setState(next);
      setPending(null);
      setReason('');
      onChanged?.(next);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Could not change the status');
    }
  }, [workspaceId, fileId, state, onChanged]);

  const onSelect = useCallback((transition: FileStatusTransition) => {
    // A reason is mandatory server-side for reverts, and publishing needs an
    // acknowledgement, so both go through the dialog.
    if (transition.requiresReason || transition.toStatus === 'published') {
      setPending(transition);
      setReason('');
      setError('');
      return;
    }
    void apply(transition, '');
  }, [apply]);

  if (!state) return null;

  const statusLabel = FILE_STATUS_LABELS[state.status as FileStatus];

  return (
    <VStack gap={1.5}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="label">{statusLabel}</Text>
        {state.drift && (
          <Badge
            variant="warning"
            label={`edited since v${state.approvedAtVersion ?? state.publishedAtVersion}`}
          />
        )}
        {state.allowedTransitions.map((transition) => (
          <Button
            key={transition.toStatus}
            size="sm"
            variant={transition.isRevert ? 'ghost' : 'secondary'}
            label={transition.label}
            clickAction={() => onSelect(transition)}
          />
        ))}
      </HStack>

      {state.allowedTransitions.length === 0 && (
        <Text type="supporting">You cannot change this file&apos;s status.</Text>
      )}

      {error && <Text type="body" color="accent">{error}</Text>}

      <Dialog
        isOpen={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        width={520}
        purpose="form"
      >
        <DialogHeader
          title={pending?.label ?? ''}
          subtitle={pending ? `${statusLabel} → ${FILE_STATUS_LABELS[pending.toStatus]}` : undefined}
          onOpenChange={() => setPending(null)}
        />
        <VStack gap={2} padding={3}>
          {pending?.toStatus === 'published' && (
            <Text type="supporting">{PUBLISH_NOTICE}</Text>
          )}
          {pending?.requiresReason && (
            <TextInput
              label="Reason"
              value={reason}
              onChange={setReason}
              placeholder="Why is this going back?"
            />
          )}
          {error && <Text type="body" color="accent">{error}</Text>}
          <HStack gap={2} hAlign="end">
            <Button variant="ghost" label="Cancel" onClick={() => setPending(null)} />
            <Button
              variant="primary"
              label={pending?.label ?? 'Confirm'}
              isDisabled={Boolean(pending?.requiresReason) && !reason.trim()}
              clickAction={() => (pending ? apply(pending, reason.trim()) : Promise.resolve())}
            />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
};

export default FileStatusControl;
