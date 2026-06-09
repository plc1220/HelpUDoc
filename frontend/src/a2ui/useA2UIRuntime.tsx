import { useState, useEffect, useMemo, useRef } from 'react';
import { Catalog, MessageProcessor } from '@a2ui/web_core/v0_9';
import { basicCatalog, createBinderlessComponentImplementation } from '@a2ui/react/v0_9';
import { z } from 'zod';
import {
  ClarificationForm,
  StylePreviewChooser,
  ApprovalCard,
  PlanReview,
} from './catalog';
import type { A2UIRequest, A2UIResponse } from '@helpudoc/contracts/types';

const createCustomImplementation = (name: string, Component: React.FC<any>) => {
  return createBinderlessComponentImplementation(
    { name, schema: z.object({}).passthrough() },
    ({ context }) => {
      const normalizeProps = (properties: Record<string, any>) => {
        const nested = properties?.props;
        return nested && typeof nested === 'object' && !Array.isArray(nested)
          ? { ...nested, ...properties }
          : properties;
      };
      const [props, setProps] = useState(() => normalizeProps(context.componentModel.properties));

      useEffect(() => {
        const unsub = context.componentModel.onUpdated.subscribe((model) => {
          setProps(normalizeProps({ ...model.properties }));
        });
        return () => unsub.unsubscribe();
      }, [context.componentModel]);

      const onSubmit = (payload: any) => {
        context.dispatchAction({
          event: {
            name: 'submit',
            context: payload,
          },
        });
      };

      return (
        <Component
          props={props}
          onSubmit={onSubmit}
          isSubmitting={props.isSubmitting}
          error={props.error}
          workspaceId={props.workspaceId}
        />
      );
    }
  );
};

export const useA2UIRuntime = ({
  onSubmit,
  workspaceId,
}: {
  onSubmit: (response: A2UIResponse) => Promise<void>;
  workspaceId?: string;
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const activeSurfaceIdRef = useRef<string | null>(null);
  const lastRequestSignatureRef = useRef<string | null>(null);

  const customCatalog = useMemo(() => {
    return new Catalog('custom', [
      createCustomImplementation('clarification.form', ClarificationForm),
      createCustomImplementation('style.previewChooser', StylePreviewChooser),
      createCustomImplementation('approval.card', ApprovalCard),
      createCustomImplementation('plan.review', PlanReview),
      createCustomImplementation('clarification_form', ClarificationForm),
      createCustomImplementation('style_preview_chooser', StylePreviewChooser),
      createCustomImplementation('approval', ApprovalCard),
    ]);
  }, []);

  const processor = useMemo(() => {
    const handleAction = async (action: any) => {
      const surfaceId = activeSurfaceIdRef.current;
      if (!surfaceId) return;
      setIsSubmitting(true);
      setError(undefined);
      const payload = action.context || {};
      try {
        await onSubmit({
          surfaceId,
          actionId: payload.actionId || 'submit',
          values: payload.values,
          decision: payload.decision,
          message: payload.message,
          metadata: payload.metadata,
        });
      } catch (err: any) {
        setError(err.message || 'Failed to submit response');
      } finally {
        setIsSubmitting(false);
      }
    };

    return new MessageProcessor([customCatalog, basicCatalog], handleAction);
  }, [customCatalog, onSubmit]);

  const [surfaceModel, setSurfaceModel] = useState<any>(null);

  const loadRequest = (request: A2UIRequest) => {
    const surfaceId = request.surfaceId;
    if (!surfaceId) {
      setSurfaceModel(null);
      setError('A2UI request is missing a surface id.');
      return;
    }
    const requestSignature = JSON.stringify({
      surfaceId: request.surfaceId,
      component: request.component,
      props: request.props,
      resumeAction: request.resumeAction,
    });
    const existingSurface = processor.model.getSurface(surfaceId);
    if (lastRequestSignatureRef.current === requestSignature && existingSurface) {
      activeSurfaceIdRef.current = surfaceId;
      setActiveSurfaceId(surfaceId);
      setSurfaceModel(existingSurface);
      return;
    }

    activeSurfaceIdRef.current = surfaceId;
    setActiveSurfaceId(surfaceId);
    setError(undefined);

    // If surface already exists, delete it first to ensure clean state
    if (processor.model.getSurface(surfaceId)) {
      processor.processMessages([
        {
          version: 'v0.9',
          deleteSurface: { surfaceId },
        },
      ]);
    }

    try {
      processor.processMessages([
        {
          version: 'v0.9',
          createSurface: {
            surfaceId,
            catalogId: 'custom',
            theme: {},
            sendDataModel: false,
          },
        },
      ]);
      processor.processMessages([
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId,
            components: [
              {
                id: 'root',
                component: request.component,
                props: request.props,
                ...request.props,
              },
            ],
          },
        },
      ]);
      const nextSurface = processor.model.getSurface(surfaceId);
      if (!nextSurface) {
        setSurfaceModel(null);
        setError(`A2UI surface "${surfaceId}" was not created.`);
        return;
      }
      setSurfaceModel(nextSurface);
      lastRequestSignatureRef.current = requestSignature;
    } catch (err: any) {
      console.error('Failed to process request', err);
      setError(err.message || 'Error processing UI request');
    }
  };

  // Sync stateful values down to component props when they change
  useEffect(() => {
    if (activeSurfaceId && surfaceModel) {
      const surface = processor.model.getSurface(activeSurfaceId);
      if (!surface) {
        setSurfaceModel(null);
        return;
      }
      const rootComp = surfaceModel.componentsModel.get('root');
      if (rootComp) {
        processor.processMessages([
          {
            version: 'v0.9',
            updateComponents: {
              surfaceId: activeSurfaceId,
              components: [
                  {
                    id: 'root',
                    props: {
                      ...surface.componentsModel.get('root')?.properties?.props,
                      isSubmitting,
                      error,
                      workspaceId,
                    },
                    isSubmitting,
                    error,
                    workspaceId,
                },
              ],
            },
          },
        ]);
      }
    }
  }, [activeSurfaceId, surfaceModel, isSubmitting, error, workspaceId]);

  return {
    loadRequest,
    surfaceModel,
    isSubmitting,
    error,
    setError,
  };
};
