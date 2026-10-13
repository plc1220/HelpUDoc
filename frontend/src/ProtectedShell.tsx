import { Suspense, lazy, type FC, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/useAuth';
import { SessionExpiredDialog } from './components/SessionExpiredDialog';

const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
const AgentSettingsPage = lazy(() => import('./pages/AgentSettingsPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const KnowledgeGovernancePage = lazy(() => import('./pages/KnowledgeGovernancePage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const AdminWorkspacesPage = lazy(() => import('./pages/AdminWorkspacesPage'));
const ActivityPage = lazy(() => import('./pages/ActivityPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const SkillGovernancePage = lazy(() => import('./pages/SkillGovernancePage'));

const RequireAuth: FC<{ children: ReactElement }> = ({ children }) => {
  const { user, loading, authExpired, signOut } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] text-slate-600">
        Checking your session…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Signing out clears `user`, so the redirect above takes the user to /login and,
  // after sign-in, back to this page.
  return (
    <>
      {children}
      {authExpired ? <SessionExpiredDialog reason={authExpired} onSignIn={signOut} /> : null}
    </>
  );
};

const ProtectedShell: FC = () => {
  return (
    <Suspense
      fallback={(
        <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] text-slate-500">
          Loading page…
        </div>
      )}
    >
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <WorkspacePage />
            </RequireAuth>
          }
        />
        <Route
          path="/skills"
          element={
            <RequireAuth>
              <SkillGovernancePage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/agents"
          element={
            <RequireAuth>
              <AgentSettingsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/knowledge"
          element={
            <RequireAuth>
              <KnowledgeGovernancePage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/users"
          element={
            <RequireAuth>
              <UsersPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/activity"
          element={
            <RequireAuth>
              <ActivityPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/workspaces"
          element={
            <RequireAuth>
              <AdminWorkspacesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/billing"
          element={
            <RequireAuth>
              <BillingPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
};

export default ProtectedShell;
