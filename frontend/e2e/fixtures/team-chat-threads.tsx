import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '../../src/index.css';
import { AppThemeRoot } from '../../src/AppThemeRoot';
import { applyColorModeToDocument } from '../../src/colorMode';
import WorkspaceTeamChatPanel from '../../src/components/chat/WorkspaceTeamChatPanel';
import type { Workspace } from '../../src/types';

applyColorModeToDocument('light');

// Preload a stable local auth user so getAuthUser() returns a deterministic id
// for per-user draft isolation and read-state ownership.
try {
  window.localStorage.setItem('helpudoc-auth-user', JSON.stringify({ id: 'me', name: 'Me', provider: 'local' }));
} catch {
  /* ignore */
}

// Width and role are overridable via query params so tests can exercise the
// panel-width-based split/back behavior (spec F1) and permission gating.
const params = new URLSearchParams(window.location.search);
const width = Number(params.get('paneWidth') || 900);
const role = (params.get('role') as Workspace['role']) || 'owner';

const workspace = {
  id: 'wsA',
  name: 'Fixture workspace',
  role,
  canEdit: role === 'owner' || role === 'editor',
  visibility: 'team',
} as unknown as Workspace;

export function Fixture() {
  return (
    <div style={{ height: 640, width, display: 'flex' }}>
      <WorkspaceTeamChatPanel workspace={workspace} colorMode="light" markdownComponents={{}} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <AppThemeRoot>
    <BrowserRouter>
      <Fixture />
    </BrowserRouter>
  </AppThemeRoot>,
);
