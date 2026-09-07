import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // src/themes/skp.{js,css,d.ts} are written by `astryx theme build` from
  // skp.ts. They carry a "do not edit manually" banner, so linting them only
  // reports style the generator chose.
  globalIgnores([
    'dist',
    'build',
    'coverage',
    '**/*.min.js',
    'src/themes/skp.js',
    'src/themes/skp.d.ts',
    'src/themes/skp.variants.d.ts',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
