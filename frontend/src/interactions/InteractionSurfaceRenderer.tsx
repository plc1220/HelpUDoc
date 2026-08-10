import { useMemo, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { List, ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import type {
  InteractionRequest,
  InteractionResponse,
  InterruptAction,
} from '@helpudoc/contracts/types';
import { buildApiUrl } from '../services/apiClient';

type Choice = {
  id?: string;
  label?: string;
  description?: string;
  value?: string;
};

type Question = {
  id?: string;
  header?: string;
  question?: string;
  options?: Choice[];
  placeholder?: string;
};

type StylePreview = Choice & {
  choiceId?: string;
  name?: string;
  title?: string;
  path?: string;
  file?: string;
  filePath?: string;
  previewPath?: string;
  html?: string;
  srcDoc?: string;
  content?: string;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const asChoices = (value: unknown): Choice[] => (
  Array.isArray(value)
    ? value.filter((item): item is Choice => Boolean(item && typeof item === 'object'))
    : []
);

const choiceId = (choice: Choice, index: number) => (
  String(choice.id || choice.value || choice.label || `choice-${index}`)
);

const choiceLabel = (choice: Choice, index: number) => (
  String(choice.label || choice.value || choice.id || `Option ${index + 1}`)
);

const normalizeKey = (value: unknown) => (
  String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
);

const workspacePreviewUrl = (workspaceId: string | undefined, sourcePath: string) => {
  if (!workspaceId || !sourcePath.trim()) return undefined;
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/preview/raw`);
  url.searchParams.set('path', sourcePath.trim());
  url.searchParams.set('disposition', 'inline');
  return url.toString();
};

const decisionForAction = (actionId: string): InteractionResponse['decision'] => {
  const normalized = actionId.toLowerCase();
  if (normalized.includes('approve')) return 'approve';
  if (normalized.includes('reject')) return 'reject';
  if (normalized.includes('edit') || normalized.includes('revise')) return 'edit';
  if (normalized.includes('cancel')) return 'cancel';
  return 'submit';
};

export function InteractionSurfaceRenderer({
  request,
  onSubmit,
  workspaceId,
}: {
  request: InteractionRequest;
  onSubmit: (response: InteractionResponse) => Promise<void>;
  workspaceId?: string;
}) {
  const props = asRecord(request.props);
  const title = String(props.title || 'Your input is needed');
  const description = String(props.description || '');
  const questions = useMemo<Question[]>(
    () => Array.isArray(props.questions)
      ? props.questions.filter((item): item is Question => Boolean(item && typeof item === 'object'))
      : [],
    [props.questions],
  );
  const choices = useMemo(
    () => asChoices(props.choices),
    [props.choices],
  );
  const previews = useMemo<StylePreview[]>(
    () => Array.isArray(props.previews)
      ? props.previews.filter((item): item is StylePreview => Boolean(item && typeof item === 'object'))
      : [],
    [props.previews],
  );
  const styleChoices = useMemo<Choice[]>(
    () => choices.length
      ? choices
      : previews.map((preview, index) => ({
          id: String(preview.id || preview.choiceId || preview.value || `style-${index + 1}`),
          label: String(preview.label || preview.name || preview.title || `Style ${index + 1}`),
          value: String(preview.value || preview.id || preview.choiceId || `style-${index + 1}`),
          description: preview.description,
        })),
    [choices, previews],
  );
  const actions = useMemo<InterruptAction[]>(
    () => Array.isArray(props.actions)
      ? props.actions.filter((item): item is InterruptAction => Boolean(
          item && typeof item === 'object' && 'id' in item && 'label' in item,
        ))
      : [],
    [props.actions],
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const inputMode = String(props.inputMode || '').toLowerCase();
  const hasStructuredQuestions = questions.length > 0;
  const showFallbackChoices = request.presentation === 'questionnaire'
    && !hasStructuredQuestions
    && choices.length > 0;
  const showFallbackText = request.presentation === 'questionnaire'
    && !hasStructuredQuestions
    && (inputMode !== 'choice' || choices.length === 0);

  const submit = async (response: Omit<InteractionResponse, 'interactionId'>) => {
    setIsSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({ interactionId: request.interactionId, ...response });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit your response.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderChoiceList = (items: Choice[], questionId?: string) => {
    const selected = questionId ? answers[questionId] : selectedChoiceId;
    return (
      <List>
        {items.map((choice, index) => {
          const id = choiceId(choice, index);
          const value = String(choice.value || id);
          const isSelected = selected === value || selected === id;
          return (
            <ListItem
              key={id}
              label={choiceLabel(choice, index)}
              description={choice.description}
              startContent={(
                <Badge
                  variant={isSelected ? 'info' : 'neutral'}
                  label={String.fromCharCode(65 + index)}
                />
              )}
              isSelected={isSelected}
              isDisabled={isSubmitting}
              onClick={() => {
                if (questionId) {
                  setAnswers((current) => ({ ...current, [questionId]: value }));
                } else {
                  setSelectedChoiceId(id);
                }
              }}
            />
          );
        })}
      </List>
    );
  };

  const defaultActions: InterruptAction[] = request.presentation === 'plan_review'
    ? [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'edit', label: 'Request changes', style: 'secondary', inputMode: 'text' },
        { id: 'reject', label: 'Reject', style: 'danger', inputMode: 'text' },
      ]
    : [];
  const reviewActions = actions.length ? actions : defaultActions;
  const planSummary = String(props.summaryMarkdown || props.summary || '').trim();
  const planChecklist = String(props.checklist || '').trim();
  const planFilePath = String(props.planFilePath || props.filePath || '').trim();
  const riskyActions = String(props.riskyActions || '').trim();
  const planSteps = Array.isArray(props.steps) ? props.steps : [];
  const hasRisk = Boolean(riskyActions && riskyActions.toLowerCase() !== 'none');

  const renderStylePreviews = () => (
    <Stack direction="vertical" gap={3} width="100%">
      {styleChoices.map((choice, index) => {
        const id = choiceId(choice, index);
        const keys = [
          normalizeKey(id),
          normalizeKey(choice.value),
          normalizeKey(choice.label),
        ].filter(Boolean);
        const preview = previews.find((item) => {
          const previewKeys = [
            item.id,
            item.choiceId,
            item.value,
            item.label,
            item.name,
            item.title,
          ].map(normalizeKey).filter(Boolean);
          return keys.some((key) => previewKeys.includes(key));
        }) || previews[index];
        const sourcePath = String(
          preview?.path || preview?.file || preview?.filePath || preview?.previewPath || '',
        ).trim();
        const previewUrl = sourcePath ? workspacePreviewUrl(workspaceId, sourcePath) : undefined;
        const html = previewUrl
          ? ''
          : String(preview?.html || preview?.srcDoc || preview?.content || '').trim();
        const isSelected = selectedChoiceId === id;
        return (
          <Stack key={id} direction="vertical" gap={2} width="100%">
            {html || previewUrl ? (
              <div
                style={{
                  overflow: 'hidden',
                  border: `2px solid ${isSelected ? 'var(--color-border-blue)' : 'var(--color-border)'}`,
                  borderRadius: 12,
                  background: 'white',
                }}
              >
                <iframe
                  title={`${choiceLabel(choice, index)} preview`}
                  src={html ? undefined : previewUrl}
                  srcDoc={html || undefined}
                  sandbox=""
                  style={{ display: 'block', width: '100%', height: 240, border: 0 }}
                />
              </div>
            ) : null}
            {renderChoiceList([choice])}
          </Stack>
        );
      })}
    </Stack>
  );

  return (
    <Card width="100%" padding={4}>
      <Stack direction="vertical" gap={3} width="100%">
        <Stack direction="vertical" gap={1}>
          <Text type="large" weight="bold" as="h3">{title}</Text>
          {description ? <Text type="supporting" color="secondary">{description}</Text> : null}
        </Stack>

        {request.presentation === 'questionnaire'
          ? questions.map((question, index) => {
              const id = String(question.id || `question-${index}`);
              const options = asChoices(question.options);
              return (
                <Stack key={id} direction="vertical" gap={2}>
                  <Text weight="bold">{String(question.question || question.header || `Question ${index + 1}`)}</Text>
                  {options.length
                    ? renderChoiceList(options, id)
                    : (
                      <TextArea
                        label={String(question.header || `Answer ${index + 1}`)}
                        isLabelHidden
                        value={answers[id] || ''}
                        placeholder={question.placeholder || 'Type your answer…'}
                        isDisabled={isSubmitting}
                        onChange={(value) => setAnswers((current) => ({ ...current, [id]: value }))}
                        width="100%"
                      />
                    )}
                </Stack>
              );
            })
          : null}

        {showFallbackChoices ? renderChoiceList(choices) : null}

        {showFallbackText ? (
          <TextArea
            label={String(props.label || 'Response')}
            isLabelHidden
            value={message}
            placeholder={String(props.placeholder || 'Type your response…')}
            isDisabled={isSubmitting}
            onChange={setMessage}
            width="100%"
          />
        ) : null}

        {request.presentation === 'style_preview' ? renderStylePreviews() : null}

        {request.presentation === 'plan_review' ? (
          <Stack direction="vertical" gap={2} width="100%">
            {planFilePath ? (
              <Text type="supporting" color="secondary">Plan file: {planFilePath}</Text>
            ) : null}
            {planSummary ? (
              <div style={{ whiteSpace: 'pre-wrap' }}>
                <Text>{planSummary}</Text>
              </div>
            ) : null}
            {planChecklist ? (
              <Stack direction="vertical" gap={1}>
                <Text weight="bold">Checklist</Text>
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  <Text type="supporting">{planChecklist}</Text>
                </div>
              </Stack>
            ) : null}
            {planSteps.length ? (
              <Stack direction="vertical" gap={1}>
                <Text weight="bold">Steps</Text>
                <List>
                  {planSteps.map((step, index) => {
                    const record = asRecord(step);
                    const label = typeof step === 'string'
                      ? step
                      : String(record.title || record.label || record.description || `Step ${index + 1}`);
                    const detail = typeof step === 'string'
                      ? undefined
                      : String(record.detail || record.description || '');
                    return (
                      <ListItem
                        key={`${label}-${index}`}
                        label={label}
                        description={detail || undefined}
                        startContent={<Badge variant="neutral" label={String(index + 1)} />}
                      />
                    );
                  })}
                </List>
              </Stack>
            ) : null}
            {hasRisk ? (
              <Stack direction="vertical" gap={1}>
                <Text weight="bold" style={{ color: 'var(--color-text-error)' }}>Risk notes</Text>
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  <Text type="supporting">{riskyActions}</Text>
                </div>
              </Stack>
            ) : null}
          </Stack>
        ) : null}

        {(request.presentation === 'action_review' || request.presentation === 'plan_review') && message !== undefined
          ? (
            <TextArea
              label="Notes"
              isOptional
              value={message}
              placeholder="Add context or requested changes…"
              isDisabled={isSubmitting}
              onChange={setMessage}
              width="100%"
            />
          )
          : null}

        {error ? <Text color="secondary" style={{ color: 'var(--color-text-error)' }}>{error}</Text> : null}

        <Stack direction="horizontal" gap={2} justify="end" width="100%" wrap="wrap">
          {request.presentation === 'questionnaire' ? (
            <Button
              label={String(props.submitLabel || 'Continue')}
              variant="primary"
              isLoading={isSubmitting}
              isDisabled={isSubmitting || (
                hasStructuredQuestions
                  ? questions.some((question, index) => {
                      const id = String(question.id || `question-${index}`);
                      return !String(answers[id] || '').trim();
                    })
                  : inputMode === 'choice'
                    ? !selectedChoiceId
                    : inputMode === 'text_or_choice'
                      ? !selectedChoiceId && !message.trim()
                      : choices.length
                        ? !selectedChoiceId && !message.trim()
                        : !message.trim()
              )}
              clickAction={() => submit({
                actionId: request.resumeAction?.actionId || 'submit',
                values: {
                  answers,
                  ...(selectedChoiceId ? { selectedChoiceId } : {}),
                  ...(message.trim() ? { response: message.trim() } : {}),
                },
                decision: 'submit',
              })}
            />
          ) : null}

          {request.presentation === 'style_preview' ? (
            <Button
              label={String(props.submitLabel || 'Use selected style')}
              variant="primary"
              isLoading={isSubmitting}
              isDisabled={isSubmitting || !selectedChoiceId}
              clickAction={() => submit({
                actionId: request.resumeAction?.actionId || 'submit',
                values: { selectedChoiceId },
                decision: 'submit',
              })}
            />
          ) : null}

          {(request.presentation === 'action_review' || request.presentation === 'plan_review')
            ? reviewActions.map((action) => (
              <Button
                key={action.id}
                label={action.label}
                variant={action.style === 'danger' ? 'destructive' : action.style === 'primary' ? 'primary' : 'secondary'}
                isLoading={isSubmitting}
                isDisabled={isSubmitting}
                clickAction={() => submit({
                  actionId: action.id,
                  decision: decisionForAction(action.id),
                  message: message.trim() || undefined,
                  values: action.payload,
                })}
              />
            ))
            : null}
        </Stack>
      </Stack>
    </Card>
  );
}
