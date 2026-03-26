import { useEffect, useState, type ComponentType, type FC } from 'react';
import { Route, Routes } from 'react-router-dom';
import LoginPage from './pages/LoginPage';

type ProtectedShellModule = {
  default: ComponentType;
};

const protectedShellModules = import.meta.glob<ProtectedShellModule>('./ProtectedShell.tsx');

const loadProtectedShell = async (): Promise<ProtectedShellModule> => {
  const loader = protectedShellModules['./ProtectedShell.tsx'];
  if (!loader) {
    throw new Error('Unable to resolve protected shell module.');
  }

  return loader();
};

const ProtectedShellView: FC = () => {
  const [Shell, setShell] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setShell(null);
    setError(null);

    void loadProtectedShell()
      .then((mod) => {
        if (!cancelled) {
          setShell(() => mod.default);
        }
      })
      .catch((loadError) => {
        console.error('Failed to load protected shell', loadError);
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load app shell.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] text-slate-500">
        {error}
      </div>
    );
  }

  if (!Shell) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] text-slate-500">
        Loading page…
      </div>
    );
  }

  return <Shell />;
};

const App: FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<ProtectedShellView />} />
    </Routes>
  );
};

export default App;
