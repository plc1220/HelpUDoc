import React from 'react';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { User } from 'lucide-react';

import { ALL_OWNERS, type FileOwnerFilter as OwnerFilter, type FileOwnerOption } from '../utils/fileOwners';

/**
 * Narrows the file list to one owner.
 *
 * A dropdown rather than the chip row the status filter uses: statuses are a
 * closed set of four, owners are open-ended, and a workspace with a dozen
 * contributors would wrap the pane into a wall of chips.
 *
 * Hidden below two owners, matching FileStatusFilterBar — with everything owned
 * by one person there is nothing to narrow to.
 */
export const FileOwnerFilter: React.FC<{
  options: FileOwnerOption[];
  total: number;
  value: OwnerFilter;
  onChange: (value: OwnerFilter) => void;
}> = ({ options, total, value, onChange }) => {
  if (options.length < 2) return null;

  const selected = options.find((option) => option.id === value);
  const items = [
    {
      label: `All owners ${total}`,
      isDisabled: value === ALL_OWNERS,
      onClick: () => onChange(ALL_OWNERS),
    },
    ...options.map((option) => ({
      label: `${option.label} ${option.count}`,
      isDisabled: option.id === value,
      onClick: () => onChange(option.id),
    })),
  ];

  return (
    <DropdownMenu
      items={items}
      button={{
        size: 'sm',
        variant: 'secondary',
        width: '100%',
        // The button label is the accessible name, so it says what the control
        // does; the visible text is the current selection.
        label: 'Filter by owner',
        icon: <User size={15} aria-hidden="true" />,
        children: selected ? `${selected.label} ${selected.count}` : `All owners ${total}`,
      }}
    />
  );
};

export default FileOwnerFilter;
