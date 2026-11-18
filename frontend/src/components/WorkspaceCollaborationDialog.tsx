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
import TeamThreadProposalReview from './chat/TeamThreadProposalReview';
import { getAuthUser } from '../auth/authStore';
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
  /**
   * Release B (F8): open focused on a specific existing object (any type —
   * annotation on any file, or a proposal). Opens the ORIGINAL object and its
   * discussion; never duplicates replies. Cleared by the host after it is
   * consumed so re-opening the dialog normally is unaffected.
   */
  initialObjectId?: string | null;
  /**
   * Release B readiness for this workspace. Gates the thread-linked frozen
   * submission/review + author submit panels. When false, a thread-linked
   * proposal does NOT fall back to the unsafe legacy whole-copy Apply.
   */
  releaseBReady?: boolean;
  onClose: () => void;
  onWorkspaceListChanged?: () => Promise<unknown> | void;
};

/**
 * Read the Release B thread link off a collaboration object without editing the
 * A-owned service type. The backend contract (F7/F8) adds `sourceThreadId` to
 * the object; until it lands in the shared type we read it defensively so a
 * thread-linked proposal renders the frozen-submission review path.
 */
const readSourceThreadId = (object: WorkspaceCollaborationObject | null): string | undefined => {
  const value = (object as unknown as { sourceThreadId?: string | null } | null)?.sourceThreadId;
  return typeof value === 'string' && value ? value : undefined;
};

/** True when the current user authored the proposal object (author-only submit
 *  UI). The private navigation endpoint is the real authorization gate; this is
 *  only a UI hint to decide whether to render the submit panel. */
const isProposalAuthor = (object: WorkspaceCollaborationObject | null): boolean => {
  const me = getAuthUser()?.id;
  return Boolean(me && object?.authorId && object.authorId === me);
};

const roleCanComment = (role: Workspace['role']) =>
  role === 'owner' || role === 'editor' || role === 'contributor' || role === 'commenter';

const roleCanPropose = (role: Workspace['role']) =>
  role === 'owner' || role === 'editor' || role === 'contributor';

const roleCanModerate = (role: Workspace['role']) => role === 'owner' || role === 'editor';

const typeLabel: Record<WorkspaceCollaborationObjectType, string> = {
  annotation: 'Annotation',
  sticky_note: 'Note',
  task: 'Task',
  change_proposal: 'Submission',
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const WorkspaceCollaborationDialog = ({
  open,
  workspace,
  filePath,
  initialObjectId,
  releaseBReady,
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
  // Bumped after a successful author submit so the sibling review panel
  // refreshes and selects the new frozen submission in the same open dialog.
  const [submitRefreshToken, setSubmitRefreshToken] = useState(0);

  const selected = useMemo(
    () => objects.find((object) => object.id === selectedId) || null,
    [objects, selectedId],
  );

  const loadObjects = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError('');
    try {
      const nextObjects = await listWorkspaceCollaborationObjects(workspaceId);
      setObjects(nextObjects);
      setSelectedId((current) => (
        current && nextObjects.some((object) => object.id === current)
          ? current
          : nextObjects[0]?.id || null
      ));
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

  // Release B (F8): when opened focused on a specific object, select it once it
  // is present in the loaded list (any type — annotation on any file, or a
  // proposal). This opens the ORIGINAL object's discussion; replies are never
  // duplicated.
  useEffect(() => {
    if (!open || !initialObjectId) return;
    if (objects.some((object) => object.id === initialObjectId)) {
      setSelectedId(initialObjectId);
    }
  }, [open, initialObjectId, objects]);

  useEffect(() => {
    if (!open) setReviewCopy(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void loadMessages();
  }, [loadMessages, open]);

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
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Activity ({objects.length})
            </Typography>
            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Stack spacing={1}>
                {objects.map((object) => (
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
                      <Typography variant="caption" sx={{ opacity: 0.8 }}>
                        {typeLabel[object.type]} · {object.authorName} · {object.messageCount || 0} replies
                      </Typography>
                    </Box>
                  </Button>
                ))}
                {!objects.length ? (
                  <Typography variant="body2" color="text.secondary">No notes or annotations yet.</Typography>
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
                    A private draft is linked to this submission and is ready in My Workspaces.
                  </Alert>
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
                    && !readSourceThreadId(selected)
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
                {/* Release B (F7): a THREAD-LINKED proposal uses the frozen,
                    explicitly-selected submission + review + apply-once flow
                    instead of the legacy whole-private-copy apply above. The
                    reviewer reads authorized snapshot bytes without private
                    access; apply pins the exact submission + expected revision. */}
                {selected.type === 'change_proposal' && readSourceThreadId(selected) ? (
                  releaseBReady ? (
                  <Box sx={{ my: 2 }}>
                    {/* AUTHOR: explicitly select which private changes to submit.
                        Uses the current shared revision; expectedPrivateRevision
                        is sourced from the candidate snapshot (never a newer nav
                        revision). Only the proposal author sees this. */}
                    {isProposalAuthor(selected) ? (
                      <TeamThreadProposalReview
                        workspaceId={workspaceId!}
                        objectId={selected.id}
                        sourceThreadId={readSourceThreadId(selected)}
                        targetWorkspaceLabel={workspace?.name}
                        expectedSharedRevision={workspace?.contentRevision ?? 0}
                        mode="submit"
                        onRefreshRevision={() => void onWorkspaceListChanged?.()}
                        onSubmitted={() => { setSubmitRefreshToken((n) => n + 1); void loadObjects(); }}
                      />
                    ) : null}
                    <TeamThreadProposalReview
                      workspaceId={workspaceId!}
                      objectId={selected.id}
                      sourceThreadId={readSourceThreadId(selected)}
                      targetWorkspaceLabel={workspace?.name}
                      mode="review"
                      canReview={canComment}
                      canApply={canModerate}
                      refreshToken={submitRefreshToken}
                      onApplied={() => void Promise.all([loadObjects(), onWorkspaceListChanged?.()])}
                    />
                  </Box>
                  ) : (
                    <Alert severity="info" sx={{ my: 2 }} data-testid="thread-proposal-b-off">
                      This is a thread-linked submission. Its review and apply require Release B, which is not
                      enabled for this workspace yet. It is intentionally not applied via the legacy whole-copy path.
                    </Alert>
                  )
                ) : null}
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
