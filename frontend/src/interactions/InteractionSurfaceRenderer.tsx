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

        {request.presentation === 'style_preview' ? renderChoiceList(choices) : null}

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
              isDisabled={isSubmitting || questions.some((question, index) => {
                const id = String(question.id || `question-${index}`);
                return !String(answers[id] || '').trim();
              })}
              clickAction={() => submit({
                actionId: request.resumeAction?.actionId || 'submit',
                values: { answers },
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
