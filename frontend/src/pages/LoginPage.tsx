import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sun, Moon, Mail, Lock, ArrowRight } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

interface LocationState {
  from?: string;
}

type PaletteMode = 'light' | 'dark';

const IS_DEV = import.meta.env.DEV;

const LoginPage = () => {
  const { user, loading, googleReady, googleError, signInWithEmail } = useAuth();
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorMode);
    document.documentElement.classList.toggle('dark', colorMode === 'dark');
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('helpudoc-color-mode', colorMode);
    }
  }, [colorMode]);

  useEffect(() => {
    if (user) {
      const state = location.state as LocationState | null;
      const redirectTo = state?.from || '/';
      navigate(redirectTo, { replace: true });
    }
  }, [location.state, navigate, user]);

  const handleEmailLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmail(email, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to sign in.';
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
      const message = err instanceof Error ? err.message : 'Bypass failed.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const heroImage = useMemo(() => (colorMode === 'light' ? '/Day.png' : '/Night.png'), [colorMode]);
  const googleTheme = colorMode === 'dark' ? 'filled_black' : 'outline';

  useEffect(() => {
    if (!googleReady || !googleButtonRef.current || !window.google?.accounts?.id) return;

    googleButtonRef.current.innerHTML = '';
    const width = Math.min(360, googleButtonRef.current.offsetWidth || 340);
    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: googleTheme,
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      width,
    });
  }, [googleReady, googleTheme]);

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

              {/* Login form */}
              <form onSubmit={handleEmailLogin} className="space-y-5">
                {/* Email field */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-2" htmlFor="email">
                    <Mail size={14} className="text-blue-600 dark:text-blue-400" />
                    Email address
                  </label>
                  <div className={`relative transition-all duration-300 ${focusedField === 'email' ? 'scale-[1.02]' : ''}`}>
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onFocus={() => setFocusedField('email')}
                      onBlur={() => setFocusedField(null)}
                      placeholder="you@company.com"
                      className="w-full rounded-xl bg-slate-50 dark:bg-slate-800/50 backdrop-blur-sm border border-slate-200 dark:border-slate-600/50 px-4 py-3.5 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all duration-300"
                      required
                    />
                  </div>
                </div>

                {/* Password field */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-2" htmlFor="password">
                    <Lock size={14} className="text-blue-600 dark:text-blue-400" />
                    Password
                  </label>
                  <div className={`relative transition-all duration-300 ${focusedField === 'password' ? 'scale-[1.02]' : ''}`}>
                    <input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onFocus={() => setFocusedField('password')}
                      onBlur={() => setFocusedField(null)}
                      placeholder="Enter your password"
                      className="w-full rounded-xl bg-slate-50 dark:bg-slate-800/50 backdrop-blur-sm border border-slate-200 dark:border-slate-600/50 px-4 py-3.5 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all duration-300"
                      required
                    />
                  </div>
                </div>

                {/* Submit button - plain blue */}
                <button
                  type="submit"
                  disabled={submitting || loading}
                  className="w-full mt-6 py-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-lg shadow-blue-500/25 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 flex items-center justify-center gap-2"
                >
                  {submitting ? (
                    <>
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Signing in...
                    </>
                  ) : (
                    <>
                      Continue
                      <ArrowRight size={18} />
                    </>
                  )}
                </button>
              </form>

              {/* Divider */}
              <div className="my-6 flex items-center gap-4">
                <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" />
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" />
              </div>

              {/* Google button */}
              <div className="relative">
                {googleError ? (
                  <div className="text-center text-xs text-red-600 dark:text-red-400 p-3 rounded-xl bg-red-100/80 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                    {googleError}
                  </div>
                ) : (
                  <div ref={googleButtonRef} className="flex w-full justify-center rounded-full overflow-hidden" />
                )}
              </div>

              {/* Footer text */}
              <p className="mt-8 text-center text-xs text-slate-500 dark:text-slate-400">
                By continuing, you agree to our Terms of Service and Privacy Policy
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Dev bypass button */}
      {IS_DEV && (
        <button
          type="button"
          onClick={handleBypassLogin}
          className="fixed bottom-6 left-6 z-50 px-4 py-2 rounded-full bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white dark:hover:bg-slate-700 transition-all duration-300 shadow-lg"
        >
          🚀 Dev Bypass
        </button>
      )}

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
