import typography from "@tailwindcss/typography";

/**
 * SKP palette ramps.
 *
 * Roughly 2,450 Tailwind palette utilities across 48 files predate the design
 * system and do not read Astryx tokens. Retinting the ramps here recolours all
 * of them at once, instead of rewriting `WorkspacePage.tsx` (370 usages) and
 * `ChatMessageBubble.tsx` (268) by hand.
 *
 * The values are LITERAL, not `var(--color-*)`, and that is deliberate. There
 * is not a single `dark:` variant in this codebase — dark mode is done with
 * ~330 JS ternaries of the form `isDarkMode ? 'bg-slate-900' : 'bg-white'`. The
 * ternary already picks which END of the ramp to use, so a mode-aware ramp
 * would invert every one of those pairs and paint dark mode light.
 *
 * Each step keeps the lightness of the Tailwind step it replaces, so existing
 * light/dark pairings still separate. The neutral ramp is the interesting one:
 * SKP's ink and SKP's dark surfaces are the same navy hue family, which is what
 * lets one ramp serve `text-slate-900` in light and `bg-slate-900` in dark.
 *
 * This is a bridge, not a licence. New UI still uses Astryx components and
 * `var(--color-*)`; see frontend/.claude/CLAUDE.md.
 */

// Navy-tinted neutrals. 50-300 are the design's surfaces and borders; 800-950
// are the design's dark-mode surfaces, which double as light-mode ink.
const neutral = {
  50: '#f7f9fc',
  100: '#eef2f7',
  200: '#e4e9f0',
  300: '#d5dfeb',
  400: '#97a4b5',
  500: '#708093',
  600: '#5b6b7f',
  700: '#3a4859',
  800: '#26324a',
  900: '#18212f',
  950: '#0f172a',
};

// The interactive blue. 600 is the accent, 700 its pressed state, and 900 is
// the SKP logo's own navy so the ramp ends on the mark.
const blue = {
  50: '#f0f5fb',
  100: '#eaf1fb',
  200: '#cfe0f8',
  300: '#a8c8f0',
  400: '#5f95e0',
  500: '#3b82f6',
  600: '#0b5fd4',
  700: '#0b4fb0',
  800: '#0a4290',
  900: '#133971',
  950: '#0c2853',
};

// Approved
const green = {
  50: '#e7f5ee',
  100: '#d5ecdf',
  200: '#bfe3ce',
  300: '#92d1b0',
  400: '#5fbb8d',
  500: '#3a9e6b',
  600: '#2f8f5b',
  700: '#28794d',
  800: '#1f5c3b',
  900: '#17452c',
  950: '#0d2a1b',
};

// In Review, Awaiting
const amber = {
  50: '#fdf3dd',
  100: '#fbe9c4',
  200: '#f0dcae',
  300: '#ecc978',
  400: '#e0a92e',
  500: '#d29a22',
  600: '#c9911f',
  700: '#b57e15',
  800: '#8f6310',
  900: '#6d4b0d',
  950: '#3d2907',
};

// Failed, locked, destructive
const red = {
  50: '#fbeae6',
  100: '#f7d9d2',
  200: '#f0cabf',
  300: '#e3a695',
  400: '#d2796a',
  500: '#cf6a51',
  600: '#c0563f',
  700: '#a03f2b',
  800: '#813122',
  900: '#63261a',
  950: '#3a150e',
};

// The institutional voice — the government strip, eyebrows, format badges.
// Never "clickable"; that is blue's job.
const teal = {
  50: '#e5f5f4',
  100: '#cfeceb',
  200: '#b8e5e2',
  300: '#7fd4cf',
  400: '#34b8b1',
  500: '#00a89f',
  600: '#00968f',
  700: '#00726d',
  800: '#0f5b57',
  900: '#124744',
  950: '#0f312f',
};

// Reserved for the "Skill" activity type.
const violet = {
  50: '#f3f0fd',
  100: '#efeafc',
  200: '#d3c7f5',
  300: '#b6a4ee',
  400: '#8f76e2',
  500: '#6b4bd4',
  600: '#5c3ec2',
  700: '#4f34a8',
  800: '#402a86',
  900: '#322168',
  950: '#1e1442',
};

// The HTML file glyph.
const orange = {
  50: '#fbf0e3',
  100: '#f7e2c9',
  200: '#eed7ba',
  300: '#e2b585',
  400: '#d69553',
  500: '#c97a2b',
  600: '#b26a23',
  700: '#9c5c1c',
  800: '#7a4716',
  900: '#5c3611',
  950: '#331e09',
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Every neutral name collapses onto one ramp. The codebase reaches for
        // slate 1,521 times and gray 101; they were never meant to differ.
        slate: neutral,
        gray: neutral,
        zinc: neutral,
        neutral: neutral,
        stone: neutral,

        blue,
        sky: blue,
        indigo: blue,

        emerald: green,
        green,

        amber,
        yellow: amber,

        red,
        rose: red,

        teal,
        cyan: teal,

        violet,
        purple: violet,

        orange,
      },
    },
  },
  plugins: [typography],
}
