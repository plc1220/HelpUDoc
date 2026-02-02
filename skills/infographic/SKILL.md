---
name: infographic
description: Turn user content into AntV Infographic HTML with SVG export.
tools: []
source_skills:
  - infographic_agent-core
---

# infographic

## Overview
Use this skill to generate AntV Infographic DSL from user content and write a complete HTML file that renders the infographic and supports SVG export.

## Workflow
1. Parse the user’s intent and content. If essential details are missing, ask 1–3 concise questions.
2. Select the most suitable template based on the information structure.
3. Produce valid AntV Infographic DSL.
4. Generate a full HTML file that renders the infographic and includes an SVG export button.
5. Write the HTML file to the workspace using `write_file`.
6. Reply in plain text with the file path, the DSL, and two short lines of guidance (no Markdown, no JSON, no code fences).

## DSL rules
- First line must be: `infographic <template-name>`.
- Use `data` and `theme` blocks; indent inner lines by two spaces.
- Use `key value` pairs; lists use `-` prefixes.
- The `data` block must include `title` (and `desc` if helpful).
- Use exactly one main data field for the chosen template:
  - `list-*` -> `lists`
  - `sequence-*` -> `sequences` (optional `order asc|desc`)
  - `compare-*` -> `compares`
  - `compare-binary-*` -> two root nodes with children under each
  - `compare-hierarchy-left-right-*` -> two root nodes with children under each
  - `hierarchy-structure` -> `items`
  - `hierarchy-*` -> single `root` with `children`
  - `relation-*` -> `nodes` + `relations` (or relations only for simple graphs)
  - `chart-*` -> `values` (optional `category`)
- The DSL must not contain JSON, Markdown, or explanatory prose.
- Match the user’s language for all text values.

## Template list
- chart-bar-plain-text
- chart-column-simple
- chart-line-plain-text
- chart-pie-compact-card
- chart-pie-donut-pill-badge
- chart-pie-donut-plain-text
- chart-pie-plain-text
- chart-wordcloud
- compare-binary-horizontal-badge-card-arrow
- compare-binary-horizontal-simple-fold
- compare-binary-horizontal-underline-text-vs
- compare-hierarchy-left-right-circle-node-pill-badge
- compare-quadrant-quarter-circular
- compare-quadrant-quarter-simple-card
- compare-swot
- hierarchy-mindmap-branch-gradient-capsule-item
- hierarchy-mindmap-level-gradient-compact-card
- hierarchy-structure
- hierarchy-tree-curved-line-rounded-rect-node
- hierarchy-tree-tech-style-badge-card
- hierarchy-tree-tech-style-capsule-item
- list-column-done-list
- list-column-simple-vertical-arrow
- list-column-vertical-icon-arrow
- list-grid-badge-card
- list-grid-candy-card-lite
- list-grid-ribbon-card
- list-row-horizontal-icon-arrow
- list-sector-plain-text
- list-zigzag-down-compact-card
- list-zigzag-down-simple
- list-zigzag-up-compact-card
- list-zigzag-up-simple
- relation-dagre-flow-tb-animated-badge-card
- relation-dagre-flow-tb-animated-simple-circle-node
- relation-dagre-flow-tb-badge-card
- relation-dagre-flow-tb-simple-circle-node
- sequence-ascending-stairs-3d-underline-text
- sequence-ascending-steps
- sequence-circular-simple
- sequence-color-snake-steps-horizontal-icon-line
- sequence-cylinders-3d-simple
- sequence-filter-mesh-simple
- sequence-funnel-simple
- sequence-horizontal-zigzag-underline-text
- sequence-mountain-underline-text
- sequence-pyramid-simple
- sequence-roadmap-vertical-plain-text
- sequence-roadmap-vertical-simple
- sequence-snake-steps-compact-card
- sequence-snake-steps-simple
- sequence-snake-steps-underline-text
- sequence-stairs-front-compact-card
- sequence-stairs-front-pill-badge
- sequence-timeline-rounded-rect-node
- sequence-timeline-simple
- sequence-zigzag-pucks-3d-simple
- sequence-zigzag-steps-underline-text

## Template selection guidance
- Strict order / process -> `sequence-*`
- Timeline -> `sequence-timeline-*`
- Steps -> `sequence-ascending-*` or `sequence-stairs-*`
- Roadmap -> `sequence-roadmap-vertical-*`
- List of points -> `list-row-*` or `list-column-*`
- Grid of items -> `list-grid-*`
