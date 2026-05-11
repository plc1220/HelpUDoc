// PR 10 (frontend-workspace-split): canonical location is now
// `frontend/src/features/chat/types.ts`.
// This shim preserves the legacy import path during the rename.
export type { ChatComposerAttachment } from '../../features/chat/types';
