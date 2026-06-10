import React, { useLayoutEffect } from 'react';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { useA2UIRuntime } from './useA2UIRuntime';
import {
  type A2UIComponentProps,
  ClarificationForm,
  StylePreviewChooser,
  ApprovalCard,
  PlanReview,
} from './catalog';
import type { A2UIRequest, A2UIResponse } from '@helpudoc/contracts/types';

type DirectSubmitPayload = Parameters<A2UIComponentProps['onSubmit']>[0];

const DIRECT_COMPONENTS: Record<string, React.FC<A2UIComponentProps>> = {
  'clarification.form': ClarificationForm,
  clarification_form: ClarificationForm,
  'style.previewChooser': StylePreviewChooser,
  style_preview_chooser: StylePreviewChooser,
  'approval.card': ApprovalCard,
  approval: ApprovalCard,
  'plan.review': PlanReview,
};

export const A2UISurfaceRenderer: React.FC<{
  request: A2UIRequest;
  onSubmit: (response: A2UIResponse) => Promise<void>;
  workspaceId?: string;
}> = ({ request, onSubmit, workspaceId }) => {
  const { loadRequest, surfaceModel, error } = useA2UIRuntime({ onSubmit, workspaceId });

  useLayoutEffect(() => {
    loadRequest(request);
  }, [loadRequest, request]);

  if (!surfaceModel && error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-700">
        {error}
      </div>
    );
  }

  if (!surfaceModel) {
    const DirectComponent = DIRECT_COMPONENTS[request.component];
    if (DirectComponent) {
      return (
        <DirectComponent
          props={{ ...(request.props || {}), workspaceId }}
          onSubmit={(payload: DirectSubmitPayload) => onSubmit({
            surfaceId: request.surfaceId,
            actionId: payload?.actionId || request.resumeAction?.actionId || 'submit',
            values: payload?.values,
            decision: payload?.decision,
            message: payload?.message,
            metadata: payload?.metadata,
          })}
          workspaceId={workspaceId}
        />
      );
    }
    return <div className="p-4 text-center text-slate-500">Initializing...</div>;
  }

  return (
    <div className="a2ui-surface-wrapper">
      <A2uiSurface surface={surfaceModel} />
    </div>
  );
};
