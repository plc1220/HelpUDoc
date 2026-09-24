# Template-specific slide thumbnails

The gallery now uses 34 prerendered sample covers. They are **authored interpretations of the shipped design specifications**, not screenshots of an original template HTML file (the skill ships Markdown design specs, not those HTML files). Sample copy is deliberately shared to make the visual differences comparable. The separate agent-generated preview still uses the user's actual deck.

## Validation and repair

| Before | After | Why |
| --- | --- | --- |
| Three generic CSS motifs selected by mood tags | An explicit composition for each of the 34 template identities | A mood category cannot represent the template's layout or signature elements. |
| Guessed light/dark background, generic serif/system fonts | Named color tokens and explicit display/body/label roles from each `design.md`; required fonts baked into the image | The previous samples misrepresented the templates even when the agent applied the correct style. |
| No relationship between thumbnail and source revision | Source, renderer and image hashes, plus a provenance regression test | Changed specifications fail validation until the images are regenerated. |

Examples checked: Editorial Forest's Source Serif 4 / JetBrains Mono and green-pink-cream colors; Biennale Yellow's Instrument Serif and yellow bloom; 8-Bit Orbit's Tektur, pixel offsets and neon grid; Retro Windows' beveled chrome; Vellum's yellow italic Cormorant Garamond on periwinkle. All 34 were reviewed together for visual differentiation and clipping.

## Regeneration

From `frontend`:

```sh
node scripts/render-slide-style-thumbnails.mjs
node scripts/generate-slide-style-catalog.mjs
node --experimental-strip-types --test tests/slideStyleThumbnails.test.ts
```

- Compositions: `scripts/slide-style-covers.mjs`.
- Source: `skills/frontend-slides/bold-template-pack/templates/*/{design,preview}.md`.
- Output: `public/slide-styles/*.jpg` and `manifest.json` (commit these generated assets).
- Render: fixed 1920×1080 stage captured at 960×540, JPEG quality 86. Explicit typography-role and source-token validation; fail on missing fonts or overflowing title.
- Fonts are fetched only during generation, cached in `node_modules/.cache/slide-style-fonts`, then embedded into the render. Native system-font templates intentionally retain their specified fallback stacks. The render itself blocks network requests.
- The app loads lazy, async-decoded images, with fixed dimensions preventing layout shift. No font calls, model invocation, or iframe for the gallery. Each image is under 100 KB; the entire library stays under 2 MB. The sample/detail view uses the same versioned asset.
- The style-change prompt, agent workflow, Apply and Undo are unchanged. A missing image displays an explicit unavailable state rather than inventing a substitute thumbnail.

These covers express one composition per design system, not every possible slide layout or guarantee of an identical model-generated slide. Use **Preview on my deck** for the actual result before Apply.
