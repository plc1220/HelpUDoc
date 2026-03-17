import type { ComponentType, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

type SurfaceProps = {
  children: ReactNode;
  className?: string;
};

export const SettingsSurface = ({ children, className }: SurfaceProps) => (
  <section
    className={cx(
      'rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-[0_18px_45px_rgba(15,23,42,0.08)] backdrop-blur',
      className,
    )}
  >
    {children}
  </section>
);

type SectionHeaderProps = {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
};

export const SettingsSectionHeader = ({ title, description, eyebrow, actions }: SectionHeaderProps) => (
  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
    <div className="space-y-1.5">
      {eyebrow ? (
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{eyebrow}</p>
      ) : null}
      <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
      {description ? <p className="max-w-2xl text-sm leading-6 text-slate-600">{description}</p> : null}
    </div>
    {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
  </div>
);

type NoticeProps = {
  children: ReactNode;
  variant?: 'info' | 'warning' | 'error';
  className?: string;
};

const noticeStyles: Record<NonNullable<NoticeProps['variant']>, string> = {
  info: 'border-slate-200 bg-slate-50 text-slate-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  error: 'border-rose-200 bg-rose-50 text-rose-700',
};

export const SettingsNotice = ({ children, variant = 'info', className }: NoticeProps) => (
  <div className={cx('rounded-2xl border px-4 py-3 text-sm shadow-sm', noticeStyles[variant], className)}>{children}</div>
);

type EmptyStateProps = {
  title: string;
  description: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  action?: ReactNode;
  align?: 'left' | 'center';
};

export const SettingsEmptyState = ({
  title,
  description,
  icon: Icon,
  action,
  align = 'center',
}: EmptyStateProps) => (
  <div
    className={cx(
      'rounded-[24px] border border-dashed border-slate-200 bg-slate-50/90 p-8',
      align === 'center' ? 'text-center' : 'text-left',
    )}
  >
    <div className={cx('flex gap-4', align === 'center' ? 'flex-col items-center' : 'items-start')}>
      {Icon ? (
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-slate-700 shadow-sm ring-1 ring-slate-200">
          <Icon size={20} />
        </span>
      ) : null}
      <div className={cx('space-y-2', align === 'center' ? 'max-w-md' : 'flex-1')}>
        <p className="text-base font-semibold text-slate-900">{title}</p>
        <p className="text-sm leading-6 text-slate-600">{description}</p>
        {action ? <div className={cx('pt-2', align === 'center' ? 'flex justify-center' : 'flex')}>{action}</div> : null}
      </div>
    </div>
  </div>
);

type LoadingStateProps = {
  label: string;
  className?: string;
};

export const SettingsLoadingState = ({ label, className }: LoadingStateProps) => (
  <div className={cx('flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600', className)}>
    <Loader2 className="h-4 w-4 animate-spin" />
    {label}
  </div>
);

type MetricsGridProps = {
  children: ReactNode;
  className?: string;
};

export const SettingsMetricsGrid = ({ children, className }: MetricsGridProps) => (
  <div className={cx('grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3', className)}>{children}</div>
);

type MetricCardProps = {
  label: string;
  value: string;
  hint?: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
};

export const SettingsMetricCard = ({ label, value, hint, icon: Icon }: MetricCardProps) => (
  <div className="rounded-[24px] border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-slate-100/80 p-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">{label}</p>
        <p className="mt-3 text-3xl font-semibold text-slate-950">{value}</p>
        {hint ? <p className="mt-1 text-sm text-slate-500">{hint}</p> : null}
      </div>
      {Icon ? (
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-sm">
          <Icon size={18} />
        </span>
      ) : null}
    </div>
  </div>
);

type TabsProps<T extends string> = {
  tabs: Array<{
    id: T;
    label: string;
    icon?: ComponentType<{ size?: number; className?: string }>;
  }>;
  value: T;
  onChange: (value: T) => void;
};

export const SettingsTabs = <T extends string>({ tabs, value, onChange }: TabsProps<T>) => (
  <div className="inline-flex flex-wrap items-center gap-1 rounded-2xl border border-slate-200 bg-slate-100/90 p-1 shadow-inner">
    {tabs.map(({ id, label, icon: Icon }) => {
      const isActive = id === value;
      return (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cx(
            'inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition',
            isActive
              ? 'bg-white text-slate-950 shadow-sm ring-1 ring-slate-200'
              : 'text-slate-600 hover:bg-white/80 hover:text-slate-900',
          )}
        >
          {Icon ? <Icon size={16} /> : null}
          {label}
        </button>
      );
    })}
  </div>
);

type TabPanelProps = {
  children: ReactNode;
  className?: string;
};

export const SettingsTabPanel = ({ children, className }: TabPanelProps) => (
  <SettingsSurface className={cx('min-h-[500px]', className)}>{children}</SettingsSurface>
);
