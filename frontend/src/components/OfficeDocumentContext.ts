import { createContext, useContext } from 'react';
import type { File } from '../types';

export const OfficeDocumentContext = createContext<{
  canEdit: boolean;
  onSaved: (file: File) => void;
  onAgentChat: (prompt: string) => void;
} | null>(null);
export const useOfficeDocument = () => useContext(OfficeDocumentContext);
