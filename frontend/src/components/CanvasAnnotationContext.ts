import { createContext, useContext } from 'react';
import type { AnnotationAnchor } from '../utils/canvasAnnotations';
import type { WorkspaceCollaborationObject } from '../services/workspaceCollaborationApi';

export type CanvasAnnotationState = {
  active: boolean;
  annotations: WorkspaceCollaborationObject[];
  select: (anchor: AnnotationAnchor) => void;
  open: (id: string) => void;
};
export const CanvasAnnotationContext = createContext<CanvasAnnotationState | null>(null);
export const useCanvasAnnotations = () => useContext(CanvasAnnotationContext);
