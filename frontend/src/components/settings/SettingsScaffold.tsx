// PR 10 (frontend-workspace-split): canonical location is now
// `frontend/src/features/settings/components/SettingsScaffold.tsx`.
// This shim preserves the legacy import path during the rename.
export {
  SettingsSurface,
  SettingsSectionHeader,
  SettingsNotice,
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsMetricsGrid,
  SettingsMetricCard,
  SettingsTabs,
  SettingsTabPanel,
} from '../../features/settings/components/SettingsScaffold';
