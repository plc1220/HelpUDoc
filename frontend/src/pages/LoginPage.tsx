import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { PaletteMode } from '@mui/material';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/useAuth';
import { applyColorModeToDocument, resolveInitialColorMode } from '../colorMode';

interface LocationState {
  from?: string;
}

const GoogleMark = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
    <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.74 2.98-4.31 2.98-7.4Z" />
    <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.37l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" />
    <path fill="#FBBC05" d="M6.39 13.92A6 6 0 0 1 6.08 12c0-.67.11-1.32.31-1.92V7.46H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.54l3.35-2.62Z" />
    <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.96 5.46l3.35 2.62C7.18 7.71 9.39 5.95 12 5.95Z" />
  </svg>
);

const LoginPage = () => {
  const { user, googleReady, googleError, authMode, signInWithGoogle, signInWithHeaders } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [colorMode, setColorMode] = useState<PaletteMode>(resolveInitialColorMode);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [headerName, setHeaderName] = useState('');
  const [headerEmail, setHeaderEmail] = useState('');

  useEffect(() => {
    applyColorModeToDocument(colorMode);
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
      const redirectTo = returnTo?.startsWith('/') ? returnTo : (state?.from || '/');
      navigate(redirectTo, { replace: true });
    }
  }, [location.search, location.state, navigate, user]);

  const handleGoogleLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const state = location.state as LocationState | null;
      await signInWithGoogle(state?.from || '/');
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Unable to start Google sign-in.');
      setSubmitting(false);
    }
  };

  const handleHeaderLogin = async () => {
    const trimmedName = headerName.trim();
    if (!trimmedName) {
      setError('Enter a display name to continue in development mode.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signInWithHeaders({
        name: trimmedName,
        email: headerEmail.trim() || null,
      });
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Unable to start development sign-in.');
      setSubmitting(false);
    }
  };

  return (
    <main className="lumo-login-page">
      <div className="lumo-login-glow" aria-hidden="true" />
      <div className="lumo-login-theme-toggle">
        <IconButton
          label={colorMode === 'light' ? 'Use dark appearance' : 'Use light appearance'}
          tooltip={colorMode === 'light' ? 'Use dark appearance' : 'Use light appearance'}
          variant="ghost"
          size="md"
          icon={<Icon icon={colorMode === 'light' ? Moon : Sun} size="sm" />}
          onClick={() => setColorMode((current) => (current === 'light' ? 'dark' : 'light'))}
        />
      </div>

      <section className="lumo-login-intro" aria-labelledby="lumo-login-heading">
        <div className="lumo-login-brand">
          <img src="/lumo-icon-512.png" alt="" className="lumo-login-mark" />
          <span>Lumo</span>
          <span className="lumo-login-product">Studio</span>
        </div>
        <p className="lumo-login-eyebrow">Trusted knowledge, ready for work</p>
        <h1 id="lumo-login-heading">Welcome to Lumo Studio</h1>
        <p className="lumo-login-description">
          Your workspace for knowledge, memory, skills, and workflows.
        </p>
        <p className="lumo-login-promise">Lumo turns trusted knowledge into useful work.</p>
      </section>

      <Card className="lumo-login-card" width="100%" maxWidth={440} padding={8}>
        <div className="lumo-login-card-heading">
          <p className="lumo-login-card-kicker">Lumo Studio</p>
          <h2>{authMode === 'headers' ? 'Development sign-in' : 'Continue to your workspace'}</h2>
          <p>{authMode === 'headers'
            ? 'Use a local identity for this development environment.'
            : 'Sign in securely with your Google account.'}</p>
        </div>

        {error ? (
          <Banner status="error" title="Sign-in needs attention" description={error} />
        ) : null}

        {authMode === 'headers' ? (
          <div className="lumo-login-form">
            <Banner
              status="info"
              title="Development mode"
              description="This local identity seeds the configured X-User headers in this browser."
            />
            <TextInput
              label="Display name"
              value={headerName}
              onChange={setHeaderName}
              placeholder="Your name"
              width="100%"
              isRequired
            />
            <TextInput
              label="Email"
              value={headerEmail}
              onChange={setHeaderEmail}
              placeholder="you@example.com"
              type="email"
              width="100%"
              isOptional
              onEnter={() => void handleHeaderLogin()}
            />
            <Button
              label="Continue in development mode"
              variant="primary"
              width="100%"
              isLoading={submitting}
              isDisabled={submitting}
              onClick={() => void handleHeaderLogin()}
            />
          </div>
        ) : googleError ? (
          <Banner status="error" title="Google sign-in is unavailable" description={googleError} />
        ) : (
          <Button
            label="Continue with Google"
            variant="primary"
            size="lg"
            width="100%"
            icon={<GoogleMark />}
            isLoading={submitting}
            isDisabled={!googleReady || submitting}
            onClick={() => void handleGoogleLogin()}
          />
        )}

        <p className="lumo-login-legal">
          By continuing, you agree to the Terms of Service and Privacy Policy.
        </p>
      </Card>
    </main>
  );
};

export default LoginPage;
