import React from 'react';
import { Badge } from '@astryxdesign/core/Badge';

import type { FileStatus } from '../types';
import { FILE_STATUS_LABELS, FILE_STATUS_VARIANTS } from '../services/fileProvenanceApi';

/**
 * Status indicator for a file row.
 *
 * Draft renders nothing: it is the resting state of nearly every file, and a
 * badge on every row would bury the states a reviewer actually needs to see.
 * Drift is shown instead of the status because content changing after sign-off
 * is the thing that needs acting on.
 */
export const FileStatusBadge: React.FC<{
  status?: FileStatus | null;
  drift?: boolean;
}> = ({ status, drift }) => {
  if (!status || status === 'draft') return null;

  if (drift) {
    return (
      <Badge
        variant="warning"
        label={`${FILE_STATUS_LABELS[status]} · edited since`}
      />
    );
  }

  const variant = FILE_STATUS_VARIANTS[status];
  if (!variant) return null;
  return <Badge variant={variant} label={FILE_STATUS_LABELS[status]} />;
};
