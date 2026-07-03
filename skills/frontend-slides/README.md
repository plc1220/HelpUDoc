# Frontend Slides

`frontend-slides` is HelpUDoc's bundled skill for creating browser-native slide decks and exporting them to Office-compatible formats.

This bundle is vendored from the upstream Claude Code plugin payload at `plugins/frontend-slides/skills/frontend-slides/`, then adapted for HelpUDoc's A2UI workflow.

## Core Capabilities

- Generate fixed-stage HTML decks at a 1920x1080 slide canvas.
- Convert `.pptx` source decks into redesigned HTML slides.
- Generate three visual style previews under `.frontend-slides/slide-previews/`.
- Use safe presets plus the `bold-template-pack/` design systems with progressive disclosure.
- Export final HTML decks to `.pptx` with `scripts/export-pptx.py`.
- Export final HTML decks to `.pdf` with `scripts/export-pdf.sh`.
- Optionally deploy final decks with `scripts/deploy.sh`.

## HelpUDoc Gate Flow

New runs use these active A2UI gates:

1. `presentation_context`
2. `outline_confirmation` when a proposed outline exists
3. `style_preview_selection` after previews have been generated

Legacy gate IDs `style_path_selection` and `mood_or_preset_selection` remain recognized by runtime compatibility code, but new runs should generate three previews directly.

## PPTX Export

PowerPoint export is fidelity-first:

```bash
python scripts/export-pptx.py deck.html deck.pptx
```

The exporter renders each `.slide` at 1920x1080 and places the screenshot full-bleed on a widescreen PowerPoint slide. This preserves visual fidelity, CSS styling, fonts as rendered, and local images. It does not convert HTML into editable PowerPoint text boxes or shapes.

For deterministic tests or custom capture workflows, pass pre-rendered screenshots:

```bash
python scripts/export-pptx.py deck.html deck.pptx --screenshots-dir screenshots/
```

## Included Files

| File | Purpose |
| ---- | ------- |
| `SKILL.md` | Main workflow and guardrails |
| `interaction_contract.yaml` | HelpUDoc A2UI gate contract |
| `STYLE_PRESETS.md` | Safe visual preset reference |
| `viewport-base.css` | Mandatory fixed-stage CSS |
| `html-template.md` | Fixed-stage HTML/JS architecture |
| `animation-patterns.md` | Animation reference |
| `bold-template-pack/` | 34 progressively loaded design systems |
| `scripts/export-pptx.py` | HTML-to-PPTX export |
| `scripts/export-pdf.sh` | HTML-to-PDF export |
| `scripts/extract-pptx.py` | PPTX content extraction |
| `scripts/deploy.sh` | Vercel deployment helper |

