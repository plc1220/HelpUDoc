import typography from '@tailwindcss/typography';
const token = value => () => value;
// Legacy utility declarations resolve through the same Cozy Owl semantic tokens.
const neutral = { 50: 'var(--surface)', 100: 'var(--surface-subtle)', 200: 'var(--border-color)', 300: 'var(--owl-gold)', 400: 'var(--text-secondary)', 500: 'var(--text-secondary)', 600: 'var(--text-primary)', 700: 'var(--text-primary)', 800: 'var(--owl-cocoa)', 900: 'var(--owl-espresso)', 950: 'var(--owl-espresso)' };
const accent = { ...neutral, 50: 'var(--accent-soft)', 100: 'var(--accent-soft)', 200: 'var(--owl-peach)', 300: 'var(--owl-gold)', 400: 'var(--owl-amber)', 500: 'var(--accent)', 600: 'var(--accent)', 700: 'var(--text-primary)', 800: 'var(--text-primary)', 900: 'var(--text-primary)', 950: 'var(--owl-espresso)' };
const neutralText = { 50: 'var(--owl-cream)', 100: 'var(--owl-cream)', 200: 'var(--owl-taupe)', 300: 'var(--owl-gold)', 400: 'var(--text-secondary)', 500: 'var(--text-secondary)', 600: 'var(--text-primary)', 700: 'var(--text-primary)', 800: 'var(--text-primary)', 900: 'var(--text-primary)', 950: 'var(--text-primary)' };
export default {
  darkMode: 'class', content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { colors: { inherit: 'inherit', current: 'currentColor', transparent: 'transparent', white: 'var(--owl-cream)', black: 'var(--owl-espresso)', ...Object.fromEntries(['slate', 'gray', 'zinc', 'neutral', 'stone'].map(key => [key, Object.fromEntries(Object.entries(neutral).map(([shade, value]) => [shade, token(value)]))])), ...Object.fromEntries(['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'].map(key => [key, Object.fromEntries(Object.entries(accent).map(([shade, value]) => [shade, token(value)]))])) }, extend: { textColor: Object.fromEntries(['slate', 'gray', 'zinc', 'neutral', 'stone'].map(key => [key, Object.fromEntries(Object.entries(neutralText).map(([shade, value]) => [shade, token(value)]))])) } },
  plugins: [typography],
};
