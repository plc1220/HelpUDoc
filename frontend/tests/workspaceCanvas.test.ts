import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkspaceCanvasTitle } from '../src/utils/workspaceCanvas.ts';

test('file canvas titles use the workspace filename, not the stored object id', () => {
  assert.equal(
    resolveWorkspaceCanvasTitle({
      selectedDashboardPath: null,
      dashboardDisplayName: '0509b984-423e-4802-8685-6253a973c5f8',
      selectedFileName: 'contradictions_and_uncertainties.md',
    }),
    'contradictions_and_uncertainties.md',
  );
});

test('dashboard canvas titles use the dashboard display name', () => {
  assert.equal(
    resolveWorkspaceCanvasTitle({
      selectedDashboardPath: 'dashboards/quarterly-review',
      dashboardDisplayName: 'Quarterly Review',
      selectedFileName: 'dashboard.meta.json',
    }),
    'Quarterly Review',
  );
});
