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

test('infers frontend-slides when presentation form prose appears without skill metadata', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: null,
    hadInterrupt: false,
    assistantText: 'I have set up the initial presentation context form. Please fill out the form above to specify the primary purpose, desired length, style, and assets before I build the slides.',
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.skillId, 'frontend-slides');
});

test('infers frontend-slides from labeled presentation form prose even with generic skill metadata', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'research',
    hadInterrupt: false,
    assistantText: 'Please fill out the Presentation Context & Setup form above so we can proceed with planning and designing your HelpUDoc local testing presentation!',
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.skillId, 'frontend-slides');
});

test('detects frontend-slides generic form preference request', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'I have initiated the presentation creation process based on the proposal. Please fill out the form to let me know your preferences, and I will proceed with structure and design as soon as I receive your response.',
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.skillId, 'frontend-slides');
  assert.equal(result.interruptType, 'frontend_slides_context');
});

test('detects prose-only frontend-slides style selector requests', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: `I have successfully generated 3 distinctive HTML style previews.

### Sibling Style Previews
- **Style A: Swiss Modern (Minimalist)** — Clean, high-contrast, orange safety accents.
- **Style B: Bold Signal (High Impact Tech)** — Dark mode, vibrant neon teal glows.
- **Style C: Notebook Tabs (Editorial Grid)** — Clean paper interface.

Please choose your favorite direction in the interactive selector above to proceed with the complete presentation!`,
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.skillId, 'frontend-slides');
  assert.equal(result.interruptType, 'frontend_slides_style');
});

test('detects frontend-slides visual theme selection without preview wording', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: `The visual theme selection form is now active! Please choose your preferred styling direction:

*   Theme A (Bold QSR Modern - Brand Dark): Uses Texas Orange-Gold and Crimson Red on Deep Charcoal.
*   Theme B (Sleek Enterprise Tech - Data Dark): Cool Slate Navy, Teal, and Amber.
*   Theme C (Clean Minimalist Light - Editorial Light): Clean off-white and cream layout.

Once you confirm your choice, I will immediately construct the self-contained, interactive HTML slide deck!`,
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.skillId, 'frontend-slides');
  assert.equal(result.interruptType, 'frontend_slides_style');
});

test('detects frontend-slides option-numbered HTML style chooser', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: `Based on your selected configuration, I have developed three custom HTML slide style options:

### Option 1: Bold & Energetic (Texas Chicken Brand Core)
### Option 2: Sleek Enterprise Tech (Data Dark)
### Option 3: Clean Minimalist Light (Editorial Light)

Please select one for generating the complete slide deck.`,
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.interruptType, 'frontend_slides_style');
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

test('returns awaiting=false with only one signal for non-interactive skill', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'research',
    hadInterrupt: false,
    assistantText: 'Done. Anything else?',
  });
  assert.equal(result.awaiting, false);
});

test('returns awaiting=true for non-slide skill with format choices', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'research',
    hadInterrupt: false,
    assistantText: [
      'I can prepare this research brief in a few formats.',
      'Which format would you prefer?',
      '1. Executive summary',
      '2. Full report',
    ].join('\n'),
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.interruptType, 'generic');
});

test('returns awaiting=true for non-slide skill with audience choices', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'research',
    hadInterrupt: false,
    assistantText: [
      'I will use the executive summary format.',
      'Which audience should I optimize for?',
      '1. Leadership team',
      '2. Technical reviewers',
    ].join('\n'),
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.interruptType, 'generic');
});

test('returns awaiting=true for non-slide prose pausing after prompting a choice', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'generic-brief',
    hadInterrupt: false,
    assistantText: 'I have initiated Stage 1 of the research brief drafting workflow by prompting you to choose the output format (Executive Summary, Full Report, or Checklist). I am now pausing and waiting for your response.',
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.interruptType, 'generic');
});

test('returns awaiting=true for outline confirmation gate language', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'Please confirm if this outline looks correct.',
  });
  assert.equal(result.awaiting, true);
});

test('returns awaiting=false for post-deck courtesy refinements question', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'Your deck is ready. Would you like any refinements?',
  });
  assert.equal(result.awaiting, false);
});

test('detects "using the form above" as phantom UI reference', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'research',
    hadInterrupt: false,
    assistantText: '1. Title Slide\n2. Challenge\n3. Solution\n\nPlease confirm if this outline looks correct using the form above.',
  });
  assert.equal(result.awaiting, true);
});

test('detects prose asking for details using the form above', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'To ensure the slides effectively communicate the strategic vision and technical foundation of the Sales Intelligence POC, please provide a few details using the form above. Once submitted, I will generate a proposed slide outline for your review.',
  });
  assert.equal(result.awaiting, true);
});

