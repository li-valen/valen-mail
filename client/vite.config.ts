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
  //
  // env.TZ pins the test run to UTC (task-4-brief.md Amendment 2).
  // tests/inbox.test.ts's groupByDay fixtures (Aug 24 10:00Z / 08:00Z vs
  // Aug 23 22:00Z) group as 2+1 in UTC and US Eastern, but collapse into a
  // single group at UTC+3 and eastward — a suite that is green here and
  // red on another machine, or in CI, for a reason nobody would think to
  // look for. Pinning the zone (rather than trusting whatever machine runs
  // `npm test`) is what makes local-calendar-day grouping deterministic.
  test: { environment: 'node', css: true, env: { TZ: 'UTC' } },
});
