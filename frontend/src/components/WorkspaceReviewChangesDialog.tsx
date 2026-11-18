import { Button } from '@astryxdesign/core/Button';
import {
  Alert,
  Box,
  Button as MuiButton,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { FileDiff, FilePlus2, FileX2, GitPullRequestArrow, RotateCcw } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import type { Workspace } from '../types';
import {
  createWorkspaceCollaborationObject,
  convertWorkspaceCollaborationObjectToProposal,
} from '../services/workspaceCollaborationApi';
import {
  getWorkspaceReviewChanges,
  type WorkspaceReviewChangeFile,
  type WorkspaceReviewChanges,
} from '../services/workspaceApi';

const MonacoDiffEditor = lazy(() => import('@monaco-editor/react').then((module) => ({
  default: module.DiffEditor,
})));

const languageForPath = (filePath: string) => {
  const extension = filePath.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    css: 'css', html: 'html', json: 'json', md: 'markdown', py: 'python',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', go: 'go',
    rs: 'rust', php: 'php', rb: 'ruby', sh: 'shell', bash: 'shell',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', sql: 'sql', csv: 'plaintext',
  };
  return extension ? languages[extension] || 'plaintext' : 'plaintext';
};

const statusIcon = (status: WorkspaceReviewChangeFile['status']) => {
  if (status === 'added') return <FilePlus2 size={15} />;
  if (status === 'deleted') return <FileX2 size={15} />;
  return <FileDiff size={15} />;
};

