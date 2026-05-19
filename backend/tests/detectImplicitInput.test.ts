import assert from 'node:assert/strict';
import test from 'node:test';
import { detectImplicitInputAwaiting } from '../src/services/agentRunService';

test('returns awaiting=false when status is not completed', () => {
  const result = detectImplicitInputAwaiting({
    status: 'failed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'Please confirm your selection?',
  });
  assert.equal(result.awaiting, false);
});

test('returns awaiting=false when no skill is active', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: null,
    hadInterrupt: false,
    assistantText: 'Would you like to proceed?',
  });
  assert.equal(result.awaiting, false);
});

test('returns awaiting=false when an interrupt was already emitted', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: true,
    assistantText: 'Please confirm your selection from the form above?',
  });
  assert.equal(result.awaiting, false);
});

test('returns awaiting=false when assistant text has no input-seeking signals', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'I have generated your presentation. The file is saved at output/slides.html.',
  });
  assert.equal(result.awaiting, false);
});

test('returns awaiting=true when assistant ends with question and has confirmation language', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'Here is the outline I created:\n\n1. Introduction\n2. Main points\n3. Conclusion\n\nWould you like to confirm this outline?',
  });
  assert.equal(result.awaiting, true);
  assert.ok(result.prompt?.includes('confirm'));
});

test('returns awaiting=true when assistant references phantom UI and has enumerated choices', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'Please select your preferred mood from the options above:\n- Bold/Confident\n- Warm/Friendly\n- Inspired/Moved\n\nPick one or two options.',
  });
  assert.equal(result.awaiting, true);
});

test('returns awaiting=true when assistant references sidebar forms and numbered next steps', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: `The project is ready to move into the visual design phase.

### Next Steps
Please use the **forms in the sidebar** (or below) to:
1. **Confirm the outline** and image placement.
2. **Choose your style discovery method** (I recommend generating 3 custom previews).
3. **Define the mood** for a professional legal pitch.`,
  });
  assert.equal(result.awaiting, true);
  assert.ok(result.prompt?.includes('forms in the sidebar'));
});

test('returns awaiting=true when agent asks "which" and lists options', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'I have three styles ready:\n- Minimal Dark\n- Gradient Wave\n- Classic Paper\n\nWhich style would you prefer?',
  });
  assert.equal(result.awaiting, true);
  assert.ok(result.prompt?.includes('Which style'));
});

test('extracts the trailing question as prompt', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'The outline looks great.\n\n- Option A\n- Option B\n- Option C\n\nShall I proceed with Option A?',
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.prompt, 'Shall I proceed with Option A?');
});

test('returns awaiting=false with only one signal (question only, no choices)', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'Done. Anything else?',
  });
  assert.equal(result.awaiting, false);
});
