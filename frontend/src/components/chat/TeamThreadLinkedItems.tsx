/**
 * F8 — Link document discussions without duplicating them (Release B).
 *
 * OWNERSHIP: NEW Release B component, prop-driven so it can mount standalone
 * (fixtures/tests) or as the thread's "Linked items" panel once ownership
 * transfers.
 *
 * It lists the workspace-audience collaboration objects (annotations /
 * proposals) linked to a thread and OPENS THE ORIGINAL object + its discussion
 * — it never copies replies into independent team messages. Each item shows the
 * original excerpt and the immutable anchor version; when the latest file
 * version differs it shows an honest `anchor_changed` state and offers explicit
 * reattachment.
 *
 * Point 3 fix: reattachment re-pins to a real immutable `file_versions` UUID the
 * user explicitly selects (obtained from the authorized version list) — never a
 * fabricated id derived from a version NUMBER — and preserves the original
 * excerpt/offsets. Including a linked annotation in a Lumo request is an
 * explicit, version-pinned reference; linking alone never invokes the agent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import {
  listThreadLinkedItems,
  setObjectThreadLink,
  reattachObjectAnchor,
  buildAnnotationLumoReference,
  type ThreadLinkedItem,
} from '../../services/teamThreadWorkApi';
import { getFileVersions, getFileVersionText } from '../../services/fileApi';
import { TeamThreadApiError } from '../../services/workspaceCollaborationApi';
import './teamThreadWork.css';

export interface TeamThreadLinkedItemsProps {
  workspaceId: string;
  threadId: string;
  /** Open the ORIGINAL object's discussion (host routes to the annotation/proposal). */
  onOpenObject: (objectId: string) => void;
  /** Add an explicit, version-pinned annotation reference to the composer. */
  onIncludeInLumo?: (reference: ReturnType<typeof buildAnnotationLumoReference>) => void;
  /** Author/moderator may unlink and reattach. */
  canManage?: boolean;
  onAccessLoss?: () => void;
}

/** A version option for the reattach picker — carries the REAL immutable id. */
interface VersionOption {
  id: string;
  version: number;
  fileId: number | null;
}

const typeVariant = (type: string): 'blue' | 'purple' | 'neutral' => {
  if (type === 'change_proposal') return 'purple';
  if (type === 'annotation') return 'blue';
  return 'neutral';
};

