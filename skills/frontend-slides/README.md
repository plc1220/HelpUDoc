# Frontend Slides

`frontend-slides` is a bundled HelpUDoc skill for creating browser-native slide decks as single self-contained HTML files.

It supports both new presentations and PowerPoint-to-web conversion workflows.

## What makes this skill different

- Zero-dependency output: one HTML file with inline CSS and JavaScript
- Visual style discovery: the workflow favors examples and previews over abstract aesthetic questions
- Distinctive design direction: the presets are intentionally less generic than stock AI slide themes
- Strict viewport fitting: every slide must fit in the viewport with no in-slide scrolling

## Common use cases

- founder or product pitch decks
- technical talks and demos
- converting existing `.ppt` or `.pptx` files to web slides
- polishing an existing HTML deck without introducing a framework build step

## Invocation examples

```text
/frontend-slides
```

```text
Create a pitch deck for our AI product launch.
```

```text
Convert presentation.pptx into a web slideshow.
```

## Core workflow

1. Detect whether the request is a new deck, a PPT conversion, or an edit to an existing deck
2. Gather content and narrative goals
3. Narrow the visual direction using style references instead of vague adjectives
4. Generate a production-ready HTML presentation
5. Keep every slide viewport-safe on desktop and mobile sizes

## Non-negotiable presentation rule

Every slide must fit within one viewport height.
If content does not fit, the deck should split content into additional slides instead of shrinking everything or allowing scrolling.

## Included files

| File | Purpose |
| ---- | ------- |
| `SKILL.md` | Full skill workflow and guardrails |
| `STYLE_PRESETS.md` | Curated visual style reference library |

## Output features

Typical generated decks include:

- keyboard, swipe, or scroll navigation
- responsive typography and spacing
- reduced-motion support
- inline comments and readable structure for future edits
- no external npm or framework dependency requirement for playback
