import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sun, Moon } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

interface LocationState {
  from?: string;
}

type PaletteMode = 'light' | 'dark';

const LoginPage = () => {
  const { user, googleReady, googleError, authMode, signInWithGoogle, signInWithHeaders } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [colorMode, setColorMode] = useState<PaletteMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem('helpudoc-color-mode');
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [headerName, setHeaderName] = useState('');
  const [headerEmail, setHeaderEmail] = useState('');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorMode);
    document.documentElement.classList.toggle('dark', colorMode === 'dark');
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('helpudoc-color-mode', colorMode);
    }
  }, [colorMode]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const authError = params.get('authError');
    if (authError) {
      setError(`Google sign-in failed: ${authError}`);
      return;
    }
    if (user) {
      const state = location.state as LocationState | null;
      const returnTo = params.get('returnTo');
      const redirectTo = (returnTo && returnTo.startsWith('/')) ? returnTo : (state?.from || '/');
      navigate(redirectTo, { replace: true });
    }
  }, [location.search, location.state, navigate, user]);

  const heroImage = useMemo(() => (colorMode === 'light' ? '/Day.png' : '/Night.png'), [colorMode]);

  const handleGoogleLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const state = location.state as LocationState | null;
      await signInWithGoogle(state?.from || '/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start Google sign-in.';
      setError(message);
      setSubmitting(false);
    }
  };

  const handleHeaderLogin = async () => {
    const trimmedName = headerName.trim();
    if (!trimmedName) {
      setError('Enter a display name to continue in header auth mode.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signInWithHeaders({
        name: trimmedName,
        email: headerEmail.trim() || null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start header-mode sign-in.';
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Background Image */}
      <div className="absolute inset-0">
        <div
          className="absolute inset-0 bg-cover bg-center transition-all duration-700"
          style={{ backgroundImage: `url(${heroImage})` }}
        />
        {/* Subtle overlay for better contrast */}
        <div className="absolute inset-0 bg-black/10 dark:bg-black/30" />
      </div>

      {/* Floating decorative elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 left-10 w-72 h-72 bg-gradient-to-br from-blue-500/10 to-cyan-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDuration: '4s' }} />
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-gradient-to-br from-teal-500/10 to-blue-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDuration: '6s', animationDelay: '2s' }} />
      </div>

      {/* Main content */}
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-10">
        <div
          className="w-full max-w-md"
          style={{ animation: 'float 6s ease-in-out infinite' }}
        >
          {/* Glass Card */}
          <div
            className="relative backdrop-blur-xl rounded-[28px] border border-slate-200 dark:border-slate-700/50 shadow-2xl shadow-black/10 dark:shadow-black/30 overflow-hidden"
            style={{ backgroundColor: colorMode === 'light' ? 'rgba(255, 255, 255, 0.50)' : 'rgba(15, 23, 42, 0.50)' }}
          >


            {/* Card content */}
            <div className="p-8 lg:p-10 relative">
              {/* Theme toggle - inside card, top left */}
              <button
                type="button"
                onClick={() => setColorMode((prev) => (prev === 'light' ? 'dark' : 'light'))}
                className="absolute top-6 left-6 z-20"
                aria-label="Toggle color mode"
              >
                <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/50 backdrop-blur-sm border border-slate-200 dark:border-slate-700/50 shadow-sm transition-all duration-300 hover:scale-110 hover:bg-slate-200 dark:hover:bg-slate-700/80 hover:shadow-md">
                  {colorMode === 'light' ? (
                    <Moon size={16} className="text-slate-700" />
                  ) : (
                    <Sun size={16} className="text-amber-400" />
                  )}
                </div>
              </button>

              {/* Logo and title */}
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center mb-4">
                  <img src="/logo.png" alt="HelpUDoc Logo" className="w-32 h-32 object-contain" />
                </div>
                <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">
                  Welcome back
                </h1>
                <p className="text-slate-600 dark:text-slate-300 text-sm">
                  Sign in to continue to <span className="font-semibold text-blue-600 dark:text-blue-400">HelpUDoc</span>
                </p>
              </div>

              {/* Error message */}
              {error && (
                <div className="mb-6 p-4 rounded-2xl bg-red-100/80 dark:bg-red-500/20 backdrop-blur-sm border border-red-200 dark:border-red-500/30 animate-shake">
                  <p className="text-red-700 dark:text-red-300 text-sm text-center">{error}</p>
                </div>
              )}

              {authMode === 'headers' ? (
                <>
                  <div className="mb-6 rounded-2xl bg-slate-100/70 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50 px-4 py-3 text-sm text-slate-600 dark:text-slate-300 text-center">
                    Header auth mode is enabled. Enter a local identity to seed the `X-User-*` headers for this browser.
                  </div>

                  <div className="space-y-3">
                    <input
                      type="text"
                      value={headerName}
                      onChange={(event) => setHeaderName(event.target.value)}
                      placeholder="Display name"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-800/70 px-4 py-3 text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500"
                    />
                    <input
                      type="email"
                      value={headerEmail}
                      onChange={(event) => setHeaderEmail(event.target.value)}
                      placeholder="Email (optional)"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-800/70 px-4 py-3 text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={handleHeaderLogin}
                      disabled={submitting}
                      className="w-full mt-1 py-3 rounded-xl border border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-800/70 text-slate-800 dark:text-slate-100 text-sm font-semibold transition-all duration-300 hover:bg-white dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Continue in Header Mode
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-6 rounded-2xl bg-slate-100/70 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50 px-4 py-3 text-sm text-slate-600 dark:text-slate-300 text-center">
                    Sign in with your Google account to access HelpUDoc.
                  </div>

                  <div className="relative">
                    {googleError ? (
                      <div className="text-center text-xs text-red-600 dark:text-red-400 p-3 rounded-xl bg-red-100/80 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                        {googleError}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handleGoogleLogin}
                        disabled={!googleReady || submitting}
                        className="w-full mt-1 py-3 rounded-xl border border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-800/70 text-slate-800 dark:text-slate-100 text-sm font-semibold transition-all duration-300 hover:bg-white dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Continue with Google
                      </button>
                    )}
                  </div>
                </>
              )}

              {/* Footer text */}
              <p className="mt-8 text-center text-xs text-slate-500 dark:text-slate-400">
                By continuing, you agree to our Terms of Service and Privacy Policy
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Custom CSS animations */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-5px); }
          75% { transform: translateX(5px); }
        }
        .animate-shake {
          animation: shake 0.4s ease-in-out;
        }
      `}</style>
    </div>
  );
};

export default LoginPage;
