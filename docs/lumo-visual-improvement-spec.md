# Lumo Visual Improvement Specification

**Status:** Proposed
**Scope:** Chat visualization, chat composer, Markdown/Mermaid rendering, login experience, favicon, and product language
**Primary UI system:** Astryx Design System
**Migration approach:** Astryx-first for the chat surface; staged removal of Tailwind

## 1. Purpose

This specification defines the visual improvement plan for rebranding HelpUDoc as Lumo and improving the main interaction surfaces.

The immediate focus is the experience users see most often:

- the workspace chat window;
- the chat composer and its contextual hints;
- Markdown, code, tables, and Mermaid visualization inside responses;
- the login page;
- favicon, page metadata, and visible product language.

The plan is intentionally presentation-focused. Existing conversation state, streaming behavior, authentication flows, tool execution, interrupt contracts, and backend APIs remain unchanged unless a later implementation task explicitly expands scope.

## 2. Product and brand architecture

### 2.1 Brand hierarchy

Use **Lumo** as the umbrella brand and **Lumo Studio** as the name of the primary application.

| Name | Role |
| --- | --- |
| **Lumo** | Umbrella product and company-facing brand |
| **Lumo Studio** | Main workspace for creating, reviewing, and working with artifacts |
| **Lumo Knowledge** | Document ingestion, indexing, retrieval, and governed source context |
| **Lumo Memory** | Persistent user, team, and project context |
| **Lumo Skills** | Reusable agent capabilities and specialized instructions |
| **Lumo Workflows** | Multi-step automations, approvals, and repeatable processes |
| **Lumo Connect** | External services, MCP servers, storage, and integrations |
| **Lumo API** | Programmatic access for developers and platform integrations |

These should initially be treated as product modules rather than seven independent products. The main application should remain visually and navigationally coherent under **Lumo Studio**.

### 2.2 Brand promise

Recommended positioning:

> Lumo turns trusted knowledge into useful work.

Supporting language:

> A workspace for knowledge, memory, skills, and workflows.

### 2.3 Language principles

- Prefer clear product language over generic “AI-powered” claims.
- Use “workspace,” “context,” “knowledge,” “artifact,” and “workflow” consistently.
- Describe the agent by what it helps users accomplish, not by model terminology.
- Keep status labels short and observable: `Working`, `Waiting for approval`, `Completed`, `Needs attention`.
- Use “add context” for files, sources, mentions, and workspace references.
- Use “artifact” for generated documents, diagrams, reports, and other durable outputs.
- Use “connect” for integrations and external systems.

Avoid:

- switching between HelpUDoc and Lumo in the same visible surface;
- calling every generated response a “chat message” when it is actually a document or artifact;
- overly anthropomorphic copy that obscures what the system is doing;
- unexplained internal terms such as stream events, gates, or renderer contracts.

## 3. Visual direction

### 3.1 Overall character

Lumo should feel calm, intelligent, and useful rather than heavily decorated. The visual hierarchy should come from spacing, typography, and semantic status—not large saturated cards.

The preferred direction is:

- neutral Astryx surfaces as the foundation;
- restrained blue or cyan for interaction and focus;
- a subtle luminous accent for Lumo branding;
- clear distinction between user content, assistant content, activity, and artifacts;
- generous readable widths for long-form responses;
- compact controls around the content rather than inside it.

### 3.2 Colour principles

- Use Astryx neutral theme tokens as the source of truth.
- Reserve the primary accent for focus, links, selected tokens, active controls, and progress.
- Avoid using saturated blue as the background of long user messages with dark text.
- Prefer a neutral or pale-accent user surface with strong text contrast.
- Render assistant responses as ghost content when they contain Markdown, code, tables, or diagrams.
- Use muted neutral surfaces for tool activity and attachments.
- Use orange/amber for approval or attention states and red for errors.
- Ensure all light and dark mode states maintain readable contrast.

### 3.3 Surfaces and hierarchy

Not every group needs a card. Use:

- spacing and typography for normal conversation flow;
- `Card` for discrete artifacts, approvals, and meaningful activity boundaries;
- `ChatToolCalls` or compact `Item` rows for operational activity;
- `Toolbar` for artifact/document headers with actions;
- `Resizable` for desktop artifact side panels;
- fullscreen `Dialog` for artifact review on narrow screens.

