import type { ComponentType, ReactNode } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Loader2 } from 'lucide-react';

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

type SurfaceProps = {
  children: ReactNode;
  className?: string;
};

export const SettingsSurface = ({ children, className }: SurfaceProps) => (
  <Card
    padding={6}
    className={cx(
      'settings-portal-surface',
      className,
    )}
  >
    {children}
  </Card>
);

type SectionHeaderProps = {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
};

export const SettingsSectionHeader = ({ title, description, eyebrow, actions }: SectionHeaderProps) => (
  <div className="settings-section-header">
    <div className="settings-section-header-copy">
      {eyebrow ? (
        <Text type="label" color="secondary" display="block" className="settings-section-eyebrow">{eyebrow}</Text>
      ) : null}
      <Heading level={3} className="settings-section-title">{title}</Heading>
      {description ? <Text type="supporting" color="secondary" as="p" className="settings-section-description">{description}</Text> : null}
    </div>
    {actions ? <div className="settings-section-actions">{actions}</div> : null}
  </div>
);

type NoticeProps = {
  children: ReactNode;
  variant?: 'info' | 'warning' | 'error';
  className?: string;
};

const noticeStyles: Record<NonNullable<NoticeProps['variant']>, string> = {
  info: 'settings-notice-info',
  warning: 'settings-notice-warning',
  error: 'settings-notice-error',
};

export const SettingsNotice = ({ children, variant = 'info', className }: NoticeProps) => (
  <div className={cx('settings-notice', noticeStyles[variant], className)}>{children}</div>
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
      'settings-empty-state',
      align === 'center' ? 'settings-empty-state-centered' : 'settings-empty-state-aligned',
    )}
  >
    <div className={cx('settings-empty-state-content', align === 'center' ? 'settings-empty-state-content-centered' : '')}>
      {Icon ? (
        <span className="settings-portal-icon-muted settings-empty-state-icon">
          <Icon size={20} />
        </span>
      ) : null}
      <div className={cx('settings-empty-state-copy', align === 'center' ? 'settings-empty-state-copy-centered' : '')}>
        <Text type="large" weight="semibold" as="p">{title}</Text>
        <Text type="supporting" color="secondary" as="p">{description}</Text>
        {action ? <div className="settings-empty-state-action">{action}</div> : null}
      </div>
    </div>
  </div>
);

type LoadingStateProps = {
  label: string;
  className?: string;
};

export const SettingsLoadingState = ({ label, className }: LoadingStateProps) => (
  <div className={cx('settings-loading-state', className)}>
    <Loader2 className="settings-loading-state-icon animate-spin" />
    <Text type="supporting" color="secondary">{label}</Text>
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
  <Card padding={5} className="settings-portal-card">
    <div className="settings-metric-card-content">
      <div>
        <Text type="label" color="secondary" display="block" className="settings-section-eyebrow">{label}</Text>
        <Text size="3xl" weight="semibold" display="block" className="settings-metric-value">{value}</Text>
        {hint ? <Text type="supporting" color="secondary" display="block">{hint}</Text> : null}
      </div>
      {Icon ? (
        <span className="settings-portal-icon settings-metric-icon">
          <Icon size={18} />
        </span>
      ) : null}
    </div>
  </Card>
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
  <div className="settings-portal-tabs">
    {tabs.map(({ id, label, icon: Icon }) => {
      const isActive = id === value;
      return (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cx(
            'settings-portal-tab',
            isActive
              ? 'settings-portal-tab-active'
              : '',
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
  <SettingsSurface className={cx('min-h-[520px]', className)}>{children}</SettingsSurface>
);
