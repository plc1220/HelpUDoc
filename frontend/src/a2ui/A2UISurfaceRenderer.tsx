import React, { useEffect } from 'react';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { useA2UIRuntime } from './useA2UIRuntime';
import type { A2UIRequest, A2UIResponse } from '@helpudoc/contracts/types';

export const A2UISurfaceRenderer: React.FC<{
  request: A2UIRequest;
  onSubmit: (response: A2UIResponse) => Promise<void>;
  workspaceId?: string;
}> = ({ request, onSubmit, workspaceId }) => {
  const { loadRequest, surfaceModel } = useA2UIRuntime({ onSubmit, workspaceId });

  useEffect(() => {
    loadRequest(request);
  }, [request]);

  if (!surfaceModel) {
    return <div className="p-4 text-center text-slate-500">Initializing...</div>;
  }

  return (
    <div className="a2ui-surface-wrapper">
      <A2uiSurface surface={surfaceModel} />
    </div>
  );
};
