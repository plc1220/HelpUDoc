import React from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';

import type { FileStatus } from '../types';
import {
  FILE_STATUS_DOT,
  FILE_STATUS_LABELS,
  FILE_STATUS_ORDER,
} from '../services/fileProvenanceApi';

export type FileStatusFilter = FileStatus | 'all';

/**
 * Narrows the file list to one status.
 *
 * Counts are shown so a reviewer can see there is something waiting without
 * opening anything, and a status with nothing in it is hidden rather than
 * offering a filter that leads to an empty list.
 */
export const FileStatusFilterBar: React.FC<{
  counts: Record<FileStatus, number>;
  total: number;
  value: FileStatusFilter;
  onChange: (value: FileStatusFilter) => void;
}> = ({ counts, total, value, onChange }) => {
  const active = FILE_STATUS_ORDER.filter((status) => counts[status] > 0);
  // With everything in one state there is nothing to narrow down to.
  if (active.length < 2) return null;

  return (
    <HStack gap={1} wrap="wrap" paddingInline={2} paddingBlock={1}>
      <Button
        size="sm"
        variant={value === 'all' ? 'primary' : 'ghost'}
        label={`All ${total}`}
        onClick={() => onChange('all')}
      />
      {active.map((status) => (
        <Button
          key={status}
          size="sm"
          variant={value === status ? 'primary' : 'ghost'}
          label={`${FILE_STATUS_LABELS[status]} ${counts[status]}`}
          icon={<StatusDot variant={FILE_STATUS_DOT[status]} label={FILE_STATUS_LABELS[status]} />}
          onClick={() => onChange(status)}
        />
      ))}
    </HStack>
  );
};

export default FileStatusFilterBar;