## 4. Chat window

### 4.1 Target composition

The chat surface should be rebuilt around the Astryx chat family while retaining existing HelpUDoc/Lumo data and event handling.

Recommended composition:

- `ChatLayout` for scroll containment and chat density;
- `ChatMessageList` for the message stream;
- `ChatMessage` for sender-aware structure;
- `ChatMessageBubble` for user content;
- ghost `ChatMessageBubble` variants for assistant Markdown and rich content;
- `ChatMessageMetadata` for timestamp, model, status, and utility actions;
- `ChatSystemMessage` for date dividers and short inline status notices;
- `ChatToolCalls` for expandable tool execution details;
- `Avatar` only where it improves sender recognition.

### 4.2 Message treatment

User messages:

- right-aligned or sender-aligned according to Astryx conventions;
- filled neutral or pale-accent bubble;
- maximum readable width rather than full-column width;
- strong text contrast;
- attachments and context tokens displayed above or alongside the message.

Assistant messages:

- ghost presentation for long-form content;
- Markdown constrained to a readable measure;
- code blocks and Mermaid diagrams allowed to use a wider content surface;
- metadata placed once, on the final content block;
- utility actions such as copy, retry, and feedback kept compact.

### 4.3 Activity treatment

The current large activity card should become a compact, expandable status treatment.

Collapsed example:

> Working · 2m 14s
> Finished · Used search document

Expanded state:

- chronological tool events;
- tool name and target;
- duration where available;
- running/completed/error state;
- node or execution source only when useful to the user.

Use `ChatToolCalls` for standard tool activity and `Item` or `Card` for custom approval, clarification, or workflow states.

### 4.4 Artifact treatment

Generated documents, reports, diagrams, and other durable outputs should not be forced into ordinary message bubbles.

Use:

- an in-message artifact summary card;
- a desktop side panel with `Toolbar` and `Resizable`;
- a fullscreen `Dialog` on narrow screens;
- a readable document body with a separate diagram surface where required.

The artifact panel should support title, type, version, copy, share, close, and any applicable revision actions.

## 5. Chat composer

### 5.1 Astryx foundation

Use the supplied Astryx `ChatComposer` composition as the baseline:

- `ChatComposer`;
- `ChatComposerInput`;
- `ChatComposerDrawer` for attachments and context tokens;
- `ChatSendButton` or an equivalent send action;
- `Button`, `DropdownMenu`, `Token`, `ProgressBar`, and `Icon` for supporting controls.

The existing streaming, mention, slash-command, attachment, and submission handlers should be adapted into the Astryx slots rather than rewritten.

### 5.2 Placeholder and grey hints

The input should provide guidance without becoming visually noisy.

Recommended behavior:

- desktop placeholder: `Ask anything or type @ to add context · / for commands`;
- narrow/mobile placeholder: `Ask anything…`;
- optional supporting hint: `@ files and context · / commands`;
- muted grey hint text in both themes;
- high-contrast entered text;
- blue focus ring only when the field is focused;
- neutral border when idle.

The placeholder should describe the primary action. The supporting hint should describe secondary shortcuts. Do not put attachment names, model state, or long instructions into the placeholder.

### 5.3 Composer layout

The composer should behave as a focused dock at the bottom of the chat:

- multiline input starting around 44–56px high;
- automatic growth to approximately 160–200px;
- attachment/context tokens above the text area;
- compact header actions for mention and attachment;
- footer actions for model or mode only when they are genuinely useful;
- send action visually distinct from secondary controls;
- stop action visible during streaming;
- optional context-window progress only when users can act on the information.

Avoid exposing too many controls at once. If only one model or mode is available, do not add a selector merely because the component supports one.

### 5.4 Composer states

The implementation must define visual states for:

- empty and idle;
- focused and empty;
- text entered;
- attachments present;
- mention menu open;
- slash-command menu open;
- preparing attachments;
- streaming with stop action;
- validation error;
- disabled or unavailable authentication state.

## 6. Markdown, code, and Mermaid rendering

### 6.1 Content width contract

Normal Markdown and diagrams need different layout rules.

