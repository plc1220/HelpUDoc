import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';

import type { PublicationConflict } from '../services/workspaceApi';

type WorkspaceConflictDialogProps = {
  open: boolean;
  conflicts: PublicationConflict[];
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (resolutions: Record<string, 'private' | 'team'>) => void | Promise<void>;
};

const WorkspaceConflictDialog: React.FC<WorkspaceConflictDialogProps> = ({
  open,
  conflicts,
  busy = false,
  error,
  onClose,
  onConfirm,
}) => {
  const [resolutions, setResolutions] = useState<Record<string, 'private' | 'team'>>({});

  useEffect(() => {
    if (open) setResolutions({});
  }, [open, conflicts]);

  const complete = useMemo(
    () => conflicts.length > 0 && conflicts.every((conflict) => Boolean(resolutions[conflict.path])),
    [conflicts, resolutions],
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Review workspace changes</DialogTitle>
      <DialogContent dividers>
        <Alert severity="warning" sx={{ mb: 2 }}>
          These files changed in both your private copy and the team version. Choose which version to keep.
        </Alert>
        {conflicts.map((conflict) => (
          <div key={conflict.path} style={{ marginBottom: 18 }}>
            <Typography variant="subtitle2">{conflict.path}</Typography>
            <Typography variant="caption" color="text.secondary">
              Your copy: {conflict.privateChange}; team: {conflict.teamChange}
            </Typography>
            {conflict.privateText !== undefined && conflict.teamText !== undefined ? (
              <>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mt: 1 }}>
                  <Box>
                    <Typography variant="caption" sx={{ fontWeight: 700 }}>Your copy</Typography>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        mt: 0.5,
                        p: 1,
                        maxHeight: 180,
                        overflow: 'auto',
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 1,
                        fontSize: '0.72rem',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {conflict.privateText}
                    </Box>
                  </Box>
                  <Box>
                    <Typography variant="caption" sx={{ fontWeight: 700 }}>Team version</Typography>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        mt: 0.5,
                        p: 1,
                        maxHeight: 180,
                        overflow: 'auto',
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 1,
                        fontSize: '0.72rem',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {conflict.teamText}
                    </Box>
                  </Box>
                </Box>
                {conflict.textTruncated ? (
                  <Typography variant="caption" color="text.secondary">
                    Preview shortened for this large file.
                  </Typography>
                ) : null}
              </>
            ) : null}
            <RadioGroup
              row
              value={resolutions[conflict.path] || ''}
              onChange={(event) => {
                const value = event.target.value as 'private' | 'team';
                setResolutions((current) => ({ ...current, [conflict.path]: value }));
              }}
            >
              <FormControlLabel value="private" control={<Radio />} label="Keep mine" />
              <FormControlLabel value="team" control={<Radio />} label="Use team version" />
            </RadioGroup>
          </div>
        ))}
        {error ? <Alert severity="error">{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void onConfirm(resolutions)}
          disabled={!complete || busy}
        >
          Apply team updates
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default WorkspaceConflictDialog;
