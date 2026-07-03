# Frontend Slides Upgrade Plan

Date: 2026-07-03
Compared upstream: `zarazhangrui/frontend-slides` `main` at `9906a34d640d2111f724544cbc50f7f130569ae1`

## Local Context

HelpUDoc currently bundles `frontend-slides` under `skills/frontend-slides/` with a local A2UI interaction contract:

- `presentation_context`
- `outline_confirmation`
- `style_path_selection`
- `mood_or_preset_selection`
- `style_preview_selection`

Runtime code also has frontend-slides-specific validation and synthetic fallback behavior in:

- `agent/helpudoc_agent/a2ui_contract.py`
- `agent/helpudoc_agent/a2ui_workflows.py`
- `agent/helpudoc_agent/middleware/implicit_input_guard.py`
- related tests in `tests/` and `agent/tests/`

The working tree had a pre-existing modified file, `agent/tests/test_tools_data_package.py`, before this plan was created.

## Upstream Delta

Upstream is now a Claude Code plugin package that contains a skill, not only a standalone `SKILL.md` plus presets. The root files and `plugins/frontend-slides/skills/frontend-slides/` largely mirror the same skill payload; the plugin metadata adds marketplace installation and namespaced invocation.

File-level diff against our bundled copy is roughly:

- `817` upstream insertions
- `1859` deletions from our local skill text/preset duplication
- new support files:
  - `viewport-base.css`
  - `html-template.md`
  - `animation-patterns.md`
  - `scripts/extract-pptx.py`
  - `scripts/deploy.sh`
  - `scripts/export-pdf.sh`
  - `bold-template-pack/` with 34 design systems
  - Claude plugin metadata under `.claude-plugin/` and `plugins/frontend-slides/.claude-plugin/`

The highest-impact behavioral change is the rendering model:

- Local: each slide is `100vh/100dvh` and reflows responsively.
- Upstream: every deck uses a fixed `1920x1080` 16:9 stage scaled uniformly into the browser viewport.

That fixed-stage change affects generated HTML, style previews, export behavior, QA expectations, and any tests/documentation that still assert viewport-height responsive slides.

## What To Import

Import these upstream files into `skills/frontend-slides/`:

- `SKILL.md`
- `STYLE_PRESETS.md`
- `viewport-base.css`
- `html-template.md`
- `animation-patterns.md`
- `bold-template-pack/`
- `scripts/extract-pptx.py`
- `scripts/deploy.sh`
- `scripts/export-pdf.sh`

Use the plugin skill payload as the source of truth:

- `plugins/frontend-slides/skills/frontend-slides/`

The upstream root files are useful for comparison, but the plugin skill directory is the package that Claude Code installs.

Do not import upstream `.claude-plugin/` as-is unless HelpUDoc wants to expose this as a Claude Code marketplace plugin. It is not needed for the existing bundled HelpUDoc skill registry, which reads `skills/*/SKILL.md`.

Remove local noise:

- `skills/frontend-slides/.DS_Store`

Keep or adapt local-only files:

- `skills/frontend-slides/interaction_contract.yaml`
- `skills/frontend-slides/README.md`

## Reconciliation Decisions

0. PPTX export is the primary acceptance criterion.

   The upstream plugin packaging and fixed-stage work are useful, but HelpUDoc should not consider this upgrade complete unless generated HTML decks can be exported to `.pptx`.

   Recommended first implementation: screenshot-backed PPTX export.

   - Use a browser renderer at the authored slide size (`1920x1080`) to capture each `.slide`.
   - Build a widescreen `.pptx` with one full-slide PNG per slide.
   - Preserve slide order, visual fidelity, fonts as rendered, CSS effects, backgrounds, and local images.
   - Document that v1 exports are visually faithful but not deeply editable in PowerPoint because each slide is a flattened image.

   This matches how `scripts/export-pdf.sh` already thinks about static export and is much lower risk than attempting a complete HTML/CSS-to-PowerPoint shape translator up front.

   A later v2 can add semantic/editable export for common text boxes and images, but that should be treated as a separate quality tier because CSS layout, gradients, filters, clipping, and animations do not map cleanly to PowerPoint primitives.

1. Fixed-stage output should become the HelpUDoc standard.

   Adopt upstream `viewport-base.css` and `html-template.md`. Update local docs/tests from `100vh` viewport fitting to `1920x1080` stage scaling. The result should still have no scrolling, but via uniform stage scale rather than responsive reflow.

