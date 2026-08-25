// `defineConfig` comes from 'vitest/config', not plain 'vite': it re-exports
// the same Vite config function typed with the `test` field merged in, which
// is what lets `tsc --noEmit` accept the `test: {...}` block below.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The sync service serves these as static files, which is what keeps the
  // client on ONE origin with the API — no CORS, no second bearer token.
  build: { outDir: '../sync/public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  // css: true — vitest's own default (`css.include: []`) stubs every CSS
  // import to an empty module, which silently defeats
  // tests/theme-tokens.test.ts's `theme.css?raw` import (see
  // task-3-report.md, "Font subsetting" sibling note on this fix).
  test: { environment: 'node', css: true },
});
