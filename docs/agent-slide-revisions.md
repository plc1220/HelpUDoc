# Agent slide revisions and style browsing

## Correct interaction

| User request | Behavior |
| --- | --- |
| Make it more minimal / add a summary slide | Read the current HTML deck; revise in place; preserve established density and content. |
| Apply Swiss Modern / use the blue style | Apply the specified design to the current deck without new-deck setup. |
| Show alternative styles for this deck | Preview alternatives using existing slide content; ask only the style choice; resume the same revision. |
| Create a separate/new deck | Begin creation deliberately. |
| Several decks are plausible | Ask only which deck to revise. |

Loading frontend-slides supplies implementation knowledge. It is not a reset signal.

## Implemented locally

- Expanded the backend and agent edit classifiers to cover ordinary revision and restyle language with an explicit HTML target or assistant artifact context.
- Excluded user-only output requests and temporary style previews as prior-deck context.
- New-deck intent overrides a revision hint. Reset stale revision flags on fresh turns.
- Synthetic style-choice resumes retain the edit hint and candidate file paths when history is cleared.
- Runtime guidance requires reading the target and preserving its path/content before editing.
- The interaction tool rejects attempts to reopen new-deck setup during a revision. Style comparison remains available.
- The skill distinguishes creation gates from Mode C and read-only browsing.

This is a targeted repair to the current history/trace-based architecture, not a claim of complete semantic intent recognition. Candidate paths must still be verified against workspace files. Local live restyling and subsequent agent editing have been exercised; production validation remains separate.

## Implemented style browser

- Preview / Styles tabs in the center HTML-slide canvas, including the mobile canvas. Other HTML pages do not gain slide controls.
- A lazy-loaded, searchable 34-style catalog with template-specific prerendered sample covers, using explicit color and typography roles from the shipped design specs. No iframe or agent request per gallery card. See `slide-style-thumbnails.md` for provenance, validation and regeneration.
- Preview on my deck launches an existing-deck agent turn with a unique, same-directory `.style-preview-<id>.html` output. The source uses the workspace-relative file **name**, never the backing object-store `path`.
- Runtime tool middleware, guarded builtins and the workspace filesystem backend restrict preview writes to that draft. Scripts, external tools and alternate write paths are blocked. Relative asset references remain valid because the draft sits beside the source; new/shared assets are not modified.
- Comparison uses the actual source and completed agent draft in sandboxed frames. A missing/invalid draft, changed slide count, changed source, running task or read-only workspace prevents applying.
- Apply copies the reviewed draft into the original artifact through the versioned save API with strict optimistic concurrency, even in freeflow collaboration mode. Undo also uses a strict version check. Previous revisions remain in file history.
- Browse all styles in an existing agent style chooser resumes that same interaction with a selected style ID, label and design path. It does not launch a competing preview run or restart the creation gates.
- Ordinary chat edits such as “make it warmer” include the currently open HTML deck as context, unless the user names another file or asks for a new deck.
- The chat API preserves the authoritative current request when history contains only the concise visible chat text. This keeps the protected preview output marker and active-deck context intact; attachments are retained and a new turn never overwrites an older user turn behind an assistant response.

After updating the style pack, run `node frontend/scripts/render-slide-style-thumbnails.mjs`, then `node frontend/scripts/generate-slide-style-catalog.mjs`. Stale image/source hashes fail validation. This is a bundled catalog, not a filesystem-serving endpoint.

### Verification

- Frontend component Playwright tests: browse/search, no generation while browsing, comparison, apply/undo, stale conflict, narrow/light layout, read-only controls, generation failure, and choosing a style in an existing agent interaction.
- Frontend unit tests: catalog provenance, slide detection, same-directory output, explicit edit context, revision checks.
- Python tests: setup-free revisions and preview tool/filesystem protection, including script/interpreter bypass attempts.
- Backend tests: strict-save API validation and propagation, conflict response, and preview context retained through synthetic resumes.
- Frontend production build and backend source-only TypeScript checks. Component browser tests use deterministic mocked agent results; the opt-in live test exercises a real local backend and model.

### Local deployment QC — 2026-09-06

