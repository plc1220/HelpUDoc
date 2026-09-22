import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import type { Workspace } from '../types';
import WorkspaceReviewChangesDialog from './WorkspaceReviewChangesDialog';
import { roleCanComment, roleCanModerate, roleCanPropose } from '../utils/workspaceRoles';
import { getWorkspaceReviewChanges, type WorkspaceReviewChanges } from '../services/workspaceApi';
import {
  applyWorkspaceCollaborationProposal,
  convertWorkspaceCollaborationObjectToProposal,
  createWorkspaceCollaborationObject,
  getWorkspaceCollaborationObject,
  listWorkspaceCollaborationObjects,
  replyToWorkspaceCollaborationObject,
  updateWorkspaceCollaborationObject,
  type WorkspaceCollaborationMessage,
  type WorkspaceCollaborationObject,
  type WorkspaceCollaborationObjectType,
} from '../services/workspaceCollaborationApi';

type Props = {
  open: boolean;
  workspace: Workspace | null;
  filePath?: string | null;
  onClose: () => void;
  onWorkspaceListChanged?: () => Promise<unknown> | void;
};

const typeLabel: Record<WorkspaceCollaborationObjectType, string> = {
  annotation: 'Annotation',
  sticky_note: 'Note',
  task: 'Task',
  // "Submission" here, "proposal" in the tooltip and "Incoming new changes" in
  // the sidebar all named the same thing. One word now, everywhere.
  change_proposal: 'Changes for review',
};

/** A proposal a publisher can still act on. Matches the count SQL and `applyProposal`. */
const isOpenProposal = (object: WorkspaceCollaborationObject): boolean => (
  object.type === 'change_proposal'
  && (object.status === 'proposed' || object.status === 'discussing')
);

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/**
 * How long a reviewer has been sitting on this. An absolute timestamp makes the
 * reader do the subtraction, and the only thing that matters in a queue is
 * which item has waited longest.
 */
