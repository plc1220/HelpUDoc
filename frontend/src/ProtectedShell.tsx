import { Suspense, lazy, type FC, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';

const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
const AgentSettingsPage = lazy(() => import('./pages/AgentSettingsPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));

const RequireAuth: FC<{ children: ReactElement }> = ({ children }) => {
  const { user, loading } = useAuth();
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

  return children;
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
              <KnowledgePage />
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