Rebuilt and restarted the local frontend, backend and agent with `env/local/stack.env`, preserving OIDC and all existing data volumes. Main app: `http://localhost:5173`. Backend and agent health checks passed. Signed-in browser QC used a temporary, loopback-only header-auth backend and Vite instance with dedicated non-admin fixture users/workspaces; the normal app's OIDC login was not bypassed or end-to-end tested.

| Before | After | Why |
| --- | --- | --- |
| Current enriched prompt was discarded when visible chat history was supplied; agent invented an unusable preview filename. | Current-turn payload retains the protected output marker and active-deck context, while preserving attachments/history. | The comparison can find the generated draft; follow-up edits target the existing deck. |
| Generated deck startup could throw on `localStorage` inside an opaque-origin iframe. | Each rendered preview receives private, in-memory local/session storage before deck scripts execute. | Prevents blank/partially initialized previews without granting access to app storage or weakening the sandbox. Preview-local edits do not persist. |

Live checks passed: browse 34 styles, search, generate a real three-slide draft, verify original content/version unchanged, compare, Apply, Undo, then edit slide 1 via chat without setup interrupts. Remaining titles, paragraphs and slide count were preserved. Latest completed timing sample: gallery 46 ms, model preview 14.2 s, title edit 6.2 s; other preview runs took 44–56 s. These are local samples, not an SLA. The actual comparison and 390px mobile canvas/gallery were visually inspected; no horizontal overflow or browser errors. Component tests separately cover keyboard/narrow layout, concurrent-edit conflicts, errors/retries and resuming an existing style chooser. Python regression checks: 101 passed; frontend unit checks: 9 passed; component browser checks: 6 passed; live browser flow: 1 passed. Temporary QA services were stopped afterward; fixture data remains locally for inspection.

Run the opt-in live test only against the documented temporary local QA endpoints: `RUN_LOCAL_SLIDE_QC=1 E2E_BASE_URL=http://127.0.0.1:5179 npx playwright test e2e/slide-styles-live-local.spec.ts --project=chromium --workers=1`. It creates dedicated local test users/groups/workspaces and uses a real model; it never selects an existing user's deck. Fresh-deck creation gates and production/OIDC login are outside this smoke test.

### Follow-up boundaries

The first release exposes the 34 indexed bold styles; the separate 12 legacy presets are not yet merged into the catalog. Style comparisons and one-step Undo are held in the current canvas session. Switching files/reloading discards that UI session; generated drafts remain recoverable through Show system files, and applied revisions remain in file history. A durable per-deck preview record would allow comparison recovery after reload. Selected-slide scope and automatic content-equivalence checks beyond slide count are not implemented; users review the complete draft before applying.

## Original design direction / future extensions

The shipped library includes 12 presets in STYLE_PRESETS.md and 34 designs in bold-template-pack/selection-index.json. The latter has names, tags, formality, density, light/dark scheme, and paths to small preview recipes. It does not contain a rendered thumbnail collection.

Future extensions to the initial browser can include:

1. Thumbnail cards, style names, palette and typography samples.
2. Filters for mood, light/dark scheme, formality and density.
3. Side-by-side comparison of up to three choices.
4. **Preview on this deck** to render representative current slides without changing the deck.
5. **Apply to deck** (or selected slides when slide selection exists) to start a revision with explicit artifact and style identifiers.

Browsing itself should be read-only and require no agent invocation. Build sample thumbnails once when a skill version is published, using its preview recipes. Cache by skill version and template slug, paginate the catalog, and lazy-load thumbnails. Do not instantiate 46 live HTML iframes or generate 46 previews on every visit. Label samples as examples; a preview using the user's content is a separate action.

Serve the catalog through the existing authorized skill/version boundary, not an arbitrary filesystem path endpoint. Apply actions should send structured deck identity, current revision, selected style ID, and slide scope. The agent must verify that revision before writing; changing a style should not alter the audience/density choices or silently choose another deck.

For durable continuity beyond retained chat history, store a per-deck state record with artifact ID/path/revision, selected style ID and version, density, current operation, and any pending preview choice. New requests resolve against that record; a gallery choice updates only the pending style operation. Gate progress stays scoped to the operation instead of acting as the identity of the deck.