- prose should use a readable maximum width;
- code blocks may use a wider surface;
- Mermaid should render inside a dedicated wrapper;
- wide diagrams should preserve legibility through horizontal scrolling rather than aggressive shrinking;
- the entire chat column should not inherit a narrow fixed width intended for prose.

### 6.2 Mermaid wrapper requirements

The Mermaid renderer should:

- render as a block-level surface;
- preserve the SVG `viewBox`;
- use automatic height;
- avoid fixed-height clipping;
- allow horizontal overflow for wide diagrams;
- isolate Mermaid label styles from Markdown typography;
- prevent global `overflow`, `line-height`, `white-space`, and `svg` rules from affecting Mermaid labels;
- support light and dark theme variants;
- provide a clear border or muted background when the diagram is visually dense.

### 6.3 Renderer ownership

Do not migrate every `ReactMarkdown` call site independently. The implementation should introduce one Lumo Markdown presentation adapter and keep Mermaid ownership centralized in the existing shared renderer.

The adapter should:

- use Astryx `Markdown` for prose where its rendering contract is sufficient;
- preserve the current application-specific Mermaid rendering path until the dedicated wrapper has passed visual QA;
- set Astryx `Markdown` `contentWidth` deliberately for readable prose rather than constraining the full rich-content surface;
- keep tables and code blocks able to use the available content width;
- use Astryx `CodeBlock` with `width="100%"` and `container="section"` when embedded in a message or artifact panel;
- keep file URLs, workspace images, Mermaid, and copy behavior behind the same adapter boundary.

The initial adapter targets are the shared Markdown renderer, chat message rendering, file rendering, tool-output previews, and the rich editor. This avoids divergent Mermaid fixes across multiple surfaces.

### 6.4 Diagram source guidance

The diagram content itself should be reviewed when layout remains crowded:

- shorten long edge labels;
- move protocol detail into nodes or annotations;
- reduce cross-group edges;
- split very dense architecture diagrams into related diagrams;
- use a simpler curve style where edge labels overlap;
- avoid forcing large diagrams into a 450px content container.

## 7. Login page

### 7.1 Brand and copy

The login page should use **Lumo Studio** as the product name.

Recommended copy:

**Heading**
`Welcome to Lumo Studio`

**Supporting text**
`Your workspace for knowledge, memory, skills, and workflows.`

**Primary action**
`Continue with Google`

Alternative positioning line:

> Turn trusted knowledge into useful work.

Development-only header authentication should remain available when configured, but should be clearly labelled as a development sign-in mode and should not dominate the production experience.

### 7.2 Visual treatment

The current full-screen imagery, glass card, old logo, floating animation, and HelpUDoc copy should be simplified.

Preferred structure:

- quiet neutral background with a subtle Lumo glow or gradient;
- centered or two-column layout depending on product positioning;
- simple Lumo mark and wordmark;
- focused authentication card or panel;
- restrained theme toggle;
- high-contrast, accessible sign-in action;
- no decorative animation that distracts from authentication.

The login page should feel trustworthy and calm. It should introduce the brand, not attempt to explain every Lumo module.

### 7.3 Login requirements

- Replace visible HelpUDoc copy with Lumo/Lumo Studio language.
- Replace the existing logo treatment with the Lumo mark and wordmark.
- Keep Google authentication behavior unchanged.
- Preserve error, loading, redirect, and header-auth states.
- Ensure the login page works in light and dark modes.
- Ensure the visual design remains legible over the chosen background.
- Remove any remaining Vite branding from page metadata and icons.

## 8. Favicon and brand assets

### 8.1 Favicon

The current `frontend/index.html` points to `/vite.svg`; this must be replaced.

Create a dedicated simplified Lumo mark for:

- `/favicon.svg`;
- 16px and 32px PNG fallbacks if required;
- Apple touch icon;
- 192px and 512px application icons;
- manifest and theme-color metadata.

The mark must remain recognizable at 16px, work in monochrome, and not rely on wordmark text.

### 8.2 Logo system

Provide:

- primary Lumo wordmark;
- compact Lumo symbol;
- dark-background and light-background variants;
- single-colour fallback;
- clear-space and minimum-size guidance;
- accessible alt text: `Lumo` or `Lumo Studio`, depending on context.

