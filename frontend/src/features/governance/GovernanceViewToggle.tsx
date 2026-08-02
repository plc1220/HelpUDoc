import { AlignJustify, Grid2X2, Rows3 } from 'lucide-react';

export type GovernanceViewMode = 'card' | 'list' | 'compact';

const modes: Array<{ id: GovernanceViewMode; label: string; icon: typeof Grid2X2 }> = [
  { id: 'card', label: 'Card view', icon: Grid2X2 },
  { id: 'list', label: 'List view', icon: Rows3 },
  { id: 'compact', label: 'Compact view', icon: AlignJustify },
];

export default function GovernanceViewToggle({
  value,
  onChange,
}: {
  value: GovernanceViewMode;
  onChange: (value: GovernanceViewMode) => void;
}) {
  return (
    <div className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1" role="radiogroup" aria-label="Choose display style">
      {modes.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          aria-label={label}
          title={label}
          onClick={() => onChange(id)}
          className={`rounded-lg p-2 transition ${value === id ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}
