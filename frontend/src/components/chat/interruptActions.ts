import type { InterruptAction } from '../../types';

export type RenderableInterruptAction = InterruptAction & {
  source: 'dynamic' | 'approval' | 'clarification-choice' | 'clarification-text';
  description?: string;
  legacyDecision?: 'approve' | 'edit' | 'reject';
  choiceId?: string;
};
