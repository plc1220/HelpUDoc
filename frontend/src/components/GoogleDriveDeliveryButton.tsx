import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { API_URL, apiFetch } from '../services/apiClient';

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export default function GoogleDriveDeliveryButton({
  workspaceId,
  fileId,
}: {
  workspaceId: string;
  fileId: number | string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [driveUrl, setDriveUrl] = useState('');

  useEffect(() => {
    let active = true;
    void apiFetch(`${API_URL}/workspaces/${workspaceId}/files/${fileId}/google-drive-delivery`)
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (active) setDriveUrl(String(payload?.delivery?.webViewLink || ''));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [workspaceId, fileId]);

  const deliver = async () => {
    setPending(true);
    setError('');
    try {
      const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/files/${fileId}/google-drive-delivery`, {
        method: 'POST',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Could not deliver this publication to Google Drive');
      setDriveUrl(String(payload?.delivery?.webViewLink || ''));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not deliver this publication to Google Drive');
    } finally {
      setPending(false);
    }
  };

  const reconnectUrl = new URL(`${API_URL}/auth/google/start`, window.location.origin);
  reconnectUrl.searchParams.set('extraScopes', DRIVE_FILE_SCOPE);
  reconnectUrl.searchParams.set('returnTo', `${window.location.pathname}${window.location.search}`);
  const needsDriveConsent = /missing required scopes|drive\.file/i.test(error);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        label={pending ? 'Copying…' : driveUrl ? 'Open in Google Drive' : 'Copy to Google Drive'}
        isDisabled={pending}
        onClick={driveUrl ? () => window.open(driveUrl, '_blank', 'noopener,noreferrer') : () => void deliver()}
      />
      {error && (
        <div className="flex items-center gap-2">
          <Text type="supporting" color="accent">{error}</Text>
          {needsDriveConsent && (
            <a className="text-sm underline" href={reconnectUrl.toString()}>Connect Drive publishing</a>
          )}
        </div>
      )}
    </div>
  );
}