const formatAge = (value: string): string => {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const WorkspaceCollaborationDialog = ({
  open,
  workspace,
  filePath,
  onClose,
  onWorkspaceListChanged,
}: Props) => {
  const theme = useTheme();
  const workspaceId = workspace?.id;
  const canComment = roleCanComment(workspace?.role);
  const canPropose = roleCanPropose(workspace?.role);
  const canModerate = roleCanModerate(workspace?.role);
  const [objects, setObjects] = useState<WorkspaceCollaborationObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [type, setType] = useState<WorkspaceCollaborationObjectType>('annotation');
  const [isPrivate, setIsPrivate] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WorkspaceCollaborationMessage[]>([]);
  const [reply, setReply] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [reviewCopy, setReviewCopy] = useState<{ id: string; name: string } | null>(null);
  const [summary, setSummary] = useState<WorkspaceReviewChanges | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const selected = useMemo(
    () => objects.find((object) => object.id === selectedId) || null,
    [objects, selectedId],
  );

  // Open proposals are the only items anyone is waiting on. Mixed into the
  // notes and annotations they were invisible, and the empty state read "No
  // notes or annotations yet" even when someone's work was queued.
  const openProposals = useMemo(() => objects.filter(isOpenProposal), [objects]);
  const otherObjects = useMemo(() => objects.filter((object) => !isOpenProposal(object)), [objects]);

  const loadObjects = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError('');
    try {
      const nextObjects = await listWorkspaceCollaborationObjects(workspaceId);
      setObjects(nextObjects);
      setSelectedId((current) => {
        if (current && nextObjects.some((object) => object.id === current)) return current;
        // Open the queue on the work someone is waiting for, not on whichever
        // note happened to be touched last.
        const firstProposal = nextObjects.find(isOpenProposal);
        return firstProposal?.id || nextObjects[0]?.id || null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load collaboration');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const loadMessages = useCallback(async () => {
    if (!workspaceId || !selectedId) {
      setMessages([]);
      return;
    }
    try {
      const detail = await getWorkspaceCollaborationObject(workspaceId, selectedId);
      setMessages(detail.messages);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load replies');
    }
  }, [selectedId, workspaceId]);

  useEffect(() => {
    if (!open) return;
    setIsPrivate(!canComment);
    setType(filePath ? 'annotation' : 'sticky_note');
    void loadObjects();
  }, [canComment, filePath, loadObjects, open]);

  useEffect(() => {
    if (!open) setReviewCopy(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void loadMessages();
  }, [loadMessages, open]);

  // Loaded for the selected proposal only, never for the list. The response
  // reads both workspaces in full and inlines file text up to 100k characters
  // per file, so one call per row would make opening the dialog expensive.
  // A publisher may read another person's copy while an open proposal links
  // them — the server enforces that; see `getPrivateCopyReviewChanges`.
  const renderObjectRow = (object: WorkspaceCollaborationObject) => {
    const isProposal = isOpenProposal(object);
    // A `change_proposal` created directly through `createObject` never gets a
    // linked copy, so it can never be applied. Say so on the row instead of
    // offering an Approve button that always fails.
    const isBroken = isProposal && !object.linkedPrivateWorkspaceId;
    const facts = [
      object.authorName,
      formatAge(object.createdAt),
      object.messageCount ? `${object.messageCount} replies` : null,
    ].filter(Boolean).join(' · ');
    return (
      <Button
        key={object.id}
        variant={selectedId === object.id ? 'contained' : 'outlined'}
        color={selectedId === object.id ? 'primary' : 'inherit'}
        onClick={() => setSelectedId(object.id)}
        sx={{ justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none' }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={600} noWrap>
            {object.title || object.body}
          </Typography>
          <Typography variant="caption" sx={{ opacity: 0.8, display: 'block' }}>
            {isProposal ? facts : `${typeLabel[object.type]} · ${facts}`}
          </Typography>
          {isBroken ? (
            <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>
              No linked copy — cannot be applied
            </Typography>
          ) : null}
        </Box>
      </Button>
    );
  };

  const selectedPrivateCopyId = selected && isOpenProposal(selected)
    ? selected.linkedPrivateWorkspaceId
    : null;

  useEffect(() => {
    if (!open || !selectedPrivateCopyId || !canModerate) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setSummaryLoading(true);
    setSummary(null);
    void getWorkspaceReviewChanges(selectedPrivateCopyId)
      .then((changes) => { if (!cancelled) setSummary(changes); })
      // A summary that will not load must not hide the proposal or block the
      // Approve button. The row stays, just without the file counts.
      .catch(() => { if (!cancelled) setSummary(null); })
      .finally(() => { if (!cancelled) setSummaryLoading(false); });
    return () => { cancelled = true; };
  }, [canModerate, open, selectedPrivateCopyId]);

  const handleCreate = async () => {
    if (!workspaceId || !body.trim()) return;
    setSaving(true);
    setError('');
    try {
      let created = await createWorkspaceCollaborationObject(workspaceId, {
        type,
        visibility: type !== 'change_proposal' && isPrivate ? 'private' : 'workspace_audience',
        title: title.trim() || undefined,
        body: body.trim(),
        filePath: type === 'annotation' && filePath ? filePath : undefined,
      });
      if (type === 'change_proposal') {
        created = await convertWorkspaceCollaborationObjectToProposal(workspaceId, created.id);
        await onWorkspaceListChanged?.();
      }
      setTitle('');
      setBody('');
      await loadObjects();
      setSelectedId(created.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create item');
    } finally {
      setSaving(false);
    }
  };

  const handleReply = async () => {
    if (!workspaceId || !selected || !reply.trim()) return;
    setActionBusy(true);
    setError('');
    try {
      await replyToWorkspaceCollaborationObject(workspaceId, selected.id, reply.trim());
      setReply('');
      await Promise.all([loadObjects(), loadMessages()]);
    } catch (replyError) {
      setError(replyError instanceof Error ? replyError.message : 'Failed to post reply');
    } finally {
      setActionBusy(false);
    }
  };

  const handleResolve = async () => {
    if (!workspaceId || !selected) return;
    setActionBusy(true);
    setError('');
    try {
      await updateWorkspaceCollaborationObject(workspaceId, selected.id, {
        status: selected.status === 'resolved' ? 'open' : 'resolved',
      });
      await loadObjects();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update item');
    } finally {
      setActionBusy(false);
    }
  };

  const handleConvertToProposal = async () => {
    if (!workspaceId || !selected) return;
    setActionBusy(true);
    setError('');
    try {
      await convertWorkspaceCollaborationObjectToProposal(workspaceId, selected.id);
      await Promise.all([loadObjects(), onWorkspaceListChanged?.()]);
    } catch (proposalError) {
      setError(proposalError instanceof Error ? proposalError.message : 'Failed to create proposal');
    } finally {
      setActionBusy(false);
    }
  };

  const handleApplyProposal = async () => {
    if (!workspaceId || !selected) return;
    setActionBusy(true);
    setError('');
    try {
      await applyWorkspaceCollaborationProposal(workspaceId, selected.id);
      await Promise.all([loadObjects(), onWorkspaceListChanged?.()]);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Failed to apply proposal');
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        <Box>
          <Typography variant="h6">Collaboration</Typography>
          <Typography variant="caption" color="text.secondary">
            Comments, review requests, and activity for the Shared workspace
          </Typography>
        </Box>
        <IconButton aria-label="close collaboration" onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(18rem, .9fr) 1.4fr' }, gap: 3 }}>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Add collaboration item</Typography>
            <Stack spacing={1.5}>
              <Select
                size="small"
                value={type}
                onChange={(event) => {
                  const nextType = event.target.value as WorkspaceCollaborationObjectType;
                  setType(nextType);
                  if (nextType === 'change_proposal') {
                    setIsPrivate(false);
                  }
                }}
              >
                <MenuItem value="annotation" disabled={!filePath}>Annotation {filePath ? '' : '(open a file first)'}</MenuItem>
                <MenuItem value="sticky_note">Note</MenuItem>
                <MenuItem value="task">Task</MenuItem>
                {canPropose ? <MenuItem value="change_proposal">Submit for review</MenuItem> : null}
              </Select>
              {type === 'annotation' && filePath ? (
                <Alert severity="info" icon={false}>
                  Anchored to <strong>{filePath}</strong>
                </Alert>
              ) : null}
              <TextField
                size="small"
                label="Title (optional)"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <TextField
                multiline
                minRows={3}
                label={isPrivate ? 'Private note' : 'What should the team know?'}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={type !== 'change_proposal' && isPrivate}
                    disabled={!canComment || type === 'change_proposal'}
                    onChange={(event) => setIsPrivate(event.target.checked)}
                  />
                )}
                label={isPrivate ? 'Only me' : 'Share with workspace audience'}
              />
              <Button
                variant="contained"
                disabled={!body.trim() || saving}
                onClick={() => void handleCreate()}
              >
                {saving ? <CircularProgress size={20} color="inherit" /> : 'Add item'}
              </Button>
              {!canComment ? (
                <Typography variant="caption" color="text.secondary">
                  Your Viewer role can create private notes. Ask an Owner for Commenter access to share them.
                </Typography>
              ) : null}
            </Stack>
            <Divider sx={{ my: 2 }} />
            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Stack spacing={1}>
                {openProposals.length ? (
                  <>
                    <Typography variant="subtitle2" color="warning.main">
                      Open for review ({openProposals.length})
                    </Typography>
                    {openProposals.map(renderObjectRow)}
                  </>
                ) : null}
                {otherObjects.length ? (
                  <Typography variant="subtitle2" sx={{ pt: openProposals.length ? 1 : 0 }}>
                    Notes and annotations ({otherObjects.length})
                  </Typography>
                ) : null}
                {otherObjects.map(renderObjectRow)}
                {!objects.length ? (
                  <Typography variant="body2" color="text.secondary">
                    Nothing here yet. Submitted changes and notes will appear in this list.
                  </Typography>
                ) : null}
              </Stack>
            )}
          </Box>

          <Box sx={{ minWidth: 0 }}>
            {selected ? (
              <>
                <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
                  <Chip size="small" label={typeLabel[selected.type]} />
                  <Chip size="small" label={selected.status.replace('_', ' ')} color={selected.status === 'resolved' ? 'success' : 'default'} />
                  <Chip size="small" label={selected.visibility === 'private' ? 'Only me' : 'Workspace audience'} variant="outlined" />
                </Stack>
                <Typography variant="h6">{selected.title || typeLabel[selected.type]}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {selected.authorName} · {formatDate(selected.createdAt)}
                  {selected.filePath ? ` · ${selected.filePath}` : ''}
                </Typography>
                <Typography variant="body1" sx={{ mt: 2, whiteSpace: 'pre-wrap' }}>{selected.body}</Typography>
                {selected.linkedPrivateWorkspaceId ? (
                  <Alert severity="success" sx={{ mt: 2 }}>
                    A private draft is linked to these changes and is ready in My Workspaces.
                  </Alert>
                ) : null}
                {isOpenProposal(selected) && !selected.linkedPrivateWorkspaceId ? (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    These changes have no linked private copy, so there is nothing to apply.
                    Ask the author to submit again from their draft.
                  </Alert>
                ) : null}
                {summaryLoading ? (
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
                    <CircularProgress size={14} />
                    <Typography variant="caption" color="text.secondary">Loading what changed…</Typography>
                  </Stack>
                ) : null}
                {summary ? (
                  <Box sx={{ mt: 2 }}>
                    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ flexWrap: 'wrap' }}>
                      <Typography variant="subtitle2">
                        {summary.files.length} changed file{summary.files.length === 1 ? '' : 's'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'success.main' }}>
                        +{summary.files.reduce((total, file) => total + file.addedLines, 0)}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'error.main' }}>
                        −{summary.files.reduce((total, file) => total + file.removedLines, 0)}
                      </Typography>
                    </Stack>
                    <Stack sx={{ mt: 0.5 }}>
                      {summary.files.slice(0, 8).map((file) => (
                        <Typography key={file.path} variant="caption" color="text.secondary" noWrap>
                          {file.status === 'added' ? '+ ' : file.status === 'deleted' ? '− ' : '~ '}
                          {file.path}
                        </Typography>
                      ))}
                      {summary.files.length > 8 ? (
                        <Typography variant="caption" color="text.secondary">
                          …and {summary.files.length - 8} more
                        </Typography>
                      ) : null}
                    </Stack>
                    {summary.isStale ? (
                      // Since the auto-rebase landed this merges silently, so
                      // the reviewer would otherwise never learn their approval
                      // pulled in work from elsewhere.
                      <Alert severity="info" sx={{ mt: 1.5 }}>
                        The Shared workspace has moved on since these changes were submitted.
                        Approving merges them with the latest version first.
                      </Alert>
                    ) : null}
                  </Box>
                ) : null}
                <Stack direction="row" spacing={1} sx={{ my: 2, flexWrap: 'wrap' }}>
                  <Button size="small" variant="outlined" disabled={actionBusy} onClick={() => void handleResolve()}>
                    {selected.status === 'resolved' ? 'Reopen' : 'Resolve'}
                  </Button>
                  {canPropose
                    && selected.visibility === 'workspace_audience'
                    && selected.type !== 'change_proposal' ? (
                      <Button size="small" variant="outlined" disabled={actionBusy} onClick={() => void handleConvertToProposal()}>
                        Submit for review
                      </Button>
                    ) : null}
                  {canModerate
                    && selected.type === 'change_proposal'
                    && Boolean(selected.linkedPrivateWorkspaceId)
                    && (selected.status === 'proposed' || selected.status === 'discussing') ? (
                      <>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={actionBusy}
                          onClick={() => setReviewCopy({
                            id: selected.linkedPrivateWorkspaceId!,
                            name: selected.title || 'Submitted changes',
                          })}
                        >
                          Review changes
                        </Button>
                        <Button size="small" variant="contained" disabled={actionBusy} onClick={() => void handleApplyProposal()}>
                          Approve and apply
                        </Button>
                      </>
                    ) : null}
                </Stack>
                <Divider />
                <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>Discussion</Typography>
                <Stack spacing={1.5}>
                  {messages.map((message) => (
                    <Box key={message.id} sx={{ borderLeft: 2, borderColor: 'divider', pl: 1.5 }}>
                      <Typography variant="caption" color="text.secondary">
                        {message.authorName} · {formatDate(message.createdAt)}
                      </Typography>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{message.body}</Typography>
                    </Box>
                  ))}
                  {!messages.length ? (
                    <Typography variant="body2" color="text.secondary">No replies yet.</Typography>
                  ) : null}
                </Stack>
                {(selected.visibility === 'private' || canComment) ? (
                  <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                    <TextField
                      fullWidth
                      size="small"
                      label="Reply"
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                    />
                    <Button
                      variant="contained"
                      disabled={!reply.trim() || actionBusy}
                      onClick={() => void handleReply()}
                    >
                      Send
                    </Button>
                  </Stack>
                ) : null}
              </>
            ) : (
              <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 300 }}>
                <Typography color="text.secondary">Select an item to view its discussion.</Typography>
              </Box>
            )}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>Done</Button>
      </DialogActions>
      <WorkspaceReviewChangesDialog
        open={reviewCopy !== null}
        workspace={reviewCopy}
        colorMode={theme.palette.mode}
        onClose={() => setReviewCopy(null)}
        onSubmitted={loadObjects}
      />
    </Dialog>
  );
};

export default WorkspaceCollaborationDialog;