## 9. Astryx and Tailwind migration

### 9.1 Decision

Use Astryx as the primary system for the chat surface. Do not remove Tailwind from the entire frontend in the same change.

The current frontend has substantial Tailwind usage across dashboards, settings, knowledge, users, file views, and chat. A global removal would increase scope and regression risk.

### 9.2 Staged approach

1. Build an Astryx-first chat composition.
2. Keep existing state and data transformations intact.
3. Adapt the current Markdown, Mermaid, attachments, streaming, and interrupt renderers into Astryx slots.
4. Remove Tailwind classes from the chat surface.
5. Validate chat behavior and visual states.
6. Migrate other screens in separate workstreams.
7. Remove Tailwind globally only after the remaining screens and compatibility surfaces are migrated.

### 9.3 Technical naming boundary

The visual rebrand should not immediately rename internal namespaces such as:

- `@helpudoc/*` packages;
- API contracts;
- local-storage keys;
- backend service names;
- deployment namespaces;
- internal file paths and directive markers.

Those identifiers can be migrated later with explicit compatibility and data-migration planning.

### 9.4 Evidence from the frontend graph and Astryx CLI

A focused Graphify run over `frontend/src` found 719 nodes, 1,063 relationships, and 88 implementation communities. Its most useful findings for this specification are:

| Finding | Implication for the migration |
| --- | --- |
| The workspace interaction layer is a large, low-cohesion orchestration community. | Keep conversation, streaming, attachment, and interrupt state in place; introduce Astryx through a presentation adapter rather than rewriting the workspace controller. |
| Markdown/Mermaid rendering forms one shared community around `MarkdownShared`, `MarkdownRichEditor`, and Mermaid configuration. | Fix visualization once in the shared renderer, then consume it from chat, file preview, and editor views. |
| Tool-activity summarisation is its own shared community. | Map existing normalized events to controlled Astryx `ChatToolCalls`; do not recreate event summarisation in the presentation layer. |
| The frontend contains an Astryx theme root, an MUI compatibility theme, and substantial Tailwind-based UI. | Do not introduce a fourth visual system. Use Astryx for new chat/login work, retain MUI only as compatibility infrastructure, and retire Tailwind feature by feature. |
| Settings and dashboard components exist in duplicated feature/component paths. | Treat consolidation as a prerequisite audit before any application-wide Tailwind removal. Avoid migrating both copies independently. |
| The Lumo sprite sheet is consumed by both the desktop pet and the mobile avatar. | Preserve and version this asset as a shared Lumo brand asset; do not treat it as disposable login artwork. |

The Astryx CLI confirms the component-level contracts needed for the target experience:

- `ChatLayout` accepts an external `scrollRef`, so existing scroll behavior can be retained while gaining the integrated composer dock and scroll-to-latest affordance.
- `ChatComposer` already supports controlled values, attachments in `ChatComposerDrawer`, header and footer actions, streaming stop behavior, and inline validation states.
- `ChatToolCalls` supports controlled expansion, allowing the existing per-message expanded state to remain the source of truth.
- `Markdown` provides prose-specific `contentWidth` and leaves tables/code unconstrained, which matches the required content width contract when combined with a dedicated Mermaid wrapper.
- `Resizable` supports `autoSaveId`, so artifact-panel sizing should use one stable, Lumo-namespaced preference key rather than new ad hoc storage.
- `Item` provides the compact label/description/status-row structure required for collapsed activity summaries.

### 9.5 Migration constraints

- Do not change the durable agent stream, interrupt, or authentication contracts as part of the visual migration.
- Do not duplicate tool-event formatting; continue to use the existing activity-summary utilities.
- Do not move Mermaid sizing rules into global Markdown CSS.
- Do not delete or replace the Lumo sprite sheet until both desktop and mobile consumers have been updated deliberately.
- Do not remove MUI or Tailwind globally until the duplicate settings/dashboard stacks have an agreed source of truth.

## 10. Implementation phases

### Phase 1: Brand foundation

- approve Lumo mark and wordmark direction;
- define accent and neutral colour tokens;
- define Lumo Studio tagline and copy vocabulary;
- create favicon and application icon assets;
- update title and visible login branding.

### Phase 2: Chat visual prototype