2. Preserve HelpUDoc A2UI, but simplify the gate sequence.

   Upstream now asks all initial presentation questions together and generates 3 previews directly. It explicitly says not to ask about inline editing or style path before showing a draft/previews.

   Recommended HelpUDoc gate sequence:

   - `presentation_context`: include purpose, length, content readiness, and the new density question.
   - `outline_confirmation`: keep as a conditional gate only after the agent has a concrete outline/image plan.
   - `style_preview_selection`: keep as the visual chooser after generated previews exist.

   Remove or deprecate:

   - `style_path_selection`
   - `mood_or_preset_selection`

   If backward compatibility is risky, keep those gate IDs recognized by `a2ui_workflows.py` for old resumptions, but do not include them in the active contract for new runs.

3. Add the density question to the local contract.

   Upstream adds:

   - low density / speaker-led
   - high density / reading-first

   This should be part of `presentation_context`, because it changes slide count, typography, and layout density.

4. Treat bold templates with progressive disclosure.

   The agent should first read `bold-template-pack/selection-index.json`, then only shortlisted `preview.md` files, then exactly one selected `design.md`. Avoid bulk-reading all 34 design docs during style discovery.

5. Update generated preview path expectations.

   Upstream uses `.frontend-slides/slide-previews/`; local fallback code currently references `.claude-design/slide-previews/`. Pick one canonical path. Recommendation: use upstream `.frontend-slides/slide-previews/` and update fallback synthetic preview metadata accordingly.

6. Include share/export support only if the local product wants those commands.

   The upstream scripts are useful, but `deploy.sh` invokes Vercel and `export-pdf.sh` invokes Node/Playwright. For HelpUDoc, include them as skill assets but make the skill request explicit user confirmation before deployment/export.

7. Do not claim HTML-to-PPTX support unless we add it.

   Current upstream main directly ships:

   - PPTX-to-HTML extraction via `scripts/extract-pptx.py`
   - HTML-to-PDF export via `scripts/export-pdf.sh`
   - Vercel deployment via `scripts/deploy.sh`

   It does not ship an `export-pptx` or `html-to-pptx` script. `bold-template-pack/deck-stage.js` contains comments about a PPTX exporter using `noscale`, so the stage component appears compatible with such an exporter, but the exporter itself is not included in the current package.

8. Prefer local dependencies already present in HelpUDoc.

   HelpUDoc already has `python-pptx` in `agent/requirements-reporting.txt`, plus Office unpack/pack/validate utilities under `skills/xlsx/scripts/office/`. A first exporter can be implemented with:

   - Playwright/Chromium or the same browser path used by PDF export for slide screenshots
   - `python-pptx` to assemble a widescreen deck
   - existing Office validation utilities as a post-export smoke check

   If we prefer a pure Node path later, `pptxgenjs` is also a reasonable candidate, but it would add another dependency path.

## Implementation Phases

### Phase 1: Vendor The Skill Assets

- Copy upstream plugin skill files from `plugins/frontend-slides/skills/frontend-slides/` into `skills/frontend-slides/`.
- Add `viewport-base.css`, `html-template.md`, `animation-patterns.md`, `scripts/`, and `bold-template-pack/`.
- Remove `.DS_Store`.
- Keep `interaction_contract.yaml` for HelpUDoc, but update it in Phase 2.

Validation:

- `find skills/frontend-slides -maxdepth 3 -type f | sort`
- Confirm `bold-template-pack/selection-index.json` parses and reports `template_count: 34`.

### Phase 2: Add HTML-to-PPTX Export

- Add `skills/frontend-slides/scripts/export-pptx.py` or `export-pptx.sh`.
- Input: path to generated HTML deck.
- Output: `.pptx` next to the HTML by default, with an optional output path.
- Render each slide at `1920x1080`.
- Use `.slide` count and slide navigation/visibility logic compatible with the fixed-stage template.
- If using `deck-stage.js`, set/use the `noscale` path where applicable so capture uses authored geometry.
- Add one full-bleed image per PowerPoint slide using `python-pptx`.
- Include slide notes if a generated deck exposes notes in a machine-readable block; otherwise skip notes and document the limitation.
- Run Office validation after export when available.

Validation:

- Create or use a tiny fixture deck with 2-3 `.slide` elements.
- Export to `.pptx`.
- Assert the resulting file exists, opens as a ZIP, contains expected `ppt/slides/slide*.xml`, and has the expected slide count.
- Optionally unpack and validate with `skills/xlsx/scripts/office/validate.py`.

### Phase 3: Update HelpUDoc A2UI Contract

- Update `skills/frontend-slides/interaction_contract.yaml`:
  - add `density` to `presentation_context`
  - remove active `style_path_selection`
  - remove active `mood_or_preset_selection`
  - keep `style_preview_selection`
