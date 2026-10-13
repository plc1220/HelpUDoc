import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { useState } from 'react';
import type { AuthExpiredReason } from '../auth/authExpiry';

const COPY: Record<AuthExpiredReason, { title: string; body: string }> = {
  session: {
    title: 'Your session has expired',
    body: 'Please sign in again to continue. You will come back to this page.',
  },
  google: {
    title: 'Your Google sign-in has expired',
    body: 'The assistant needs your Google access to answer. Please sign in again to continue. You will come back to this page.',
  },
};

/**
 * Covers the app once the API reports that the user can no longer act.
 *
 * Before this, the page kept looking signed in while every chat failed with a
 * generic error. `purpose="required"` turns off Escape and backdrop dismissal:
 * the only way on is to sign in again.
 */
export function SessionExpiredDialog({
  reason,
  onSignIn,
}: {
  reason: AuthExpiredReason;
  onSignIn: () => void | Promise<void>;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const copy = COPY[reason];

  return (
    <Dialog isOpen onOpenChange={() => undefined} purpose="required" width={440}>
      <DialogHeader title={copy.title} />
      <VStack gap={3} padding={3}>
        <Text>{copy.body}</Text>
        <Button
          label="Sign in again"
          variant="primary"
          isLoading={signingIn}
          onClick={() => {
            setSigningIn(true);
            void onSignIn();
          }}
        />
      </VStack>
    </Dialog>
  );
}