export default function TeamThreadLinkedItems({
  workspaceId,
  threadId,
  onOpenObject,
  onIncludeInLumo,
  canManage,
  onAccessLoss,
}: TeamThreadLinkedItemsProps) {
  const [items, setItems] = useState<ThreadLinkedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  // Reattach picker state, keyed by objectId → available versions.
  const [reattachFor, setReattachFor] = useState<string | null>(null);
  const [versionOptions, setVersionOptions] = useState<VersionOption[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  // Two-step reattach (round29/30): after choosing a version, load its RAW
  // source so the user makes a NEW explicit text selection. We never re-pin with
  // only a version (backend rejects version-only, keeps stale), and never claim
  // rendered-markdown offsets equal source bytes.
  const [chosenVersion, setChosenVersion] = useState<VersionOption | null>(null);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const mountedRef = useRef(true);
  const genRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleError = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof TeamThreadApiError && e.isAccessLoss) onAccessLoss?.();
      setError(e instanceof Error ? e.message : fallback);
    },
    [onAccessLoss],
  );

  const reload = useCallback(async () => {
    const gen = (genRef.current += 1);
    setLoading(true);
    setError('');
    try {
      const next = await listThreadLinkedItems(workspaceId, threadId);
      if (!mountedRef.current || gen !== genRef.current) return;
      setItems(next);
    } catch (e) {
      if (mountedRef.current && gen === genRef.current) handleError(e, 'Failed to load linked items');
    } finally {
      if (mountedRef.current && gen === genRef.current) setLoading(false);
    }
  }, [workspaceId, threadId, handleError]);

  useEffect(() => {
    // Reset transient picker state when thread/workspace changes.
    setReattachFor(null);
    setVersionOptions([]);
    setChosenVersion(null);
    setSourceText(null);
    setSelectionRange(null);
    setNotice('');
    void reload();
  }, [reload]);

  const unlink = async (item: ThreadLinkedItem) => {
    setBusyId(item.objectId);
    setError('');
    setNotice('');
    try {
      await setObjectThreadLink(workspaceId, item.objectId, null);
      if (!mountedRef.current) return;
      setNotice('Item unlinked. The original object and its discussion are unchanged.');
      await reload();
    } catch (e) {
      if (mountedRef.current) handleError(e, 'Failed to unlink item');
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  };

  // Step 1: open the picker and list the file's REAL immutable versions.
  const openReattach = async (item: ThreadLinkedItem) => {
    const gen = genRef.current;
    setReattachFor(item.objectId);
    setVersionOptions([]);
    setChosenVersion(null);
    setSourceText(null);
    setSelectionRange(null);
    setError('');
    setNotice('');
    // Prefer the canonical numeric fileId when the backend provides it; fall
    // back to the path only when no id is available.
    const versionRef = item.fileId ?? item.filePath;
    if (versionRef === null || versionRef === undefined || versionRef === '') {
      setError('This item has no resolvable file identity, so it cannot be reattached.');
      return;
    }
    setVersionsLoading(true);
    try {
      const versions = await getFileVersions(workspaceId, versionRef);
      if (!mountedRef.current || gen !== genRef.current) return;
      const options: VersionOption[] = (Array.isArray(versions) ? versions : [])
        .map((v: Record<string, unknown>) => ({
          id: String(v.id ?? v.versionId ?? ''),
          version: Number(v.version ?? v.versionNumber ?? 0),
          fileId: v.fileId !== undefined ? Number(v.fileId) : (typeof versionRef === 'number' ? versionRef : null),
        }))
        .filter((v) => v.id);
      setVersionOptions(options);
      if (!options.length) {
        setError('No selectable versions were returned for this file. Reattachment needs an authorized version id from the backend.');
      }
    } catch (e) {
      if (mountedRef.current) handleError(e, 'Failed to load file versions for reattachment');
    } finally {
      if (mountedRef.current) setVersionsLoading(false);
    }
  };

  // Step 2: after choosing a version, load its RAW source so the user makes a
  // NEW explicit text selection against the actual bytes (honest UTF-16 offsets;
  // we never claim rendered-markdown offsets equal source bytes).
  const chooseVersion = async (item: ThreadLinkedItem, option: VersionOption) => {
    setChosenVersion(option);
    setSourceText(null);
    setSelectionRange(null);
    setError('');
    const fileRef = option.fileId ?? item.fileId ?? item.filePath;
    if (fileRef === null || fileRef === undefined || fileRef === '') {
      setError('Cannot load this version’s source without a file identity.');
      return;
    }
    setSourceLoading(true);
    try {
      const { text } = await getFileVersionText(workspaceId, fileRef, option.version);
      if (!mountedRef.current) return;
      if (text === null) {
        setError('This version is binary, so a raw-text excerpt selection is not available. Choose a text version.');
        return;
      }
      setSourceText(text);
    } catch (e) {
      if (mountedRef.current) handleError(e, 'Failed to load version source for selection');
    } finally {
      if (mountedRef.current) setSourceLoading(false);
    }
  };

  // Step 3: submit the reattach with the EXPLICIT new selection (excerpt +
  // exact offsets on the chosen version's source). Version-only is never sent —
  // the backend keeps the stale anchor for a version-only request.
  const confirmReattach = async (item: ThreadLinkedItem) => {
    if (!chosenVersion || sourceText === null || !selectionRange) {
      setError('Select the new excerpt in the source below before reattaching.');
      return;
    }
    const { start, end } = selectionRange;
    if (end <= start) {
      setError('Select a non-empty excerpt to reattach to.');
      return;
    }
    const excerpt = sourceText.slice(start, end);
    setBusyId(item.objectId);
    setError('');
    setNotice('');
    try {
      await reattachObjectAnchor(workspaceId, item.objectId, {
        anchorVersionId: chosenVersion.id,
        anchorStart: start,
        anchorEnd: end,
        anchorText: excerpt,
      });
      if (!mountedRef.current) return;
      setNotice('Anchor reattached to your new selection on the chosen version.');
      setReattachFor(null);
      setVersionOptions([]);
      setChosenVersion(null);
      setSourceText(null);
      setSelectionRange(null);
      await reload();
    } catch (e) {
      if (mountedRef.current) handleError(e, 'Failed to reattach anchor');
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  };

  if (loading) {
    return <div className="team-thread-b" aria-busy="true"><Spinner size="sm" /> <Text type="supporting">Loading linked items…</Text></div>;
  }

  return (
    <div className="team-thread-b" aria-label="Linked items">
      {error && <Banner status="error" title="Linked items problem" description={error} />}
      {notice && <Banner status="info" title="Linked items" description={notice} />}

      {!items.length && (
        <div className="team-thread-b__empty">
          <Text type="supporting">
            No linked items. Link an existing workspace annotation or proposal to keep its discussion
            in one place — replies stay on the original object.
          </Text>
        </div>
      )}

      <div className="team-thread-b__list">
        {items.map((item) => (
          <Card key={item.objectId} variant="default" padding={3}>
            <div className="team-thread-b__row">
              <div className="team-thread-b__row-head">
                <Badge variant={typeVariant(item.type)} label={item.type.replace('_', ' ')} />
                <Text type="body">{item.title || item.filePath || 'Linked item'}</Text>
                <div className="team-thread-b__spacer" />
                {item.anchorChanged && <Badge variant="orange" label="Anchor changed" />}
              </div>

              {item.filePath && <Text type="supporting" display="block" className="team-thread-b__path">{item.filePath}</Text>}

              {item.anchorText && (
                <Card variant="default" padding={2}>
                  <Text type="supporting" display="block">“{item.anchorText}”</Text>
                  <Text type="supporting" display="block">
                    Anchored to version {item.anchorVersionNumber ?? '—'}
                    {item.anchorChanged && item.currentVersionNumber
                      ? ` · latest is version ${item.currentVersionNumber}`
                      : ''}
                  </Text>
                </Card>
              )}

              {item.anchorChanged && (
                <Text type="supporting" display="block">
                  The document changed since this was anchored. The original excerpt above is shown as
                  captured. Reattach to re-pin it to a specific current version.
                </Text>
              )}

              <div className="team-thread-b__badges">
                <Button label="Open discussion" variant="secondary" size="sm" onClick={() => onOpenObject(item.objectId)} />
                {onIncludeInLumo && item.type === 'annotation' && (
                  <Button
                    label="Include in Lumo request"
                    variant="ghost"
                    size="sm"
                    onClick={() => onIncludeInLumo(buildAnnotationLumoReference(item))}
                  />
                )}
                {canManage && item.anchorChanged && reattachFor !== item.objectId && (
                  <Button
                    label="Reattach anchor"
                    variant="ghost"
                    size="sm"
                    isDisabled={busyId === item.objectId}
                    onClick={() => void openReattach(item)}
                  />
                )}
                {canManage && (
                  <Button
                    label={busyId === item.objectId ? 'Working…' : 'Unlink'}
                    variant="ghost"
                    size="sm"
                    isDisabled={busyId === item.objectId}
                    onClick={() => void unlink(item)}
                  />
                )}
              </div>

              {reattachFor === item.objectId && (
                <Card variant="default" padding={2}>
                  <Text type="label" display="block">Reattach the anchor</Text>
                  <Text type="supporting" display="block">
                    1) Choose the version to re-pin to. 2) Select the NEW excerpt in that version’s
                    raw source below. The original excerpt stays visible above until you confirm.
                  </Text>
                  {versionsLoading && <div aria-busy="true"><Spinner size="sm" /> <Text type="supporting">Loading versions…</Text></div>}
                  <div className="team-thread-b__badges">
                    {versionOptions.map((v) => (
                      <Button
                        key={v.id}
                        label={`v${v.version}`}
                        variant={chosenVersion?.id === v.id ? 'primary' : 'secondary'}
                        size="sm"
                        isDisabled={busyId === item.objectId}
                        onClick={() => void chooseVersion(item, v)}
                      />
                    ))}
                    <Button
                      label="Cancel"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReattachFor(null);
                        setVersionOptions([]);
                        setChosenVersion(null);
                        setSourceText(null);
                        setSelectionRange(null);
                      }}
                    />
                  </div>

                  {chosenVersion && sourceLoading && (
                    <div aria-busy="true"><Spinner size="sm" /> <Text type="supporting">Loading source…</Text></div>
                  )}

                  {chosenVersion && sourceText !== null && (
                    <div>
                      <Text type="supporting" display="block">
                        Raw source of v{chosenVersion.version} — select the new excerpt (offsets are
                        exact UTF-16 positions in this source):
                      </Text>
                      <textarea
                        aria-label={`Version ${chosenVersion.version} source`}
                        data-testid="reattach-source"
                        value={sourceText}
                        rows={8}
                        spellCheck={false}
                        className="team-thread-b__path"
                        style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
                        // Controlled + immutable: the value never changes (no
                        // setState in onChange), so this is effectively read-only
                        // for content, but caret/selection keys still work
                        // (a `readOnly` textarea disables caret motion in some
                        // engines, breaking exact-offset selection).
                        onChange={() => {}}
                        onSelect={(e) => {
                          const el = e.currentTarget;
                          setSelectionRange({ start: el.selectionStart, end: el.selectionEnd });
                        }}
                        onKeyUp={(e) => {
                          const el = e.currentTarget;
                          setSelectionRange({ start: el.selectionStart, end: el.selectionEnd });
                        }}
                        onMouseUp={(e) => {
                          const el = e.currentTarget;
                          setSelectionRange({ start: el.selectionStart, end: el.selectionEnd });
                        }}
                      />
                      {selectionRange && selectionRange.end > selectionRange.start ? (
                        <div data-testid="reattach-selection">
                          <Text type="supporting" display="block">
                            New excerpt [{selectionRange.start}–{selectionRange.end}]: “{sourceText.slice(selectionRange.start, selectionRange.end).slice(0, 120)}”
                          </Text>
                        </div>
                      ) : (
                        <Text type="supporting" display="block">Select a non-empty passage above.</Text>
                      )}
                      <Button
                        label={busyId === item.objectId ? 'Reattaching…' : 'Reattach to this selection'}
                        variant="primary"
                        size="sm"
                        isDisabled={busyId === item.objectId || !selectionRange || selectionRange.end <= selectionRange.start}
                        onClick={() => void confirmReattach(item)}
                      />
                    </div>
                  )}
                </Card>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
