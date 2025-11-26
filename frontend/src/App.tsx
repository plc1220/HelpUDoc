import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import WorkspacePage from './pages/WorkspacePage';
import AgentSettingsPage from './pages/AgentSettingsPage';
import DashboardPage from './pages/DashboardPage';
import KnowledgePage from './pages/KnowledgePage';
import UsersPage from './pages/UsersPage';
import BillingPage from './pages/BillingPage';
import LoginPage from './pages/LoginPage';
import { useAuth } from './auth/AuthProvider';

const RequireAuth: React.FC<{ children: React.ReactElement }> = ({ children }) => {
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

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
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
  );
};

export default App;
