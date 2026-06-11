import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Catalog, MessageProcessor, type ActionListener, type SurfaceModel } from '@a2ui/web_core/v0_9';
import {
  basicCatalog,
  createBinderlessComponentImplementation,
  type ReactComponentImplementation,
} from '@a2ui/react/v0_9';
import { z } from 'zod';
import {
  type A2UIComponentProps,
  ClarificationForm,
  StylePreviewChooser,
  ApprovalCard,
  PlanReview,
} from './catalog';
import type { A2UIRequest, A2UIResponse } from '@helpudoc/contracts/types';

type A2UIComponentSubmitPayload = Parameters<A2UIComponentProps['onSubmit']>[0];

const getErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error ? error.message : fallback;
};

const getPropsSignature = (properties: Record<string, unknown>) => {
  try {
    return JSON.stringify(properties);
  } catch {
    return undefined;
  }
};

const areNormalizedPropsEqual = (
  currentProps: Record<string, unknown>,
  nextProps: Record<string, unknown>,
) => {
  const currentSignature = getPropsSignature(currentProps);
  return currentSignature !== undefined && currentSignature === getPropsSignature(nextProps);
};

const createCustomImplementation = (name: string, Component: React.FC<A2UIComponentProps>) => {
  return createBinderlessComponentImplementation(
    { name, schema: z.object({}).passthrough() },
    ({ context }) => {
      const normalizeProps = (properties: Record<string, unknown>) => {
        const nested = properties?.props;
        return nested && typeof nested === 'object' && !Array.isArray(nested)
          ? { ...nested, ...properties }
          : properties;
      };
      const [props, setProps] = useState(() => normalizeProps(context.componentModel.properties));

      useEffect(() => {
        const unsub = context.componentModel.onUpdated.subscribe((model) => {
          setProps((currentProps) => {
            const nextProps = normalizeProps({ ...model.properties });
            return areNormalizedPropsEqual(currentProps, nextProps) ? currentProps : nextProps;
          });
        });
        return () => unsub.unsubscribe();
      }, [context.componentModel]);

      const onSubmit = (payload: A2UIComponentSubmitPayload) => {
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
          isSubmitting={Boolean(props.isSubmitting)}
          error={typeof props.error === 'string' ? props.error : undefined}
          workspaceId={typeof props.workspaceId === 'string' ? props.workspaceId : undefined}
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
  const lastSyncedRuntimePropsRef = useRef<string | null>(null);

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
    const handleAction: ActionListener = async (action) => {
      const surfaceId = activeSurfaceIdRef.current;
      if (!surfaceId) return;
      setIsSubmitting(true);
      setError(undefined);
      const payload = (action.context || {}) as Partial<A2UIComponentSubmitPayload>;
      try {
        await onSubmit({
          surfaceId,
          actionId: payload.actionId || 'submit',
          values: payload.values,
          decision: payload.decision,
          message: payload.message,
          metadata: payload.metadata,
        });
      } catch (err: unknown) {
        setError(getErrorMessage(err, 'Failed to submit response'));
      } finally {
        setIsSubmitting(false);
      }
    };

    return new MessageProcessor([customCatalog, basicCatalog], handleAction);
  }, [customCatalog, onSubmit]);

  const [surfaceModel, setSurfaceModel] = useState<SurfaceModel<ReactComponentImplementation> | null>(null);

  const loadRequest = useCallback((request: A2UIRequest) => {
    const surfaceId = request.surfaceId;
    if (!surfaceId) {
      setSurfaceModel((current) => current === null ? current : null);
      setError('A2UI request is missing a surface id.');
      lastSyncedRuntimePropsRef.current = null;
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
      setActiveSurfaceId((current) => current === surfaceId ? current : surfaceId);
      setSurfaceModel((current) => current === existingSurface ? current : existingSurface);
      return;
    }

    activeSurfaceIdRef.current = surfaceId;
    setActiveSurfaceId((current) => current === surfaceId ? current : surfaceId);
    setError(undefined);
    lastSyncedRuntimePropsRef.current = null;

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
        setSurfaceModel((current) => current === null ? current : null);
        setError(`A2UI surface "${surfaceId}" was not created.`);
        lastSyncedRuntimePropsRef.current = null;
        return;
      }
      setSurfaceModel((current) => current === nextSurface ? current : nextSurface);
      lastRequestSignatureRef.current = requestSignature;
    } catch (err: unknown) {
      console.error('Failed to process request', err);
      setError(getErrorMessage(err, 'Error processing UI request'));
      lastSyncedRuntimePropsRef.current = null;
    }
  }, [processor]);

  // Sync stateful values down to component props when they change
  useEffect(() => {
    if (activeSurfaceId && surfaceModel) {
      const surface = processor.model.getSurface(activeSurfaceId);
      if (!surface) {
        setSurfaceModel((current) => current === null ? current : null);
        lastSyncedRuntimePropsRef.current = null;
        return;
      }
      const rootComp = surfaceModel.componentsModel.get('root');
      if (rootComp) {
        const runtimePropsSignature = JSON.stringify({
          surfaceId: activeSurfaceId,
          isSubmitting,
          error: error ?? null,
          workspaceId: workspaceId ?? null,
        });
        if (lastSyncedRuntimePropsRef.current === runtimePropsSignature) {
          return;
        }
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
        lastSyncedRuntimePropsRef.current = runtimePropsSignature;
      }
    }
  }, [activeSurfaceId, surfaceModel, isSubmitting, error, workspaceId, processor]);

  return {
    loadRequest,
    surfaceModel,
    isSubmitting,
    error,
    setError,
  };
};
