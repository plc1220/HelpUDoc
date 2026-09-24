import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { MoreHorizontal } from 'lucide-react';

import type { FileStatus, FileStatusState, FileStatusTransition } from '../types';
import {
  FILE_STATUS_DOT,
  FILE_STATUS_LABELS,
  changeFileStatus,
  fetchFileStatus,
} from '../services/fileProvenanceApi';

/**
 * A file's status, shown where the file is: in the list and in the editor
 * header, rather than collected in a separate panel.
 *
 * The chip is the control. Opening it fetches what this user may actually do
 * with this file, so the menu reflects the server's rules rather than guessing
 * at them. The current status stays on the chip; the menu contains only actions
 * this user can take.
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
  hideSubmitForReview?: boolean;
  extraItems?: DropdownMenuOption[];
  compact?: boolean;
  onChanged?: (state: FileStatusState) => void;
}> = ({ workspaceId, fileId, status, drift, size = 'sm', hideSubmitForReview = false, extraItems = [], compact = false, onChanged }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<FileStatusState | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [statusLoadFailed, setStatusLoadFailed] = useState(false);
  const [pending, setPending] = useState<FileStatusTransition | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  // Fetched lazily: loading permitted moves for every row up front would be one
  // request per file for something most rows never open.
  const loadStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    setStatusLoadFailed(false);
    try {
      setState(await fetchFileStatus(workspaceId, fileId));
    } catch {
      setState(null);
      setStatusLoadFailed(true);
    } finally {
      setIsLoadingStatus(false);
    }
  }, [workspaceId, fileId]);

  const openMenu = useCallback((open: boolean) => {
    setIsOpen(open);
    if (open) {
      setState(null);
      void loadStatus();
    }
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

  const transitions = (state?.allowedTransitions ?? []).filter(
    (transition) => !hideSubmitForReview || transition.label !== 'Submit for review',
  );
  const statusItems: DropdownMenuOption[] = state
    ? transitions.length > 0
      ? transitions.map((transition) => ({
        label: transition.label,
        icon: <StatusDot
          variant={FILE_STATUS_DOT[transition.toStatus]}
          label={FILE_STATUS_LABELS[transition.toStatus]}
        />,
        onClick: () => choose(transition),
      }))
      : [{ label: 'No status actions available', isDisabled: true }]
    : [{
      label: statusLoadFailed
        ? 'Could not load status actions'
        : isLoadingStatus
          ? 'Loading status actions…'
          : 'Status actions unavailable',
      isDisabled: true,
    }];
  const items: DropdownMenuOption[] = extraItems.length > 0
    ? [...statusItems, { type: 'divider' }, ...extraItems]
    : statusItems;

  const shown = state?.status ?? status;
  const showDrift = state ? state.drift : Boolean(drift);

  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          className="file-status-color-dot inline-flex h-5 w-5 items-center justify-center rounded-full"
          data-file-status={shown}
          aria-label={`${FILE_STATUS_LABELS[shown]}${showDrift ? ', edited since' : ''}`}
          title={`${FILE_STATUS_LABELS[shown]}${showDrift ? ' · edited since' : ''}`}
        >
          <span className="h-2 w-2 rounded-full" aria-hidden="true" />
        </span>
        <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <DropdownMenu
            isMenuOpen={isOpen}
            onOpenChange={openMenu}
            menuWidth={260}
            items={items}
            hasChevron={false}
            button={{
              size,
              variant: 'ghost',
              label: `Actions for ${FILE_STATUS_LABELS[shown]}`,
              icon: <MoreHorizontal size={16} />,
              isIconOnly: true,
            }}
          />
        </span>
        {createPortal(
          <Dialog
            isOpen={pending !== null}
            onOpenChange={(open) => { if (!open) setPending(null); }}
            width={480}
            purpose="form"
          >
            <DialogHeader
              title={pending?.label ?? ''}
              subtitle={pending ? `${FILE_STATUS_LABELS[shown]} → ${FILE_STATUS_LABELS[pending.toStatus]}` : undefined}
              onOpenChange={() => setPending(null)}
            />
            <VStack gap={2} padding={3}>
              {pending?.toStatus === 'published' && <Text type="supporting">{PUBLISH_NOTICE}</Text>}
              {pending?.requiresReason && (
                <TextArea
                  label="Reason"
                  value={note}
                  onChange={setNote}
                  rows={3}
                  placeholder="Why is this going back?"
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
      </span>
    );
  }

  if (hideSubmitForReview && shown === 'draft' && extraItems.length === 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300">
        <StatusDot variant={FILE_STATUS_DOT[shown]} label={FILE_STATUS_LABELS[shown]} />
        {showDrift ? `${FILE_STATUS_LABELS[shown]} · edited since` : FILE_STATUS_LABELS[shown]}
      </span>
    );
  }

  return (
    <>
      <DropdownMenu
        isMenuOpen={isOpen}
        onOpenChange={openMenu}
        menuWidth={260}
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
