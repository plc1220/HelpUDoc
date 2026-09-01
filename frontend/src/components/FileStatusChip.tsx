import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';

import type { FileStatus, FileStatusState, FileStatusTransition } from '../types';
import {
  FILE_STATUS_DOT,
  FILE_STATUS_LABELS,
  FILE_STATUS_ORDER,
  changeFileStatus,
  fetchFileStatus,
} from '../services/fileProvenanceApi';

/**
 * A file's status, shown where the file is: in the list and in the editor
 * header, rather than collected in a separate panel.
 *
 * The chip is the control. Opening it fetches what this user may actually do
 * with this file, so the menu reflects the server's rules rather than guessing
 * at them. Statuses that are not reachable stay visible but disabled, which
 * tells a reader where a file sits in the lifecycle even when they cannot move
 * it.
 */

const PUBLISH_NOTICE =
  'Publishing exports this file and its full history, including any prompts and '
  + 'agent replies, as a permanent record that cannot later be edited or removed.';

export const FileStatusChip: React.FC<{
  workspaceId: string;
  fileId: number | string;
  status: FileStatus;
  drift?: boolean;
  size?: 'sm' | 'md';
  onChanged?: (state: FileStatusState) => void;
}> = ({ workspaceId, fileId, status, drift, size = 'sm', onChanged }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<FileStatusState | null>(null);
  const [pending, setPending] = useState<FileStatusTransition | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  // Fetched lazily: loading permitted moves for every row up front would be one
  // request per file for something most rows never open.
  const loadStatus = useCallback(async () => {
    try {
      setState(await fetchFileStatus(workspaceId, fileId));
    } catch {
      setState(null);
    }
  }, [workspaceId, fileId]);

  // The menu reports open/close here, but not reliably on the trigger click
  // itself, so the fetch is driven from onClick below as well. Without it every
  // option renders disabled, because nothing has said what is permitted yet.
  const openMenu = useCallback((open: boolean) => {
    setIsOpen(open);
    if (open) void loadStatus();
  }, [loadStatus]);

  const apply = useCallback(async (transition: FileStatusTransition, reason: string) => {
    setError('');
    try {
      const next = await changeFileStatus(workspaceId, fileId, {
        toStatus: transition.toStatus,
        ...(reason ? { reason } : {}),
        ...(state ? { expectedVersion: state.version } : {}),
      });
      setPending(null);
      setNote('');
      setState(next);
      onChanged?.(next);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Could not change the status');
    }
  }, [workspaceId, fileId, state, onChanged]);

  const choose = useCallback((transition: FileStatusTransition) => {
    // Close the menu before the dialog opens, so it is not left hanging behind
    // the modal once focus moves.
    setIsOpen(false);
    if (transition.requiresReason || transition.toStatus === 'published') {
      setPending(transition);
      setNote('');
      setError('');
      return;
    }
    void apply(transition, '');
  }, [apply]);

  const allowed = state?.allowedTransitions ?? [];
  const items = FILE_STATUS_ORDER.map((candidate) => {
    const transition = allowed.find((entry) => entry.toStatus === candidate);
    const isCurrent = candidate === (state?.status ?? status);
    return {
      label: FILE_STATUS_LABELS[candidate],
      icon: <StatusDot variant={FILE_STATUS_DOT[candidate]} label={FILE_STATUS_LABELS[candidate]} />,
      isDisabled: isCurrent || !transition,
      onClick: transition ? () => choose(transition) : undefined,
    };
  });

  const shown = state?.status ?? status;
  const showDrift = state ? state.drift : Boolean(drift);

  return (
    <>
      <DropdownMenu
        isMenuOpen={isOpen}
        onOpenChange={openMenu}
        onClick={() => { setIsOpen(true); void loadStatus(); }}
        menuWidth={220}
        items={items}
        button={{
          size,
          variant: 'ghost',
          label: showDrift ? `${FILE_STATUS_LABELS[shown]} · edited since` : FILE_STATUS_LABELS[shown],
          icon: <StatusDot variant={FILE_STATUS_DOT[shown]} label={FILE_STATUS_LABELS[shown]} />,
        }}
      />

      {/* Portalled to the body so the dialog is not nested inside the file
          row's role=button, which is invalid structurally and leaves the
          dialog's focus and keyboard behaviour entangled with the row. */}
      {createPortal(
        <Dialog
        isOpen={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        width={480}
        purpose="form"
      >
        <DialogHeader
          title={pending?.label ?? ''}
          subtitle={pending
            ? `${FILE_STATUS_LABELS[shown]} → ${FILE_STATUS_LABELS[pending.toStatus]}`
            : undefined}
          onOpenChange={() => setPending(null)}
        />
        <VStack gap={2} padding={3}>
          {pending?.toStatus === 'published' && (
            <Text type="supporting">{PUBLISH_NOTICE}</Text>
          )}
          {pending?.requiresReason && (
            <TextArea
              label="Reason"
              value={note}
              onChange={setNote}
              rows={3}
              placeholder="Why is this going back?"
              // Something above this dialog cancels space at the body level —
              // the usual "stop the page scrolling behind a modal" guard, which
              // does not exempt text fields. Keep the keystroke local so the
              // reason box can actually contain spaces.
              onKeyDown={(event: React.KeyboardEvent) => {
                if (event.key === ' ') event.stopPropagation();
              }}
            />
          )}
          {error && <Text type="body" color="accent">{error}</Text>}
          <HStack gap={2} hAlign="end">
            <Button variant="ghost" label="Cancel" onClick={() => setPending(null)} />
            <Button
              variant="primary"
              label={pending?.label ?? 'Confirm'}
              isDisabled={Boolean(pending?.requiresReason) && note.trim().length < 3}
              clickAction={() => (pending ? apply(pending, note.trim()) : Promise.resolve())}
            />
          </HStack>
        </VStack>
        </Dialog>,
        document.body,
      )}
    </>
  );
};

export default FileStatusChip;
