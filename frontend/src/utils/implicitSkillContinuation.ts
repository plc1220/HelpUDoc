import type { ConversationMessage, ConversationMessageMetadata } from '../types';

/**
 * Determines whether the most recent agent message is implicitly awaiting user input
 * (skill ran, asked a question in prose, but failed to emit a formal interrupt).
 */
export const getImplicitContinuationContext = (
  messages: ConversationMessage[],
): { shouldContinue: true; skillId: string; prompt: string } | { shouldContinue: false } => {
  const lastAgentMessage = findLastAgentMessage(messages);
  if (!lastAgentMessage) {
    return { shouldContinue: false };
  }

  const metadata = lastAgentMessage.metadata as ConversationMessageMetadata | null | undefined;
  if (!metadata?.awaitingImplicitInput) {
    return { shouldContinue: false };
  }

  const skillId = metadata.runPolicy?.skill;
  if (!skillId) {
    return { shouldContinue: false };
  }

  const prompt = metadata.implicitInputPrompt || '';
  return { shouldContinue: true, skillId, prompt };
};

/**
 * Wraps the raw user reply with a continuation directive that instructs the agent
 * to continue the stalled skill flow instead of starting fresh.
 * Includes a /skill directive so the agent loads the skill without re-discovering it.
 */
export const buildContinuationPrompt = (
  userReply: string,
  skillId: string,
  implicitPrompt: string,
): string => {
  const parts = [
    `/skill ${skillId}`,
    '',
    `[CONTINUATION] The previous agent turn (skill: ${skillId}) asked for user input but did not emit a structured interrupt.`,
    `The user has now replied. Continue the "${skillId}" skill flow from where it left off.`,
    implicitPrompt ? `Agent's pending question: "${implicitPrompt}"` : '',
    `User's answer: "${userReply}"`,
    '',
    'Do NOT restart the skill from the beginning. Do NOT re-ask questions the user already answered. Pick up from the next logical step using the answer above.',
  ];
  return parts.filter(Boolean).join('\n');
};

/**
 * The newest real agent turn.
 *
 * Messages with no metadata are stepped over. `addLocalSystemMessage` posts a
 * notice as `sender: 'agent'` carrying none, and one landing between the
 * question and the user's reply used to make `awaitingImplicitInput` read
 * undefined. The reply then went as a plain prompt with no `[CONTINUATION]`
 * block and no `/skill`, so the agent restarted the skill and asked its opening
 * question again — the cycle the user sees.
 *
 * Same rule as `isAwaitingUserInput` in `utils/messages`, deliberately: two
 * copies of "which message is the current turn" that disagree is how this
 * started.
 */
const findLastAgentMessage = (messages: ConversationMessage[]): ConversationMessage | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender === 'agent' && messages[i].metadata) {
      return messages[i];
    }
  }
  return undefined;
};
