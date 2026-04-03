import type {
  ConversationMessage,
  InterruptAnswersByQuestionId,
  InterruptQuestion,
} from '../types';

const CLARIFICATION_DRAFT_STORAGE_PREFIX = 'helpudoc-clarification-draft';

export const buildClarificationDraftStorageKey = (
  conversationId: string,
  messageId: ConversationMessage['id'],
  interruptId?: string,
) => `${CLARIFICATION_DRAFT_STORAGE_PREFIX}:${conversationId}:${String(messageId)}:${interruptId || 'pending'}`;

export const readInterruptAnswerText = (value?: string | string[]): string => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
  }
  return String(value || '').trim();
};

export const hasStructuredClarificationAnswers = (answers?: InterruptAnswersByQuestionId): boolean =>
  Boolean(answers && Object.keys(answers).length > 0);

export const areStructuredClarificationQuestionsComplete = (
  questions: InterruptQuestion[],
  answers?: InterruptAnswersByQuestionId,
): boolean =>
  questions.every((question) => readInterruptAnswerText(answers?.[question.id]).trim().length > 0);

export const extractStructuredAnswersFromMessage = (
  value: string,
  questions: InterruptQuestion[],
): InterruptAnswersByQuestionId => {
  const answers: InterruptAnswersByQuestionId = {};
  const lines = String(value || '').split('\n');
  questions.forEach((question) => {
    const headerPrefix = `${question.header.toLowerCase()}:`;
    const idPrefix = `${question.id.toLowerCase()}:`;
    const matchingLine = lines.find((line) => {
      const normalized = line.trim().toLowerCase();
      return normalized.startsWith(headerPrefix) || normalized.startsWith(idPrefix);
    });
    if (!matchingLine) {
      return;
    }
    const separatorIndex = matchingLine.indexOf(':');
    if (separatorIndex === -1) {
      return;
    }
    const answer = matchingLine.slice(separatorIndex + 1).trim();
    if (answer) {
      answers[question.id] = answer;
    }
  });
  return answers;
};

export const buildStructuredClarificationMessage = (
  questions: InterruptQuestion[],
  answers: InterruptAnswersByQuestionId,
  notes?: string,
): string => {
  const lines = questions
    .map((question) => {
      const answer = readInterruptAnswerText(answers[question.id]);
      return answer ? `${question.header}: ${answer}` : '';
    })
    .filter(Boolean);
  const trimmedNotes = String(notes || '').trim();
  if (trimmedNotes) {
    lines.push(`Notes: ${trimmedNotes}`);
  }
  return lines.join('\n').trim();
};