export default function WorkspaceReviewChangesDialog({
  open,
  workspace,
  colorMode,
  onClose,
  onSubmitted,
  onSyncLatest,
  syncing = false,
}: {
  open: boolean;
  workspace: Pick<Workspace, 'id' | 'name'> | null;
  colorMode: 'light' | 'dark';
  onClose: () => void;
  onSubmitted?: () => void | Promise<void>;
  /**
   * Runs the same `Sync latest` flow as the `My draft` row, including the 409 conflict hand-off
   * (spec sections 2.7 and 9). When omitted the banner points at that row instead.
   */
  onSyncLatest?: () => void | Promise<void>;
  syncing?: boolean;
}) {
  const [changes, setChanges] = useState<WorkspaceReviewChanges | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [syncRequested, setSyncRequested] = useState(false);
  const isDarkMode = colorMode === 'dark';
  const isSyncing = syncing || syncRequested;

  const loadChanges = useCallback(async () => {
    if (!workspace?.id) return;
    setLoading(true);
    setError('');
    try {
      const next = await getWorkspaceReviewChanges(workspace.id);
      setChanges(next);
      setSelectedPath((current) => (
        next.files.some((file) => file.path === current) ? current : next.files[0]?.path || ''
      ));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to load Review changes');
    } finally {
      setLoading(false);
    }
  }, [workspace?.id]);

  useEffect(() => {
    if (!open) {
      setChanges(null);
      setSelectedPath('');
      setError('');
      return;
    }
    void loadChanges();
  }, [loadChanges, open]);

  const selectedFile = useMemo(
    () => changes?.files.find((file) => file.path === selectedPath) || null,
    [changes?.files, selectedPath],
  );
  const totals = useMemo(() => (changes?.files || []).reduce(
    (summary, file) => ({
      added: summary.added + file.addedLines,
      removed: summary.removed + file.removedLines,
    }),
    { added: 0, removed: 0 },
  ), [changes?.files]);

  const submitForReview = async () => {
    if (!changes || !workspace || !changes.hasChanges || changes.proposal) return;
    setError('');
    setSubmitting(true);
    const fileSummary = changes.files
      .slice(0, 20)
      .map((file) => `${file.status}: ${file.path}`)
      .join('\n');
    try {
      const created = await createWorkspaceCollaborationObject(changes.sharedWorkspaceId, {
        type: 'sticky_note',
        visibility: 'workspace_audience',
        title: `Changes from ${workspace.name}`,
        body: [
          `${changes.files.length} changed file${changes.files.length === 1 ? '' : 's'} from ${workspace.name}.`,
          fileSummary,
        ].filter(Boolean).join('\n\n'),
      });
      await convertWorkspaceCollaborationObjectToProposal(changes.sharedWorkspaceId, created.id);
      await Promise.all([loadChanges(), onSubmitted?.()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to submit changes for review');
    } finally {
      setSubmitting(false);
    }
  };

  const syncLatest = useCallback(async () => {
    if (!onSyncLatest) return;
    setError('');
    setSyncRequested(true);
    try {
      // Conflicting syncs are surfaced by the caller's `Resolve changes` dialog; reloading the diff
      // afterwards keeps this view consistent with whatever the sync produced.
      await onSyncLatest();
      await loadChanges();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to sync the latest Shared changes');
    } finally {
      setSyncRequested(false);
    }
  }, [loadChanges, onSyncLatest]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xl"
      PaperProps={{ sx: { height: 'min(880px, 90vh)', overflow: 'hidden' } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6">Review changes</Typography>
          <Typography variant="caption" color="text.secondary">
            {changes
              ? `${changes.sharedWorkspaceName} Working version → ${changes.privateWorkspaceName}`
              : workspace?.name || 'My draft'}
          </Typography>
        </Box>
        <IconButton aria-label="Close Review changes" onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      {changes?.isStale ? (
        <Alert
          severity="warning"
          square
          sx={{ px: 3, py: 1.5, '& .MuiAlert-message': { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, flex: 1, minWidth: 0 } }}
        >
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.25 }}>
              The Working version changed while you were editing privately.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {onSyncLatest
                ? 'Sync the latest version before this submission can be applied.'
                : 'Sync the latest version before this submission can be applied. Use Sync latest on the My draft row in the sidebar, or in its action menu.'}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
            {onSyncLatest ? (
              <MuiButton
                variant="outlined"
                size="small"
                startIcon={<RotateCcw size={14} />}
                disabled={isSyncing}
                onClick={() => { void syncLatest(); }}
              >
                {isSyncing ? 'Syncing…' : 'Sync latest'}
              </MuiButton>
            ) : null}
            <MuiButton variant="text" size="small" onClick={() => setSelectedPath(changes?.files[0]?.path || '')}>
              View differences
            </MuiButton>
          </Box>
        </Alert>
      ) : null}
      {error ? <Alert severity="error" square>{error}</Alert> : null}
      <DialogContent dividers sx={{ p: 0, display: 'flex', minHeight: 0 }}>
        {loading && !changes ? (
          <Box sx={{ m: 'auto', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CircularProgress size={24} />
            <Typography color="text.secondary">Comparing working copies…</Typography>
          </Box>
        ) : changes ? (
          <>
            <Box
              sx={{
                width: 310,
                flexShrink: 0,
                overflowY: 'auto',
                borderRight: 1,
                borderColor: 'divider',
                bgcolor: isDarkMode ? '#111827' : '#f8fafc',
              }}
            >
              <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle2">
                  {changes.files.length} changed file{changes.files.length === 1 ? '' : 's'}
                </Typography>
                <Typography variant="caption" sx={{ color: 'success.main', mr: 1 }}>+{totals.added}</Typography>
                <Typography variant="caption" sx={{ color: 'error.main' }}>−{totals.removed}</Typography>
              </Box>
              {changes.files.map((file) => {
                const selected = file.path === selectedPath;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedPath(file.path)}
                    className={`flex w-full items-start gap-2 border-b px-3 py-3 text-left transition-colors ${
                      selected
                        ? isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'
                        : isDarkMode ? 'border-slate-800 hover:bg-slate-800/70' : 'border-slate-100 hover:bg-white'
                    }`}
                  >
                    <span className={`mt-0.5 shrink-0 ${
                      file.status === 'added'
                        ? 'text-emerald-500'
                        : file.status === 'deleted' ? 'text-rose-500' : 'text-amber-500'
                    }`}>
                      {statusIcon(file.status)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{file.path}</span>
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        <span className="text-emerald-600">+{file.addedLines}</span>{' '}
                        <span className="text-rose-600">−{file.removedLines}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
              {!changes.files.length ? (
                <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 3 }}>
                  My draft matches the Shared Working version.
                </Typography>
              ) : null}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1, position: 'relative' }}>
              {selectedFile?.canCompareText ? (
                <Suspense fallback={<Box sx={{ p: 3 }}><CircularProgress size={24} /></Box>}>
                  <MonacoDiffEditor
                    original={selectedFile.sharedText || ''}
                    modified={selectedFile.privateText || ''}
                    language={languageForPath(selectedFile.path)}
                    theme={isDarkMode ? 'vs-dark' : 'vs'}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      automaticLayout: true,
                      minimap: { enabled: false },
                      originalEditable: false,
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                    }}
                  />
                </Suspense>
              ) : selectedFile ? (
                <Box sx={{ p: 4 }}>
                  <Typography variant="h6">Binary file changed</Typography>
                  <Typography color="text.secondary" sx={{ mt: 1 }}>
                    {selectedFile.path} cannot be displayed as a text comparison.
                  </Typography>
                </Box>
              ) : (
                <Box sx={{ p: 4 }}>
                  <Typography color="text.secondary">Select a changed file to compare it.</Typography>
                </Box>
              )}
            </Box>
          </>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">
          {changes?.proposal
            ? 'This draft already has an open submission for review.'
            : 'Submitting creates an immutable snapshot for publisher review.'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button label="Close" variant="ghost" onClick={onClose} />
          <Button
            label={changes?.proposal
              ? 'Submitted for review'
              : submitting ? 'Submitting…' : 'Submit for review'}
            variant="primary"
            icon={<GitPullRequestArrow size={16} />}
            isDisabled={submitting || !changes?.hasChanges || Boolean(changes?.proposal)}
            clickAction={submitForReview}
          />
        </Box>
      </DialogActions>
    </Dialog>
  );
}
