import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import WorkspacePage from './pages/WorkspacePage';
import AgentSettingsPage from './pages/AgentSettingsPage';
import DashboardPage from './pages/DashboardPage';
import KnowledgePage from './pages/KnowledgePage';
import UsersPage from './pages/UsersPage';
import BillingPage from './pages/BillingPage';

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<WorkspacePage />} />
      <Route path="/settings" element={<DashboardPage />} />
      <Route path="/settings/agents" element={<AgentSettingsPage />} />
      <Route path="/settings/knowledge" element={<KnowledgePage />} />
      <Route path="/settings/users" element={<UsersPage />} />
      <Route path="/settings/billing" element={<BillingPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default App;
