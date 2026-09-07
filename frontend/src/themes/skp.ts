/**
 * SKP theme — the design language of Suruhanjaya Kredit Pengguna, applied to ARIA.
 *
 * Light values are taken from `claude-design/ARIA-Design-UI/HelpUDoc SKP Redesign.dc.html`.
 * That design is light only, so the dark half comes from its sibling
 * `AI Engine - Dark Theme.dc.html`, which is the same language in dark and already
 * sets Public Sans. Keeping both halves means the existing light/dark toggle and the
 * ~330 `isDarkMode` branches in the app keep working instead of being torn out.
 *
 * The palette has two brand voices. Blue (#0b5fd4) is the interactive one: buttons,
 * links, selection, the send control. Teal (#00968f) is the institutional one: the
 * government strip, eyebrow labels, format badges. They are not interchangeable —
 * teal never means "clickable".
 *
 * Note the SKP logo's own navy is #133971, darker than the #0b5fd4 used here. The
 * design picks the brighter blue on purpose so interactive text clears contrast on a
 * white surface. The logo keeps its own colours; the interface uses these.
 */

import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

export const skpTheme = defineTheme({
  name: 'skp',
  extends: neutralTheme,

  // `typography` replaces the base config outright rather than merging, so the
  // scale and the heading weights have to be restated here even though only the
  // families change.
  //
  // The family is "Public Sans Variable" because that is the name
  // @fontsource-variable/public-sans registers in its @font-face. A static
  // "Public Sans" stays in the fallbacks so a system-installed copy still wins
  // over the platform sans. One variable file covers 400-800, and the design
  // uses the whole range: 800 for headings and uppercase eyebrow labels.
  typography: {
    scale: {base: 14, ratio: 1.2},
    body: {
      family: 'Public Sans Variable',
      fallbacks:
        '"Public Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    },
    heading: {
      family: 'Public Sans Variable',
      fallbacks:
        '"Public Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      weights: {3: 'bold', 4: 'bold'},
    },
    code: {
      family: 'ui-monospace',
      fallbacks:
        '"SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },

  tokens: {
    // =====================================================================
    // Surfaces
    //   light  body #eef2f7 (tinted canvas) < surface/card #ffffff
    //          muted #f4f7fb is the input and search-field fill
    //   dark   body #0f172a < surface #18212f < popover/muted #1e2b45
    // =====================================================================
    '--color-background-body': ['#eef2f7', '#0f172a'],
    '--color-background-surface': ['#ffffff', '#18212f'],
    '--color-background-card': ['#ffffff', '#18212f'],
    '--color-background-popover': ['#ffffff', '#1e2b45'],
    '--color-background-muted': ['#f4f7fb', '#1e2b45'],
    '--color-background-inverted': ['#14263b', '#f1f5f9'],

    // Accent — the interactive blue.
    '--color-accent': ['#0b5fd4', '#3b82f6'],
    '--color-accent-muted': ['#0b5fd41f', '#3b82f63f'],
    '--color-on-accent': '#ffffff',
    '--color-neutral': ['#14263b1a', '#dfe2e533'],

    // Overlays. The scrim is navy-tinted rather than black so it reads as part
    // of the same palette when a dialog sits over the tinted canvas.
    '--color-overlay': ['#14263b66', '#0f172acc'],
    '--color-overlay-hover': ['#14263b0d', '#ffffff0d'],
    '--color-overlay-pressed': ['#14263b1a', '#ffffff1a'],

    // Text. `text-accent` is a step darker than `accent` because accent-coloured
    // body copy on white does not clear AA at #0b5fd4.
    '--color-text-primary': ['#14263b', '#f1f5f9'],
    '--color-text-secondary': ['#5b6b7f', '#8b9bb3'],
    '--color-text-disabled': ['#97a4b5', '#5f6e88'],
    '--color-text-accent': ['#0b4fb0', '#94c5f8'],

    // Icons carry one step more contrast than text at the disabled end, because
    // a 1.7px stroke reads lighter than a glyph at the same value.
    '--color-icon-primary': ['#14263b', '#f1f5f9'],
    '--color-icon-secondary': ['#5b6b7f', '#8b9bb3'],
    '--color-icon-disabled': ['#b6c1cf', '#5f6e88'],
    '--color-icon-accent': ['#0b5fd4', '#3b82f6'],

    // Borders and fills
    '--color-border': ['#e4e9f0', '#26324a'],
    '--color-border-emphasized': ['#d5dfeb', '#5f6e88'],
    '--color-skeleton': ['#d5dfeb', '#26324a'],
    '--color-track': ['#d5dfeb', '#26324a'],
    '--color-shadow': ['rgba(20, 38, 59, 0.16)', 'rgba(0, 0, 0, 0.35)'],

    // =====================================================================
    // Status. These drive the four file states: Draft (gray), In Review
    // (yellow), Approved (green), Published (accent blue).
    // =====================================================================
    '--color-success': ['#3a9e6b', '#4bb87f'],
    '--color-success-muted': ['#3a9e6b33', '#4bb87f3f'],
    '--color-on-success': '#ffffff',
    '--color-warning': ['#e0a92e', '#f2c00b'],
    '--color-warning-muted': ['#e0a92e33', '#e0a92e3f'],
    '--color-on-warning': ['#14263b', '#14263b'],
    '--color-error': ['#c0563f', '#e2735a'],
    '--color-error-muted': ['#c0563f33', '#e2735a3f'],
    '--color-on-error': '#ffffff',
    '--color-background-error-inverted': ['#a3402c', '#c0563f'],

    // =====================================================================
    // Categorical families. Only the ones the design actually uses are
    // retuned; the rest inherit from neutral.
    // =====================================================================

    // Blue — selected rows, published state, artifact chips
    '--color-background-blue': ['#eaf1fb', '#1e2b45'],
    '--color-border-blue': ['#cfe0f8', '#3b82f6'],
    '--color-icon-blue': ['#0b5fd4', '#3b82f6'],
    '--color-text-blue': ['#0b4fb0', '#94c5f8'],

    // Teal — the institutional voice: government strip, eyebrows, badges
    '--color-background-teal': ['#e5f5f4', '#0f312f'],
    '--color-border-teal': ['#b8e5e2', '#22c1b6'],
    '--color-icon-teal': ['#00968f', '#22c1b6'],
    '--color-text-teal': ['#00726d', '#7fe3dc'],

    // Green — Approved
    '--color-background-green': ['#e7f5ee', '#12321f'],
    '--color-border-green': ['#bfe3ce', '#2f8f5b'],
    '--color-icon-green': ['#3a9e6b', '#4bb87f'],
    '--color-text-green': ['#2f8f5b', '#a8e6c1'],

    // Yellow — In Review, Awaiting
    '--color-background-yellow': ['#fdf3dd', '#3a2f12'],
    '--color-border-yellow': ['#f0dcae', '#e0a92e'],
    '--color-icon-yellow': ['#e0a92e', '#f2c00b'],
    '--color-text-yellow': ['#b57e15', '#f5d98a'],

    // Red — Failed, locked, destructive
    '--color-background-red': ['#fbeae6', '#3a1f18'],
    '--color-border-red': ['#f0cabf', '#c0563f'],
    '--color-icon-red': ['#c0563f', '#e2735a'],
    '--color-text-red': ['#a03f2b', '#f3b6a6'],

    // Gray — Draft, Running
    '--color-background-gray': ['#eef1f5', '#26324a'],
    '--color-border-gray': ['#97a4b5', '#5f6e88'],
    '--color-icon-gray': ['#5b6b7f', '#8b9bb3'],
    '--color-text-gray': ['#5b6b7f', '#b6c2d4'],

    // Purple — the "Skill" activity type only
    '--color-background-purple': ['#efeafc', '#241c46'],
    '--color-border-purple': ['#d3c7f5', '#6b4bd4'],
    '--color-icon-purple': ['#6b4bd4', '#a08bec'],
    '--color-text-purple': ['#4f34a8', '#c4b5f5'],

    // Orange — the HTML file glyph
    '--color-background-orange': ['#fbf0e3', '#3a2a18'],
    '--color-border-orange': ['#eed7ba', '#c97a2b'],
    '--color-icon-orange': ['#c97a2b', '#e09a52'],
    '--color-text-orange': ['#9c5c1c', '#f0c396'],

    // Cyan follows teal so the two do not read as separate voices.
    '--color-background-cyan': ['#e5f5f4', '#0f312f'],
    '--color-border-cyan': ['#b8e5e2', '#22c1b6'],
    '--color-icon-cyan': ['#00968f', '#22c1b6'],
    '--color-text-cyan': ['#00726d', '#7fe3dc'],
  },
});

export default skpTheme;
