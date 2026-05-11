// PR 10 (frontend-workspace-split): canonical location is now
// `frontend/src/features/workspace/WorkspacePage.tsx`. This file is
// kept as a thin route re-export so existing imports (and the router in
// ProtectedShell) continue to work while the feature module owns the
// implementation.
export { default } from '../features/workspace/WorkspacePage';