- Update `agent/helpudoc_agent/a2ui_workflows.py`:
  - active gate order becomes `presentation_context`, `outline_confirmation`, `style_preview_selection`
  - optionally preserve old gate IDs as legacy aliases, not required gates
- Update `agent/helpudoc_agent/a2ui_contract.py` default props and validation rules.
- Update `agent/helpudoc_agent/middleware/implicit_input_guard.py` so synthetic recovery follows the new sequence and fallback preview paths.

Validation:

- `pytest tests/test_a2ui_contract_middleware.py`
- `pytest tests/test_interrupt_payload_parsing.py`
- `pytest agent/tests/test_implicit_input_guard.py agent/tests/test_workflow_action_tool.py`

### Phase 4: Update Skill Prompt And Local README

- Replace local `SKILL.md` with upstream content plus HelpUDoc-specific A2UI notes.
- Keep upstream fixed-stage rules intact.
- Add export options that include:
  - Export to PPTX
  - Export to PDF
  - Deploy/share URL
- Make PPTX export the preferred Office-compatible deliverable.
- Clearly state that v1 PPTX export is image-backed/visually faithful, not fully editable.
- Update `skills/frontend-slides/README.md`:
  - fixed 16:9 stage
  - bold template pack
  - `.frontend-slides/slide-previews/`
  - PPTX/PDF export and deploy scripts
  - HelpUDoc gate flow

Validation:

- `pytest tests/test_clarification_prompt_contract.py`
- Search for obsolete local assertions:
  - `rg "style_path_selection|mood_or_preset_selection|100vh|100dvh|\\.claude-design/slide-previews" skills agent tests docs`

### Phase 5: Adjust Generated HTML Expectations

- Ensure the prompt requires:
  - `<div class="deck-viewport">`
  - `<main class="deck-stage" id="deckStage">`
  - `.slide` elements at `1920px x 1080px`
  - `SlidePresentation.setupStageScale()`
  - visibility via `.active` / `.visible`, not `display: none`
- Update any HelpUDoc tests or docs that require viewport-height sections.
- Keep legacy acceptance loose enough to avoid breaking externally supplied HTML edits, but require fixed-stage output for newly generated decks.

Validation:

- Add or update a contract test that checks the skill text mentions `viewport-base.css`, `deck-stage`, and `1920x1080`.
- If there is an end-to-end generation fixture, inspect the output for `.deck-stage` and no `height: 100vh` slide contract.

### Phase 6: Smoke Test A Real Run

Use a small deck request and verify:

- `presentation_context` appears with density.
- Outline confirmation only appears after an outline exists.
- Three visual previews are generated under `.frontend-slides/slide-previews/`.
- Style preview chooser receives real preview metadata.
- Final HTML uses the fixed-stage architecture.
- `export-pptx` produces a valid `.pptx` with the same slide count.
- Browser screenshot at `1280x720` and a phone viewport shows the same 16:9 slide letterboxed/pillarboxed, not reflowed.

### Phase 7: Update Graph

After code changes, run:

```bash
graphify update .
```

This is required by the project instructions after modifying code files.

## Main Risks

- A screenshot-backed PPTX is not fully editable. It is the right v1 for fidelity, but users expecting editable PowerPoint shapes need a separate v2 exporter.
- Existing A2UI tests assume five gates; upstream flow wants three active gates.
- Synthetic fallback logic may keep re-inserting removed gates unless updated with the active gate sequence.
- The fixed-stage model may expose old generated decks that still use scroll-snap `100vh`; handle edits to existing decks leniently.
- `deploy.sh` and `export-pdf.sh` introduce external tooling expectations (`npx`, Vercel, Playwright). Keep them optional and explicit.
- The current upstream package does not include HTML-to-PPTX export even though `deck-stage.js` mentions a PPTX exporter integration point. Treat HTML-to-PPTX as a separate enhancement if HelpUDoc needs it.
- The upstream branch `fix/navdots-and-export-state` contains fixes not on main. Before implementation, inspect that branch’s `html-template.md` changes and port only the nav dot/export-state fixes if applicable.

## Suggested First PR Scope

Make the first PR a focused compatibility upgrade:

1. Vendor upstream assets.
2. Add screenshot-backed HTML-to-PPTX export and tests.
3. Switch the active A2UI contract to the three-gate flow.
4. Update tests for the new gate sequence and fixed-stage prompt requirements.
5. Do not wire Vercel deployment into product UI beyond making the script available to the skill.
6. Run the targeted A2UI/PPTX tests, then `graphify update .`.