test('detects frontend-slides context gate without explicit form wording', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: `I've analyzed the Texas Chicken Malaysia Sales Intelligence Proposal and am ready to transform it into a professional presentation. To ensure the deck meets your expectations, This will help me determine the ideal length, structure, and technical features (like inline editing). Once submitted, I will:

Propose a slide outline based on the proposal's sections (Executive Summary, Business Requirements, Architecture, etc.).

Move to Style Discovery to find the perfect visual aesthetic for your audience.`,
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.skillId, 'frontend-slides');
  assert.equal(result.interruptType, 'frontend_slides_context');
});

test('detects "fill out the form above" as phantom UI reference', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'Before I can build the slides, I need a few details about the purpose and scope of this deck. Please fill out the form above to proceed.',
  });
  assert.equal(result.awaiting, true);
});

test('detects context form below plus fill this out wording', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: "I've analyzed the Final_Proposal.md for the Texas Chicken Malaysia Sales Intelligence project. I've prepared a context form below.\n\nPlease fill this out so I can structure the slides correctly. After you submit, I'll provide a proposed slide outline for your review.",
  });
  assert.equal(result.awaiting, true);
});

test('detects numbered list beyond 800 chars when within 1500 char window', () => {
  const filler = 'A'.repeat(900);
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: `Here is the outline:\n\n1. Title Slide\n2. Challenge\n3. Solution\n4. Architecture\n5. Business Value\n6. Security\n7. Roadmap\n8. Commercials\n\n${filler}\n\nPlease confirm the outline above.`,
  });
  assert.equal(result.awaiting, true);
});

test('detects "once confirmed" / "after you confirm" patterns', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: '1. Title\n2. Body\n3. End\n\nOnce confirmed, we will move to style selection.',
  });
  assert.equal(result.awaiting, true);
});

test('detects initialized form and preferences submission without explicit above/below qualifiers', () => {
  const result = detectImplicitInputAwaiting({
    status: 'completed',
    skillId: 'frontend-slides',
    hadInterrupt: false,
    assistantText: 'I have initialized the Presentation Context + Settings form. Please submit your preferences, and once received, I will analyze the research report, structure the slides, and guide you through the outline and style selection gates!',
  });
  assert.equal(result.awaiting, true);
  assert.equal(result.skillId, 'frontend-slides');
});

// Import A2UI contract helpers from lifecycle
import {
  getFrontendSlidesA2UIGateCompletionError,
  isCompletedFrontendSlidesGateInterrupt,
  validateInterrupt,
} from '../src/services/agent-runs/lifecycle';

test('validateInterrupt passes for non-frontend-slides skill', () => {
  const parsed = { kind: 'some-other-kind' };
  const err = validateInterrupt(parsed, 'research');
  assert.equal(err, null);
});

test('validateInterrupt allows non-gate approval interrupt for frontend-slides', () => {
  const parsed = { kind: 'approval' };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.equal(err, null);
});

test('validateInterrupt fails when approval pretends to satisfy an A2UI gate', () => {
  const parsed = {
    kind: 'approval',
    displayPayload: {
      gateId: 'presentation_context',
      uiContract: 'a2ui'
    }
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /A2UI gate interrupts must use kind "clarification"/);
});

test('validateInterrupt fails unknown frontend-slides A2UI gate IDs', () => {
  const parsed = {
    kind: 'clarification',
    displayPayload: {
      gateId: 'surprise_gate',
      uiContract: 'a2ui'
    },
    uiRequest: {
      component: 'clarification_form',
      props: {
        questions: [{ id: 'q1', question: 'hello' }]
      }
    }
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /unknown frontend-slides A2UI gate/);
});

test('validateInterrupt fails when missing uiRequest', () => {
  const parsed = { kind: 'clarification' };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /missing "uiRequest" in clarification/);
});

test('validateInterrupt fails when missing component in uiRequest', () => {
  const parsed = {
    kind: 'clarification',
    uiRequest: {}
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /missing "component" in "uiRequest"/);
});

test('validateInterrupt fails when expectedComponent does not match', () => {
  const parsed = {
    kind: 'clarification',
    uiRequest: {
      component: 'some_other_component',
      props: {}
    },
    displayPayload: {
      gateId: 'presentation_context'
    }
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /expected component "clarification_form"/);
});

test('validateInterrupt fails when clarification_form props.questions is empty', () => {
  const parsed = {
    kind: 'clarification',
    uiRequest: {
      component: 'clarification_form',
      props: {
        questions: []
      }
    },
    displayPayload: {
      gateId: 'presentation_context'
    }
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /clarification_form props.questions must be a non-empty array/);
});

