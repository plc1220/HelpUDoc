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
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import type { Workspace } from '../types';
import {
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

const roleCanComment = (role: Workspace['role']) =>
  role === 'owner' || role === 'editor' || role === 'contributor' || role === 'commenter';

const roleCanPropose = (role: Workspace['role']) =>
  role === 'owner' || role === 'editor' || role === 'contributor';

const typeLabel: Record<WorkspaceCollaborationObjectType, string> = {
  annotation: 'Annotation',
  sticky_note: 'Note',
  task: 'Task',
  change_proposal: 'Change proposal',
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const WorkspaceCollaborationDialog = ({
  open,
  workspace,
  filePath,
  onClose,
  onWorkspaceListChanged,
}: Props) => {
  const workspaceId = workspace?.id;
  const canComment = roleCanComment(workspace?.role);
  const canPropose = roleCanPropose(workspace?.role);
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

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        <Box>
          <Typography variant="h6">Notes, annotations & proposals</Typography>
          <Typography variant="caption" color="text.secondary">
            {workspace?.currentPublishedVersionNumber == null
              ? 'Shared files stay read-only until an immutable version is published'
              : `Published version ${workspace.currentPublishedVersionNumber} stays read-only`}
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
                {canPropose ? <MenuItem value="change_proposal">Change proposal</MenuItem> : null}
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
                    A governed private working copy is linked to this proposal and is ready in My Workspaces.
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
                        Turn into proposal
                      </Button>
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
    </Dialog>
  );
};

export default WorkspaceCollaborationDialog;
