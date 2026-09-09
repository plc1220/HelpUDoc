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
 *
 * `compact` is the file-list form: a tinted label and no chevron. It also drops
 * drift from the visible text — inline, "Draft · edited since" was the widest
 * state a row could reach, and it was what pushed filenames into an ellipsis.
 * The drift pill is drawn by the row instead, as a sibling on the second line,
 * so it wraps and truncates with the rest of that line rather than inside a
 * button. The label prop still carries drift for screen readers.
 */

/**
 * Label tones. The dot keeps the vivid colour; the text takes a step of the same
 * hue with enough contrast at 10.5px, because the dot colours are tuned to read
 * as a 6px mark and do not survive being set as small text.
 *
 * Which direction that step goes depends on the ground: darker than the dot on
 * white, lighter than it on the dark navy surface.
 */
const FILE_STATUS_TEXT_TONE: Record<FileStatus, string> = {
  draft: 'text-slate-600 dark:text-slate-400',
  in_review: 'text-amber-700 dark:text-amber-300',
  approved: 'text-emerald-600 dark:text-emerald-400',
  published: 'text-blue-600 dark:text-blue-400',
};

const PUBLISH_NOTICE =
  'Publishing exports this file and its full history, including any prompts and '
  + 'agent replies, as a permanent record that cannot later be edited or removed.';

export const FileStatusChip: React.FC<{
  workspaceId: string;
  fileId: number | string;
  status: FileStatus;
  drift?: boolean;
  size?: 'sm' | 'md';
  /** File-list form: tinted label, drift as a separate pill. */
  compact?: boolean;
  onChanged?: (state: FileStatusState) => void;
}> = ({ workspaceId, fileId, status, drift, size = 'sm', compact = false, onChanged }) => {
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
        // The trigger is a status, not a "more" affordance, and in a two-line
        // row the chevron costs width the filename needs.
        hasChevron={!compact}
        button={{
          size,
          variant: 'ghost',
          // The label is the accessible name either way. In compact form the
          // visible text is tinted and drift is a separate element, so the label
          // still has to carry drift for a screen reader.
          label: showDrift ? `${FILE_STATUS_LABELS[shown]} · edited since` : FILE_STATUS_LABELS[shown],
          icon: <StatusDot variant={FILE_STATUS_DOT[shown]} label={FILE_STATUS_LABELS[shown]} />,
          ...(compact
            ? {
                // Astryx's `sm` button is 28px tall with 12px of side padding —
                // right for a control standing alone, but on a metadata line it
                // both towers over the 10.5px text and pushes the owner name
                // away from it. className is the sanctioned override surface
                // (see `astryx docs styling`); min-h-0 is needed because the
                // size style sets a min-height that height alone cannot beat.
                className: 'min-h-0 h-4 gap-1 px-0 leading-none',
                children: (
                  <span className={`text-[10.5px] font-bold leading-none ${FILE_STATUS_TEXT_TONE[shown]}`}>
                    {FILE_STATUS_LABELS[shown]}
                  </span>
                ),
              }
            : {}),
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