- compose an Astryx chat showcase using representative content;
- include long Markdown, code, tables, Mermaid, tool activity, attachments, and streaming;
- compare user bubble, assistant ghost, activity, and artifact treatments;
- test light and dark modes.

The prototype must use the real chat state adapters where possible, including controlled tool activity, attachments, the existing scroll container, and a long Mermaid response. Static mock-only prototypes are insufficient for validating the integration seams.

### Phase 3: Chat integration

- replace the custom chat presentation layer;
- connect existing event and interaction data to Astryx components;
- integrate the composer and contextual hints;
- preserve current behavior and accessibility semantics.

Implementation order:

1. Add the shared Lumo Markdown/Mermaid presentation adapter.
2. Replace the custom composer surface with `ChatComposer` while retaining the existing controlled input handlers.
3. Replace the message-list shell and bubbles with the Astryx chat family.
4. Map existing activity summaries to `Item` and detailed events to `ChatToolCalls`.
5. Move generated artifacts into the resizable desktop panel/fullscreen mobile dialog pattern.
6. Validate assistant Markdown, approval, clarification, attachments, and streaming before removing the previous chat styles.

### Phase 4: Login redesign

- replace the old logo and HelpUDoc copy;
- apply Lumo Studio layout and messaging;
- retain existing Google/header authentication behavior;
- validate error, loading, redirect, and theme states.

### Phase 5: QA and migration decision

- run frontend build and lint;
- run chat and login E2E checks;
- validate narrow, desktop, and wide layouts;
- validate Mermaid diagrams with long labels and wide graphs;
- decide whether to continue migrating other screens away from Tailwind.

### Phase 6: Component-stack consolidation

- inventory duplicate settings, dashboard, and workspace-page component paths;
- choose a single owner for each duplicated UI surface;
- delete or redirect the superseded implementation only after import and route checks;
- migrate the surviving surface to Astryx before considering removal of its Tailwind/MUI styling.

## 11. Acceptance criteria

### Branding

- No visible HelpUDoc or Vite branding remains on the login page or browser tab.
- Favicon and application icons use the approved Lumo mark.
- Product names follow the Lumo hierarchy consistently.

### Chat

- User and assistant messages have clear visual distinction without oversized saturated blocks.
- Tool activity is compact when collapsed and detailed when expanded.
- The composer clearly communicates `@` context and `/` command affordances.
- Streaming exposes a clear stop action.
- Attachments, mentions, and slash commands remain usable.

### Rich content

- Markdown remains readable at normal chat widths.
- Code blocks do not force the entire chat column to expand unexpectedly.
- Mermaid diagrams do not clip labels or become misaligned because of inherited Markdown styles.
- Wide diagrams remain inspectable through scrolling or an artifact surface.

### Login

- Login copy identifies Lumo Studio.
- Google sign-in, development header sign-in, errors, loading, redirects, and theme switching continue to work.
- The login page is visually calm, accessible, and responsive.

### Migration safety

- No backend or stream contract changes are required for the first visual release.
- Internal HelpUDoc namespaces remain compatible until a separate technical rename is approved.
- Existing non-chat Tailwind screens remain unaffected by the initial migration.

### Repository hygiene

- Graph analysis excludes dependency directories, build output, local data volumes, and other generated files.
- Documentation screenshots must be referenced by an active document or removed.
- Reproducible dependency directories must not be included in source analysis or committed.
- Brand assets are retained only when they have an active consumer or an approved replacement plan.

## 12. Current implementation references

- [LoginPage.tsx](../frontend/src/pages/LoginPage.tsx)
- [AgentChatPane.tsx](../frontend/src/components/chat/AgentChatPane.tsx)
- [ChatInputArea.tsx](../frontend/src/components/chat/ChatInputArea.tsx)
- [ChatMessageBubble.tsx](../frontend/src/components/chat/ChatMessageBubble.tsx)
- [AppThemeRoot.tsx](../frontend/src/AppThemeRoot.tsx)
- [index.html](../frontend/index.html)
- [Astryx interaction architecture](./interaction-stream-v3-astryx-architecture.md)

The Graphify report and interactive graph generated during this assessment are local analysis artifacts under `graphify-out/`; they are intentionally excluded from version control.
