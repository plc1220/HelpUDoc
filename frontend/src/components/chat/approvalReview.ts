// PR 10 (frontend-workspace-split): canonical location is now
// `frontend/src/features/chat/interrupts/approvalReview.ts`.
// This shim preserves the legacy import path during the rename.
export {
  buildApprovalReview,
  buildApprovalDraftContent,
} from '../../features/chat/interrupts/approvalReview';
export type {
  PlanFileImpact,
  PlanReviewStep,
  ApprovalReviewModel,
} from '../../features/chat/interrupts/approvalReview';
