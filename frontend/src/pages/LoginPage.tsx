import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sparkles, ShieldCheck, Lock, ArrowRight, Sun, Moon, LogIn } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

type PaletteMode = 'light' | 'dark';

const featureHighlights = [
  { icon: ShieldCheck, title: 'Workspace privacy', description: 'You only see your own projects and data.' },
  { icon: Lock, title: 'Secure access', description: 'Google sign-in keeps your identity tied to your workspace.' },
  { icon: Sparkles, title: 'Stay in flow', description: 'Pick up right where you left off after logging in.' },
];

const LoginPage = () => {
  const { user, loading, signInWithGoogle, signInWithEmail } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [colorMode, setColorMode] = useState<PaletteMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem('helpudoc-color-mode');
    return stored === 'dark' ? 'dark' : 'light';
  });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorMode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('helpudoc-color-mode', colorMode);
    }
  }, [colorMode]);

  useEffect(() => {
    if (user) {
      const redirectTo = (location.state as any)?.from || '/';
      navigate(redirectTo, { replace: true });
    }
  }, [location.state, navigate, user]);

  const handleGoogleLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('Google sign-in failed', err);
      const message = err instanceof Error ? err.message : 'Unable to sign in with Google right now.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmail(email, name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to sign in with email right now.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBypassLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmail('local-user@example.com', 'Local User', 'local-user');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to bypass login right now.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const accentGradient = useMemo(
    () =>
      colorMode === 'light'
        ? 'from-blue-500/90 via-indigo-500/80 to-sky-500/90'
        : 'from-blue-500/70 via-indigo-500/60 to-sky-500/70',
    [colorMode],
  );

  return (
    <>
      <div className="min-h-screen bg-[radial-gradient(circle_at_20%_20%,rgba(59,130,246,0.12),transparent_32%),radial-gradient(circle_at_80%_0%,rgba(99,102,241,0.12),transparent_26%),linear-gradient(180deg,var(--app-bg),color-mix(in_srgb,var(--app-bg)_90%,transparent))]">
        <div className="flex min-h-screen flex-col lg:flex-row">
          <aside className="w-full lg:w-[40%] px-8 py-10 lg:py-14">
            <div className={`relative h-full overflow-hidden rounded-3xl border border-slate-200/60 bg-gradient-to-br ${accentGradient} text-white shadow-xl shadow-blue-500/15`}>
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.18),transparent_40%)]" aria-hidden />
              <div className="relative flex h-full flex-col justify-between p-8 lg:p-10">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-2xl bg-white/15 text-white">
                      <Sparkles size={20} />
                    </span>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-white/80">HelpUDoc</p>
                      <h1 className="text-2xl font-semibold leading-tight">Workspace Access</h1>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setColorMode((prev) => (prev === 'light' ? 'dark' : 'light'))}
                    className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-2 text-xs font-semibold backdrop-blur hover:border-white/40"
                  >
                    {colorMode === 'light' ? <Moon size={14} /> : <Sun size={14} />}
                    {colorMode === 'light' ? 'Dark mode' : 'Light mode'}
                  </button>
                </div>

                <div className="mt-10 space-y-5">
                  <p className="text-lg font-medium text-white/90">
                    Sign in to collaborate securely with agents across your private workspace. Your data stays yours.
                  </p>
                  <div className="grid grid-cols-1 gap-4">
                    {featureHighlights.map(({ icon: Icon, title, description }) => (
                      <div key={title} className="flex items-start gap-3 rounded-2xl bg-white/12 p-4 shadow-sm shadow-black/10">
                        <span className="mt-1 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 text-white">
                          <Icon size={18} />
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-white">{title}</p>
                          <p className="text-sm text-white/80">{description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-8 flex items-center gap-3 text-sm text-white/80">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white">
                    <Lock size={16} />
                  </span>
                  Single sign-on ensures each workspace is scoped to your account only.
                </div>
              </div>
            </div>
          </aside>

          <main className="flex w-full flex-1 items-center px-6 py-10 sm:px-10 lg:px-16">
            <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white/80 p-8 shadow-xl shadow-blue-500/5 backdrop-blur dark:border-slate-700/60 dark:bg-slate-900/80">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Sign in</p>
                  <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Welcome back</h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Access your HelpUDoc workspace and keep your data isolated to your account.</p>
                </div>
                <span className="hidden sm:inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-100">
                  <LogIn size={20} />
                </span>
              </div>

              {error ? (
                <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              ) : null}

              <div className="mt-6 space-y-4">
                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={submitting || loading}
                  className="group relative flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-70 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-50"
                >
                  <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500">
                    <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" className="opacity-80">
                      <path fill="#EA4335" d="M10 4.167c1.108 0 2.045.383 2.805 1.14l2.094-2.094C13.66 1.948 11.975 1.25 10 1.25 6.942 1.25 4.275 3.075 3.083 5.708l2.5 1.942C6.083 6.108 7.833 4.167 10 4.167Z" />
                      <path fill="#34A853" d="M17.917 10.208c0-.7-.058-1.208-.183-1.742H10v3.333h4.583c-.092.742-.592 1.858-1.7 2.608l2.625 2.03c1.6-1.483 2.409-3.667 2.409-6.229Z" />
                      <path fill="#4A90E2" d="m5.583 11.583-.392-.241-2.433 1.883C4.142 16.467 6.85 18.75 10 18.75c2.5 0 4.592-.833 6.125-2.275l-2.625-2.031C12.517 15.5 11.433 16 10 16c-2.142 0-3.95-1.4-4.633-3.417Z" />
                      <path fill="#FBBC05" d="M3.167 7.65 5.75 9.55C6.433 7.533 8.241 6.133 10.383 6.133c1.525 0 2.592.65 3.184 1.2l2.35-2.35C14.733 3.983 12.642 2.917 10 2.917 6.85 2.917 4.142 5.2 3.167 7.65Z" />
                    </svg>
                  </span>
                  {submitting ? 'Signing in…' : 'Continue with Google'}
                  <ArrowRight size={16} className="text-slate-500 transition group-hover:translate-x-0.5" />
                </button>

                <div className="flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-slate-500">
                  <span className="h-px flex-1 bg-slate-200" />
                  or use your work email
                  <span className="h-px flex-1 bg-slate-200" />
                </div>

                <form onSubmit={handleEmailLogin} className="space-y-3">
                  <label className="block text-sm font-semibold text-slate-700 dark:text-slate-100" htmlFor="email">
                    Work email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-50"
                    required
                  />
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-semibold text-slate-700 dark:text-slate-100" htmlFor="name">
                      Display name <span className="text-slate-400">(optional)</span>
                    </label>
                    <p className="text-xs text-slate-500">Keeps your messages labeled.</p>
                  </div>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Alex Analyst"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-50"
                  />
                  <button
                    type="submit"
                    disabled={submitting || loading}
                    className="group mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition hover:-translate-y-0.5 hover:shadow-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {submitting ? 'Signing in…' : 'Continue with email'}
                    <ArrowRight size={16} className="transition group-hover:translate-x-0.5" />
                  </button>
                </form>
              </div>

              <div className="mt-6 flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300">
                <div>
                  <p className="font-semibold text-slate-800 dark:text-slate-100">Workspace isolation</p>
                  <p className="text-slate-600 dark:text-slate-300">After signing in you only see workspaces linked to your account.</p>
                </div>
                <ShieldCheck className="text-blue-600 dark:text-blue-400" size={20} />
              </div>
            </div>
          </main>
        </div>
      </div>
      <button
        type="button"
        onClick={handleBypassLogin}
        disabled={submitting || loading}
        className="fixed bottom-5 right-5 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-slate-400/30 transition hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-70"
      >
        Skip login (dev)
      </button>
    </>
  );
};

export default LoginPage;
