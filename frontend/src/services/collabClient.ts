import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { getAuthUser } from '../auth/authStore';

export const COLLAB_URL = import.meta.env.VITE_COLLAB_URL || 'ws://localhost:1234';

export type CollabSession = {
  doc: Y.Doc;
  yText: Y.Text;
  provider: HocuspocusProvider;
};

export const createCollabSession = (workspaceId: string, fileId: string): CollabSession => {
  const doc = new Y.Doc();
  const yText = doc.getText('content');
  const user = getAuthUser();
  const url = new URL(COLLAB_URL);
  url.searchParams.set('workspaceId', workspaceId);
  url.searchParams.set('fileId', fileId);
  url.searchParams.set('userId', user?.id ?? 'local-user');
  url.searchParams.set('userName', user?.name ?? 'Local User');
  if (user?.email) {
    url.searchParams.set('userEmail', user.email);
  }

  const provider = new HocuspocusProvider({
    url: url.toString(),
    name: `${workspaceId}:${fileId}`,
    document: doc,
  });

  return { doc, yText, provider };
};