test('validateInterrupt fails when outline_confirmation has no outline material', () => {
  const parsed = {
    kind: 'clarification',
    uiRequest: {
      component: 'clarification_form',
      props: {
        questions: [{ id: 'outline_decision', question: 'Does this outline look right?' }],
      },
    },
    displayPayload: {
      gateId: 'outline_confirmation',
    },
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /outline_confirmation requires real outline review material/);
});

test('validateInterrupt fails when style_preview_chooser props.choices and previews are empty', () => {
  const parsed = {
    kind: 'clarification',
    uiRequest: {
      component: 'style_preview_chooser',
      props: {
        previews: [],
        choices: []
      }
    },
    displayPayload: {
      gateId: 'style_preview_selection'
    }
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.match(err || '', /style_preview_chooser props.previews or props.choices must be a non-empty array/);
});

test('validateInterrupt passes with valid parameters', () => {
  const parsed = {
    kind: 'clarification',
    uiRequest: {
      component: 'clarification_form',
      props: {
        questions: [{ id: 'q1', question: 'hello' }]
      }
    },
    displayPayload: {
      gateId: 'presentation_context'
    }
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.equal(err, null);
});

test('validateInterrupt projects native A2UI requests without legacy uiRequest', () => {
  const parsed = {
    type: 'interrupt',
    kind: 'clarification',
    a2uiRequest: {
      contract: 'a2ui',
      version: '0.9',
      surfaceId: 'surface-presentation_context',
      component: 'clarification.form',
      gateId: 'presentation_context',
      skill: 'frontend-slides',
      props: {
        questions: [{ id: 'purpose', header: 'Purpose', question: 'What is this presentation for?' }],
      },
      resumeAction: {
        endpoint: 'respond',
        actionId: 'submit',
      },
      metadata: {
        skill: 'frontend-slides',
        gateId: 'presentation_context',
        uiContract: 'a2ui',
        expectedComponent: 'clarification_form',
      },
    },
  };
  const err = validateInterrupt(parsed, 'frontend-slides');
  assert.equal(err, null);
});

test('completed frontend-slides gates are skippable before duplicate clarification guard', () => {
  const parsed = {
    type: 'interrupt',
    kind: 'clarification',
    title: 'Presentation Context + Images',
    displayPayload: {
      skill: 'frontend-slides',
      gateId: 'presentation_context',
      uiContract: 'a2ui',
      expectedComponent: 'clarification_form',
    },
    a2uiRequest: {
      contract: 'a2ui',
      component: 'clarification_form',
      gateId: 'presentation_context',
      skill: 'frontend-slides',
      props: {
        questions: [{ id: 'purpose', question: 'What is this presentation for?' }],
      },
    },
  };

  assert.equal(
    isCompletedFrontendSlidesGateInterrupt(parsed, {
      completedGateIds: ['presentation_context'],
    }),
    true,
  );
  assert.equal(
    isCompletedFrontendSlidesGateInterrupt(parsed, {
      completedGateIds: [],
    }),
    false,
  );
});

test('gate completion fails frontend-slides final completion before Gate 1 even without regex prose', () => {
  const err = getFrontendSlidesA2UIGateCompletionError({
    status: 'completed',
    skillId: 'frontend-slides',
    prompt: 'Create a presentation from this report',
    gateState: { completedGateIds: [] },
  });
  assert.match(err || '', /"presentation_context"/);
});

test('gate completion fails final completion before all required gates', () => {
  const err = getFrontendSlidesA2UIGateCompletionError({
    status: 'completed',
    skillId: 'frontend-slides',
    prompt: 'Create a presentation from this report',
    gateState: {
      completedGateIds: [
        'presentation_context',
        'outline_confirmation',
        'style_path_selection',
      ],
    },
  });
  assert.match(err || '', /"mood_or_preset_selection"/);
});

test('gate completion fails completed frontend-slides run after all gates without a deck', () => {
  const err = getFrontendSlidesA2UIGateCompletionError({
    status: 'completed',
    skillId: 'frontend-slides',
    prompt: 'Create a presentation from this report',
    gateState: {
      completedGateIds: [
        'presentation_context',
        'outline_confirmation',
        'style_path_selection',
        'mood_or_preset_selection',
        'style_preview_selection',
      ],
    },
  });
  assert.match(err || '', /before producing the final HTML deck artifact/);
});

test('gate completion allows edit-existing-deck frontend-slides completion', () => {
  const err = getFrontendSlidesA2UIGateCompletionError({
    status: 'completed',
    skillId: 'frontend-slides',
    prompt: 'Edit the existing deck at output/slides.html and polish slide 3',
    gateState: { completedGateIds: [] },
  });
  assert.equal(err, null);
});
