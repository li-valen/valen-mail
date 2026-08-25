// `defineConfig` comes from 'vitest/config', not plain 'vite': it re-exports
// the same Vite config function typed with the `test` field merged in, which
// is what lets `tsc --noEmit` accept the `test: {...}` block below.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// Tailwind v4 as a Vite plugin rather than a PostCSS config: this is a Vite
// app, the plugin is the first-party path, and it means no postcss.config.js
// and no @tailwindcss/postcss in the dependency list.
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The sync service serves these as static files, which is what keeps the
  // client on ONE origin with the API — no CORS, no second bearer token.
  build: { outDir: '../sync/public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  // css: true — vitest's own default (`css.include: []`) stubs every CSS
  // import to an empty module. Nothing under src/ imports a stylesheet by
  // path any more (Tailwind replaced the per-component CSS files), but
  // tests/theme-tokens.test.ts still reads src/styles.css via `?raw`, and
  // leaving this on keeps that independent of how vitest treats CSS.
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
