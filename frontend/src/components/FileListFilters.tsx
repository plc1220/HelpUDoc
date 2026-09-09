import React from 'react';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { ListFilter, User } from 'lucide-react';

import type { FileStatus } from '../types';
import {
  FILE_STATUS_DOT,
  FILE_STATUS_LABELS,
  FILE_STATUS_ORDER,
} from '../services/fileProvenanceApi';
import { ALL_OWNERS, type FileOwnerFilter, type FileOwnerOption } from '../utils/fileOwners';

export type FileStatusFilter = FileStatus | 'all';

/**
 * The two facets over the file list: status and owner.
 *
 * Both are dropdowns, and both sit on one row. Status used to be a row of
 * counted chips, which read well with three of them but wrapped to two lines as
 * soon as a workspace had all four statuses in play — and the wrap cost more
 * height than the file rows it was filtering. A dropdown states the current
 * selection in the same width whatever is selected.
 *
 * Each facet's counts exclude its own filter, so "Approved 2" means two among
 * what the owner filter already allows. WorkspacePage computes that; this
 * component only renders it.
 */

/** Shared trigger. `sm` is Astryx's smallest button, tightened for a 272px pane. */
const FACET_BUTTON_CLASS = 'min-h-0 h-7 px-2 gap-1.5 text-[11.5px] font-semibold';

type FacetItem = { label: string; icon?: React.ReactNode; isDisabled: boolean; onClick: () => void };

const FacetSelect: React.FC<{
  /** Accessible name — says what the control does, not what is chosen. */
  label: string;
  selection: string;
  icon?: React.ReactNode;
  items: FacetItem[];
}> = ({ label, selection, icon, items }) => (
  <DropdownMenu
    items={items}
    menuWidth={200}
    button={{
      size: 'sm',
      variant: 'secondary',
      width: '100%',
      label,
      icon,
      className: FACET_BUTTON_CLASS,
      children: <span className="truncate">{selection}</span>,
    }}
  />
);

export const FileListFilters: React.FC<{
  statusCounts: Record<FileStatus, number>;
  statusTotal: number;
  statusValue: FileStatusFilter;
  onStatusChange: (value: FileStatusFilter) => void;
  ownerOptions: FileOwnerOption[];
  ownerTotal: number;
  ownerValue: FileOwnerFilter;
  onOwnerChange: (value: FileOwnerFilter) => void;
  /**
   * Whether each facet is worth showing at all, judged on the whole file list
   * rather than on what the other facet currently allows.
   *
   * Visibility has to be the stable question. Judged on the narrowed list,
   * picking a status that happens to leave one owner would make the owner
   * control vanish underneath the pointer — and take the way back with it.
   */
  hasStatusChoices: boolean;
  hasOwnerChoices: boolean;
}> = ({
  statusCounts,
  statusTotal,
  statusValue,
  onStatusChange,
  ownerOptions,
  ownerTotal,
  ownerValue,
  onOwnerChange,
  hasStatusChoices,
  hasOwnerChoices,
}) => {
  // A status with nothing left in it is dropped from the menu rather than
  // offering a filter that leads to an empty list.
  const activeStatuses = FILE_STATUS_ORDER.filter((status) => statusCounts[status] > 0);
  if (!hasStatusChoices && !hasOwnerChoices) return null;

  const statusItems: FacetItem[] = [
    {
      label: `All statuses ${statusTotal}`,
      isDisabled: statusValue === 'all',
      onClick: () => onStatusChange('all'),
    },
    ...activeStatuses.map((status) => ({
      label: `${FILE_STATUS_LABELS[status]} ${statusCounts[status]}`,
      icon: <StatusDot variant={FILE_STATUS_DOT[status]} label={FILE_STATUS_LABELS[status]} />,
      isDisabled: statusValue === status,
      onClick: () => onStatusChange(status),
    })),
  ];

  const ownerItems: FacetItem[] = [
    {
      label: `All owners ${ownerTotal}`,
      isDisabled: ownerValue === ALL_OWNERS,
      onClick: () => onOwnerChange(ALL_OWNERS),
    },
    ...ownerOptions.map((option) => ({
      label: `${option.label} ${option.count}`,
      isDisabled: option.id === ownerValue,
      onClick: () => onOwnerChange(option.id),
    })),
  ];

  const selectedOwner = ownerOptions.find((option) => option.id === ownerValue);

  return (
    <div className="flex items-center gap-1 px-2 pb-1.5">
      {hasStatusChoices && (
        <div className="min-w-0 flex-1">
          <FacetSelect
            label="Filter by status"
            // Same wording as the menu item it corresponds to, so the trigger
            // reads as the selected row rather than a summary of it.
            selection={statusValue === 'all'
              ? `All statuses ${statusTotal}`
              : `${FILE_STATUS_LABELS[statusValue]} ${statusCounts[statusValue]}`}
            // Both triggers always carry an icon, so their labels start at the
            // same inset whatever is selected.
            icon={statusValue === 'all'
              ? <ListFilter size={13} aria-hidden="true" />
              : <StatusDot variant={FILE_STATUS_DOT[statusValue]} label={FILE_STATUS_LABELS[statusValue]} />}
            items={statusItems}
          />
        </div>
      )}
      {hasOwnerChoices && (
        <div className="min-w-0 flex-1">
          <FacetSelect
            label="Filter by owner"
            selection={selectedOwner
              ? `${selectedOwner.label} ${selectedOwner.count}`
              : `All owners ${ownerTotal}`}
            icon={<User size={13} aria-hidden="true" />}
            items={ownerItems}
          />
        </div>
      )}
    </div>
  );
};

export default FileListFilters;
