import { useEffect, useState, type ComponentType, type FC } from 'react';
import { Route, Routes } from 'react-router-dom';
import LoginPage from './pages/LoginPage';

type ProtectedShellModule = {
  default: ComponentType;
};

type ManifestEntry = {
  file: string;
  src?: string;
};

const runtimeImport = new Function('url', 'return import(url)') as (url: string) => Promise<ProtectedShellModule>;

const manifestPromise = fetch('/.vite/manifest.json')
  .then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load manifest: ${response.status}`);
    }
    return response.json() as Promise<Record<string, ManifestEntry>>;
  })
  .catch((error) => {
    console.error('Failed to load protected shell manifest', error);
    return null;
  });

const loadProtectedShell = async (): Promise<ProtectedShellModule> => {
  const manifest = await manifestPromise;
  if (!manifest) {
    throw new Error('Protected shell manifest unavailable.');
  }

  const entry = Object.values(manifest).find((value) => value.src?.replace(/\\/g, '/').endsWith('src/ProtectedShell.tsx'));
  if (!entry) {
    throw new Error('Unable to resolve protected shell module.');
  }

  return runtimeImport(`/${entry.file}`);
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
