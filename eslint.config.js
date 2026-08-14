import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**', 'public/samples/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [...tseslint.configs.recommended],
  },
  {
    files: ['scripts/**/*.mjs', 'e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts', 'vitest.config.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { process: 'readonly', window: 'readonly', document: 'readonly' } },
  },
  {
    // Browser code: ES5-flavoured vanilla JS, no bundler.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Promise: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        WebSocket: 'readonly',
        ArrayBuffer: 'readonly',
        Uint8Array: 'readonly',
        createImageBitmap: 'readonly',
        isFinite: 'readonly',
        localStorage: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        HTMLElement: 'readonly',
        KeyboardEvent: 'readonly',
      },
    },
  },
);
