# Web Client Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A installable web client showing one chronological inbox across four Gmail accounts, with a Recent Opens rail and push notifications for both new mail and read events.

**Architecture:** A React PWA built with Vite, served as static files by the existing sync service so the client talks to exactly one origin with one bearer token. The sync service gains an `/api/opens` route that fetches from the tracking service server-side, so the client never learns that two backends exist. Push uses the Web Push standard with self-generated VAPID keys — no Firebase, no Apple developer account, no third-party service.

**Tech Stack:** Vite, React 19, TypeScript, `motion/react`, lucide-react, Web Push (`web-push` on the server, `PushManager` in the browser), served by the existing Node service.

**Spec:** `docs/superpowers/specs/2026-08-23-postbox-spec.md` — sections 7A (design intent), 7A.4 (measured reality, binding on the UI), 5.7 / L1 / L2 / L8 (what tracking can and cannot show).

**Direction:** Chronology (direction A from the picker). The inbox is time-ordered and account-merged; read-state appears as a **side rail**, not as the organising principle. Directions C (Correspondents) and D (Stream-as-home) are explicitly out of scope.

## Global Constraints

- **$0 recurring cost.** No new paid service. Push is Web Push with self-generated VAPID keys — no FCM project, no APNs certificate, no Apple Developer Program. (Spec C1, C3)
- **One origin for the client.** The client calls the sync service only. The sync service reaches the tracking service server-side. No CORS configuration, no second bearer token in the browser.
- **The three read-states are first-class and visually distinct: confirmed / awaiting / unconfirmable.** Roughly half of real opens can never be confirmed (spec L1), and Gmail recipients yield no device data (spec L2). A UI that renders an unconfirmable event as a confirmed read is worse than one with no tracking at all. (Spec 7A.2, 7A.4)
- **Device attribution is empirically ~0%** for these accounts (spec L8). Surface it only where it exists; never show an empty device field as though it were pending.
- **No credential reaches the browser.** The API token is held by the service; the client authenticates by same-origin session, never by embedding a bearer token in JavaScript.
- **iOS Web Push requires the app be added to the Home Screen** — a Safari tab cannot subscribe. The UI must detect this and say so rather than silently failing to subscribe.
- **No TypeScript parameter properties, enums, namespaces, or decorators** in any code the Node service loads — it runs under `node --experimental-strip-types`.
- **Immutability**; errors logged with context, never a credential.
- Files stay focused: 200-400 lines typical, 800 maximum.

---

## File Structure

```
tracking/
  api/opens.ts              authenticated read endpoint (Task 1)

sync/src/
  api/opens.ts              server-side fetch from tracking, one origin (Task 2)
  api/push.ts               subscribe / unsubscribe / dispatch (Task 6)
  push/vapid.ts             key loading, payload signing (Task 6)
  push/dispatch.ts          new-mail and open notifications (Task 7)

client/
  index.html  vite.config.ts  package.json  tsconfig.json
  public/manifest.webmanifest      PWA manifest (Task 3)
  public/sw.js                     service worker: push + notificationclick (Task 6)
  src/
    main.tsx  App.tsx              shell + routing (Task 3)
    api.ts                         typed fetch wrapper (Task 3)
    theme.css                      tokens, both themes (Task 3)
    components/
      InboxList.tsx                chronological unified list (Task 4)
      MessageRow.tsx               one row (Task 4)
      OpensRail.tsx                Recent Opens side rail (Task 5)
      ReadState.tsx                the three-state pill (Task 5)
      PushToggle.tsx               subscribe UI + iOS guidance (Task 6)
```

---

### Task 1: Authenticated read endpoint on the tracking service

**Files:**
- Create: `tracking/api/opens.ts`
- Test: `tracking/tests/opens-endpoint.test.ts`

**Interfaces:**
- Consumes: `lookupToken`-adjacent query access from `tracking/src/db.ts`.
- Produces: `GET /api/opens?limit=50` returning `{ opens: OpenEvent[] }`; `interface OpenEvent { token, recipientEmail, subject, sentAt, occurredAt, classification, deviceClass, os }`.

**Why this task exists:** the tracking service currently has exactly one route — the pixel. The open events it has been recording since Plan 1 are unreadable by anything. This adds the read side.

**Auth:** the same constant-time bearer-token pattern the sync service uses. Reuse `timingSafeEqual`; never `===`. The token is a new `READ_API_TOKEN` env var, distinct from the sync service's, and `startServer`-equivalent behaviour applies: **the route must refuse to serve if the token is absent or under 32 characters**, never default to open.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import handler, { classificationIsConfirmed } from '../api/opens';

const TOKEN = 'r'.repeat(32);
const auth = { authorization: `Bearer ${TOKEN}` };

describe('opens endpoint', () => {
  it('rejects a request with no token', async () => {
    const res = await handler(new Request('https://x/api/opens'));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token of the same length', async () => {
    const res = await handler(new Request('https://x/api/opens', {
      headers: { authorization: `Bearer ${'q'.repeat(32)}` },
    }));
    expect(res.status).toBe(401);
  });

  it('never reports mpp or prefetch as a confirmed read', () => {
    expect(classificationIsConfirmed('open')).toBe(true);
    expect(classificationIsConfirmed('mpp')).toBe(false);
    expect(classificationIsConfirmed('prefetch')).toBe(false);
    expect(classificationIsConfirmed('scanner')).toBe(false);
    expect(classificationIsConfirmed('self')).toBe(false);
  });

  it('clamps an absurd limit', async () => {
    const res = await handler(new Request('https://x/api/opens?limit=999999', { headers: auth }));
    expect([200, 500]).toContain(res.status); // 500 only if no DB in test env
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd tracking && npx vitest run tests/opens-endpoint.test.ts`
Expected: FAIL — `Failed to resolve import "../api/opens"`

- [ ] **Step 3: Implement**

```ts
import { timingSafeEqual } from 'node:crypto';
import { sql_ } from '../src/db';
import type { Classification } from '../src/classify';

export const config = { runtime: 'edge' };

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MIN_TOKEN_LENGTH = 32;

/**
 * Only 'open' is a demonstrated human read. 'mpp' is Apple's proxy fetching
 * images whether or not anyone looked; 'prefetch' is Gmail at delivery;
 * 'scanner' is a corporate gateway; 'self' is the sender's own view. The
 * client renders these as "unconfirmable", never as a read. (Spec 7A.2)
 */
export function classificationIsConfirmed(c: Classification | string): boolean {
  return c === 'open';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function handler(request: Request): Promise<Response> {
  const expected = process.env.READ_API_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    // Fail closed. An absent token must never mean "no auth required" on a
    // route that exposes who opened which of the user's emails.
    console.error('opens: READ_API_TOKEN missing or too short; refusing to serve');
    return json({ error: 'unavailable' }, 503);
  }

  const header = request.headers.get('authorization') ?? '';
  const provided = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
  if (!provided || !tokenMatches(provided, expected)) return json({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    const rows = await sql_()`
      select o.token, t.recipient_email, t.subject, t.sent_at,
             o.occurred_at, o.classification, o.device_class, o.os
      from opens o join tokens t on t.token = o.token
      order by o.occurred_at desc limit ${limit}
    `;
    return json({
      opens: rows.map((r) => ({
        token: r.token,
        recipientEmail: r.recipient_email,
        subject: r.subject,
        sentAt: r.sent_at,
        occurredAt: r.occurred_at,
        classification: r.classification,
        deviceClass: r.device_class,
        os: r.os,
      })),
    });
  } catch (error) {
    console.error('opens: query failed', error);
    return json({ error: 'query failed' }, 500);
  }
}
```

Add `"opens": "/api/opens"` routing in `tracking/vercel.json` if the existing rewrite block requires it, and add `READ_API_TOKEN` to `tracking/.env.example` with a comment on generating one.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/opens-endpoint.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add tracking/api/opens.ts tracking/tests/opens-endpoint.test.ts tracking/.env.example tracking/vercel.json
git commit -m "feat: authenticated read endpoint for open events"
```

---

### Task 2: Sync service proxies opens, so the client sees one origin

**Files:**
- Create: `sync/src/api/opens.ts`
- Modify: `sync/src/api/routes.ts` (add the route)
- Test: `sync/tests/opens-proxy.test.ts`

**Interfaces:**
- Consumes: nothing from the tracking service's code — this is an HTTP call across a network boundary.
- Produces: `fetchOpens(limit: number): Promise<OpenEvent[]>`; the route `GET /api/opens` on the sync service.

**Why:** the client must not hold two base URLs and two tokens. The sync service already authenticates the browser; it holds `TRACKING_BASE_URL` and `TRACKING_READ_TOKEN` server-side and forwards.

**Failure behaviour is the design decision here:** if the tracking service is unreachable, the inbox must still work. The rail degrades to an explicit "opens unavailable" state — it never blocks or errors the whole page.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchOpens } from '../src/api/opens';

describe('fetchOpens', () => {
  it('returns [] and logs when the tracking service is unreachable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await fetchOpens(50, { baseUrl: 'https://t.example', token: 't'.repeat(32), fetchImpl: fetchStub });
    expect(out).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns [] and logs on a non-200 rather than throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const out = await fetchOpens(50, { baseUrl: 'https://t.example', token: 't'.repeat(32), fetchImpl: fetchStub });
    expect(out).toEqual([]);
    spy.mockRestore();
  });

  it('passes the bearer token and never puts it in the URL', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await fetchOpens(50, { baseUrl: 'https://t.example', token: 'z'.repeat(32), fetchImpl: fetchStub });
    const [calledUrl, init] = fetchStub.mock.calls[0];
    expect(String(calledUrl)).not.toContain('z'.repeat(32));
    expect(init.headers.authorization).toBe(`Bearer ${'z'.repeat(32)}`);
  });

  it('clamps the limit it forwards', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await fetchOpens(999999, { baseUrl: 'https://t.example', token: 'z'.repeat(32), fetchImpl: fetchStub });
    expect(String(fetchStub.mock.calls[0][0])).toContain('limit=200');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd sync && npx vitest run tests/opens-proxy.test.ts`
Expected: FAIL — unresolved import `../src/api/opens`

- [ ] **Step 3: Implement**

```ts
const MAX_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 5000;

export interface OpenEvent {
  readonly token: string;
  readonly recipientEmail: string;
  readonly subject: string | null;
  readonly sentAt: string;
  readonly occurredAt: string;
  readonly classification: string;
  readonly deviceClass: string | null;
  readonly os: string | null;
}

export interface FetchOpensDeps {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Reads open events from the tracking service, which is a separate deployment
 * with its own database. Returns [] on ANY failure rather than throwing: the
 * inbox is the primary surface and must not break because the tracking
 * service is down. The rail renders an explicit unavailable state instead.
 */
export async function fetchOpens(limit: number, deps: FetchOpensDeps): Promise<readonly OpenEvent[]> {
  const bounded = Number.isFinite(limit) ? Math.min(Math.max(1, limit), MAX_LIMIT) : 50;
  const doFetch = deps.fetchImpl ?? fetch;
  const url = new URL('/api/opens', deps.baseUrl);
  url.searchParams.set('limit', String(bounded));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${deps.token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`opens: tracking service returned ${response.status}`);
      return [];
    }
    const body = await response.json();
    return Array.isArray(body?.opens) ? body.opens : [];
  } catch (error) {
    console.error('opens: tracking service unreachable', error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
```

Wire `GET /api/opens` into `routes.ts` behind the existing auth gate, reading `TRACKING_BASE_URL` and `TRACKING_READ_TOKEN` from the environment. Add both to `sync/.env.example`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/opens-proxy.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/api/opens.ts sync/src/api/routes.ts sync/tests/opens-proxy.test.ts sync/.env.example
git commit -m "feat: proxy open events so the client sees one origin"
```

---

### Task 3: Client scaffold, theme, and API wrapper

**Files:**
- Create: `client/package.json`, `client/vite.config.ts`, `client/tsconfig.json`, `client/index.html`
- Create: `client/public/manifest.webmanifest`
- Create: `client/src/main.tsx`, `client/src/App.tsx`, `client/src/api.ts`, `client/src/theme.css`
- Test: `client/tests/api.test.ts`

**Interfaces:**
- Produces: `getInbox(limit, before)`, `getOpens(limit)`, `ApiError`; the app shell with an inbox region and a rail region.

**Design tokens — carry these from the accepted direction:** ink `#10151c`, paper `#f6f7f9`, confirmed `#2d6a4f`, awaiting `#b4690e`, unconfirmable `#6b7280`. Type: Bricolage Grotesque (display), IBM Plex Sans (UI), IBM Plex Mono (timestamps and addresses). Define every colour as a token on bare `:root`, redefine only tokens under `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`. A colour defined only inside a media block renders one theme's text on the other theme's ground.

**The manifest must set `display: standalone` and a `start_url`** — on iOS, Web Push requires the app be installed to the Home Screen, and `standalone` is what makes that meaningful.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p client/src/components client/public client/tests
cd client
```

`client/package.json`:

```json
{
  "name": "postbox-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "motion": "^11.15.0",
    "lucide-react": "^0.469.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

`client/vite.config.ts` — build into a directory the sync service serves:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The sync service serves these as static files, which is what keeps the
  // client on ONE origin with the API — no CORS, no second bearer token.
  build: { outDir: '../sync/public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  test: { environment: 'node' },
});
```

`client/public/manifest.webmanifest`:

```json
{
  "name": "Postbox",
  "short_name": "Postbox",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f6f7f9",
  "theme_color": "#10151c",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`client/tests/api.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { getInbox, getOpens, ApiError } from '../src/api';

describe('api wrapper', () => {
  it('throws ApiError with the status on a non-200', async () => {
    const f = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(getInbox(50, null, f)).rejects.toBeInstanceOf(ApiError);
    await expect(getInbox(50, null, f)).rejects.toMatchObject({ status: 401 });
  });

  it('never sends a bearer token from the browser', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await getInbox(50, null, f);
    const init = f.mock.calls[0][1] ?? {};
    const headers = new Headers(init.headers ?? {});
    expect(headers.get('authorization')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });

  it('forwards the before cursor when given one', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await getInbox(25, '2026-08-24T00:00:00Z', f);
    expect(String(f.mock.calls[0][0])).toContain('before=2026-08-24T00%3A00%3A00Z');
  });

  it('getOpens returns [] rather than throwing when the rail is unavailable', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(getOpens(20, f)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm install && npx vitest run tests/api.test.ts`
Expected: FAIL — unresolved import `../src/api`

- [ ] **Step 4: Implement `client/src/api.ts`**

```ts
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * The client authenticates by same-origin credentials, never by embedding a
 * bearer token in JavaScript — anything shipped to the browser is readable by
 * anyone with devtools, and this API fronts four mailboxes.
 */
async function get(path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(path, { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError(response.status, `${path} returned ${response.status}`);
  return response.json();
}

export async function getInbox(limit: number, before: string | null, fetchImpl: typeof fetch = fetch) {
  const url = new URL('/api/inbox', 'http://local');
  url.searchParams.set('limit', String(limit));
  if (before) url.searchParams.set('before', before);
  const body = (await get(url.pathname + url.search, fetchImpl)) as { messages?: unknown[] };
  return Array.isArray(body.messages) ? body.messages : [];
}

/**
 * The rail is secondary to the inbox. If opens are unavailable the inbox must
 * still render, so this resolves to [] rather than rejecting.
 */
export async function getOpens(limit: number, fetchImpl: typeof fetch = fetch) {
  try {
    const body = (await get(`/api/opens?limit=${limit}`, fetchImpl)) as { opens?: unknown[] };
    return Array.isArray(body.opens) ? body.opens : [];
  } catch {
    return [];
  }
}
```

Write `App.tsx` as a two-region shell — inbox left, rail right, collapsing to a single column under 900px — and `theme.css` with the token structure described above.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add client/
git commit -m "feat: client scaffold, theme tokens, and same-origin api wrapper"
```

---

### Task 4: Chronological unified inbox

**Files:**
- Create: `client/src/components/InboxList.tsx`, `client/src/components/MessageRow.tsx`
- Test: `client/tests/inbox.test.ts`

**Interfaces:**
- Consumes: `getInbox` (Task 3).
- Produces: `<InboxList />`; `formatWhen(iso: string, now: Date): string`; `groupByDay(messages): { day: string; messages: Message[] }[]`.

**This is the home view.** Newest first, all four accounts merged, account shown as a small label rather than a filter. Pagination uses the compound cursor the API already supports — pass the last row's `date` as `before`.

**Note the type boundary:** `uid` and `size_bytes` arrive from the API as **strings**, not numbers, because `pg` returns `bigint` columns as strings. Do not do arithmetic on them.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { formatWhen, groupByDay } from '../src/components/InboxList';

const NOW = new Date('2026-08-24T23:30:00Z');

describe('formatWhen', () => {
  it('shows a clock time for today', () => {
    expect(formatWhen('2026-08-24T21:05:00Z', NOW)).toMatch(/^\d{1,2}:\d{2}/);
  });
  it('shows a weekday within the last week', () => {
    expect(formatWhen('2026-08-21T10:00:00Z', NOW)).toMatch(/^[A-Z][a-z]{2}$/);
  });
  it('shows a date beyond a week', () => {
    expect(formatWhen('2026-06-01T10:00:00Z', NOW)).toMatch(/Jun/);
  });
  it('never throws on a null or malformed date', () => {
    expect(() => formatWhen('', NOW)).not.toThrow();
    expect(() => formatWhen('not-a-date', NOW)).not.toThrow();
  });
});

describe('groupByDay', () => {
  it('groups messages under day headers, newest day first', () => {
    const out = groupByDay([
      { uid: '3', date: '2026-08-24T10:00:00Z' },
      { uid: '2', date: '2026-08-24T08:00:00Z' },
      { uid: '1', date: '2026-08-23T22:00:00Z' },
    ] as never);
    expect(out).toHaveLength(2);
    expect(out[0].messages).toHaveLength(2);
  });
  it('puts messages with no date in their own group rather than dropping them', () => {
    const out = groupByDay([{ uid: '1', date: null }] as never);
    expect(out.flatMap((g) => g.messages)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/inbox.test.ts`
Expected: FAIL — unresolved import

- [ ] **Step 3: Implement**

`formatWhen` returns a clock time for today, a weekday inside seven days, and a `MMM D` date beyond that; it returns an em dash for an empty or unparseable input rather than throwing — a message with an unparseable `Date:` header is exactly the case that must not break the list. `groupByDay` buckets by local calendar day, newest first, and gives dateless messages their own trailing group so they are visible rather than silently dropped.

`MessageRow` renders account label, sender, subject, and time on one line with `text-overflow: ellipsis`, and a paperclip icon when `has_attach` is true. `InboxList` renders day headers, handles the empty state with real copy ("Nothing yet — the server syncs the newest 50 messages per account"), and loads more by passing the last row's `date` as `before`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/inbox.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add client/src/components/InboxList.tsx client/src/components/MessageRow.tsx client/tests/inbox.test.ts
git commit -m "feat: chronological unified inbox with day grouping"
```

---

### Task 5: Recent Opens rail

**Files:**
- Create: `client/src/components/OpensRail.tsx`, `client/src/components/ReadState.tsx`
- Test: `client/tests/read-state.test.ts`

**Interfaces:**
- Consumes: `getOpens` (Task 3).
- Produces: `<OpensRail />`, `<ReadState classification={...} />`; `readStateFor(classification: string): { label, tone, title }`.

**This is where the spec's honesty requirement lives.** Three tones, never two:

| classification | label | tone |
|---|---|---|
| `open` | "opened" | confirmed (green) |
| `mpp` | "unconfirmable" | unknown (grey) |
| `prefetch` | "unconfirmable" | unknown (grey) |
| `scanner` | "unconfirmable" | unknown (grey) |
| `self` | *not shown in the rail at all* | — |

`self` events are the user viewing their own Sent folder and must be filtered out entirely — showing them would report the user reading their own mail as a recipient open.

Each row reads *"Yuval Spiegler opened Re: Grays M · 2h ago"*, with device shown **only when present** — device attribution is empirically ~0% for these accounts (spec L8), so an always-empty field must not be rendered as though it were pending.

The rail also needs an explicit **unavailable** state distinct from **empty**: "opens unavailable" when the tracking service could not be reached, versus "no opens yet" when it responded with none. Those mean different things and conflating them hides an outage.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readStateFor, isDisplayable } from '../src/components/ReadState';

describe('readStateFor', () => {
  it('reports only `open` as confirmed', () => {
    expect(readStateFor('open').tone).toBe('confirmed');
  });
  it('reports mpp, prefetch and scanner as unconfirmable, never confirmed', () => {
    for (const c of ['mpp', 'prefetch', 'scanner']) {
      expect(readStateFor(c).tone).toBe('unknown');
      expect(readStateFor(c).label).toBe('unconfirmable');
    }
  });
  it('explains itself on hover for the unconfirmable states', () => {
    expect(readStateFor('mpp').title.toLowerCase()).toContain('apple');
  });
  it('treats an unrecognised classification as unconfirmable, not confirmed', () => {
    expect(readStateFor('something-new').tone).toBe('unknown');
  });
});

describe('isDisplayable', () => {
  it('hides self events — the user viewing their own Sent folder', () => {
    expect(isDisplayable('self')).toBe(false);
  });
  it('shows every other classification', () => {
    for (const c of ['open', 'mpp', 'prefetch', 'scanner']) expect(isDisplayable(c)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/read-state.test.ts`
Expected: FAIL — unresolved import

- [ ] **Step 3: Implement**

The default branch of `readStateFor` must return the **unknown** tone, not confirmed — an unrecognised classification appearing after a future classifier change must degrade to "we can't tell", never to a false green.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/read-state.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add client/src/components/OpensRail.tsx client/src/components/ReadState.tsx client/tests/read-state.test.ts
git commit -m "feat: recent opens rail with three honest read states"
```

---

### Task 6: Web Push — VAPID, service worker, subscription

**Files:**
- Create: `sync/src/push/vapid.ts`, `sync/src/api/push.ts`, `client/public/sw.js`, `client/src/components/PushToggle.tsx`
- Modify: `sync/src/schema.sql` (a `push_subscriptions` table), `sync/src/api/routes.ts`
- Test: `sync/tests/push.test.ts`, `client/tests/push-toggle.test.ts`

**Interfaces:**
- Produces: `POST /api/push/subscribe`, `DELETE /api/push/subscribe`, `GET /api/push/key`; `sendPush(subscription, payload)`.

**No third-party service.** Web Push is a W3C standard: generate a VAPID keypair once, sign a JWT, POST to whatever endpoint the browser hands you. Apple and Google operate the push services, but you never register with either. `web-push` is the one new dependency — it exists to do the ECDSA signing and payload encryption correctly, and hand-rolling that is a poor trade.

**iOS is the constraint that shapes the UI.** Safari only permits `PushManager.subscribe()` from a Home Screen-installed PWA. `PushToggle` must detect `navigator.standalone === false` on iOS and render instructions — *"Share → Add to Home Screen, then open Postbox from there"* — rather than calling `subscribe()` and failing with an opaque error.

- [ ] **Step 1: Generate keys and add the table**

```bash
cd sync && npm install web-push
npx web-push generate-vapid-keys
```

Add both keys to `sync/.env` (never committed) and to `.env.example` as placeholders. Add to `schema.sql`:

```sql
create table if not exists push_subscriptions (
  endpoint    text primary key,
  p256dh      text not null,
  auth        text not null,
  label       text,
  created_at  timestamptz not null default now()
);
```

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { isValidSubscription, shouldPruneOnStatus } from '../src/push/vapid';

describe('isValidSubscription', () => {
  it('accepts a well-formed subscription', () => {
    expect(isValidSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } })).toBe(true);
  });
  it('rejects a missing endpoint, missing keys, or a non-https endpoint', () => {
    expect(isValidSubscription({ keys: { p256dh: 'a', auth: 'b' } })).toBe(false);
    expect(isValidSubscription({ endpoint: 'https://push.example/x' })).toBe(false);
    expect(isValidSubscription({ endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } })).toBe(false);
  });
  it('rejects a non-object without throwing', () => {
    expect(isValidSubscription(null)).toBe(false);
    expect(isValidSubscription('nope')).toBe(false);
  });
});

describe('shouldPruneOnStatus', () => {
  it('prunes a subscription the push service says is gone', () => {
    expect(shouldPruneOnStatus(404)).toBe(true);
    expect(shouldPruneOnStatus(410)).toBe(true);
  });
  it('keeps a subscription on a transient failure', () => {
    expect(shouldPruneOnStatus(429)).toBe(false);
    expect(shouldPruneOnStatus(500)).toBe(false);
    expect(shouldPruneOnStatus(503)).toBe(false);
  });
});
```

- [ ] **Step 3: Run and confirm they fail**

Run: `cd sync && npx vitest run tests/push.test.ts`
Expected: FAIL — unresolved import

- [ ] **Step 4: Implement**

`shouldPruneOnStatus` returning true only for 404 and 410 matters: those mean the browser permanently discarded the subscription, and keeping it means retrying forever. A 429 or 5xx is transient and pruning on it would silently unsubscribe the user's phone.

`client/public/sw.js` handles `push` (show the notification) and `notificationclick` (focus the app and navigate to the message or the rail). Keep it small — a service worker with a bug is hard to evict from an installed PWA.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/push.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add sync/src/push sync/src/api/push.ts sync/src/schema.sql sync/src/api/routes.ts client/public/sw.js client/src/components/PushToggle.tsx sync/tests/push.test.ts
git commit -m "feat: web push subscription with vapid, no third-party service"
```

---

### Task 7: Dispatch both notification kinds

**Files:**
- Create: `sync/src/push/dispatch.ts`
- Modify: `sync/src/imap/pool.ts` (notify on new mail)
- Test: `sync/tests/dispatch.test.ts`

**Interfaces:**
- Consumes: `sendPush` (Task 6), `Db`.
- Produces: `notifyNewMail(messages)`, `notifyOpens(events)`, `buildOpenNotification(event)`, `buildMailNotification(message)`.

**Two kinds, deliberately distinguishable.** New mail is "Zijun Zhou — parse spoken numbers". An open is "Yuval Spiegler opened Re: Grays M". They must not look alike; the whole point of the open notification is that it is a different category of event.

**Only confirmed opens notify.** An `mpp` event must never fire a push — Apple's proxy prefetching an image is not a person reading your email, and a phone buzzing for it would train the user to distrust every notification. The rail shows unconfirmable events; the notification path does not.

**Polling the tracking service:** the sync service checks for new opens on an interval. Keep it modest — every 60 seconds is ample for a personal tool and costs the tracking service almost nothing. Persist the last-seen `occurredAt` so a restart does not re-notify events the user already saw.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildOpenNotification, buildMailNotification, shouldNotifyOpen } from '../src/push/dispatch';

describe('shouldNotifyOpen', () => {
  it('notifies only for a confirmed open', () => {
    expect(shouldNotifyOpen({ classification: 'open' } as never)).toBe(true);
  });
  it('never notifies for mpp, prefetch, scanner or self', () => {
    for (const c of ['mpp', 'prefetch', 'scanner', 'self']) {
      expect(shouldNotifyOpen({ classification: c } as never)).toBe(false);
    }
  });
  it('does not notify for an unrecognised classification', () => {
    expect(shouldNotifyOpen({ classification: 'future-thing' } as never)).toBe(false);
  });
});

describe('notification shape', () => {
  it('an open notification names the person and the subject', () => {
    const n = buildOpenNotification({
      recipientEmail: 'yspiegler@g.harvard.edu', subject: 'Re: Grays M #2',
      classification: 'open', occurredAt: '2026-08-24T21:00:00Z', deviceClass: null, os: null,
    } as never);
    expect(n.title).toContain('opened');
    expect(n.body).toContain('Grays M');
  });
  it('omits device entirely when attribution is unavailable', () => {
    const n = buildOpenNotification({
      recipientEmail: 'a@b.com', subject: 'x', classification: 'open',
      occurredAt: '2026-08-24T21:00:00Z', deviceClass: null, os: null,
    } as never);
    expect(n.body.toLowerCase()).not.toContain('null');
    expect(n.body.toLowerCase()).not.toContain('unknown');
  });
  it('a mail notification is visibly a different kind of event', () => {
    const m = buildMailNotification({ from_name: 'Zijun Zhou', subject: 'parse spoken numbers' } as never);
    expect(m.title).not.toContain('opened');
    expect(m.tag).not.toBe(buildOpenNotification({
      recipientEmail: 'a@b.com', subject: 'x', classification: 'open',
      occurredAt: '2026-08-24T21:00:00Z', deviceClass: null, os: null } as never).tag);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/dispatch.test.ts`
Expected: FAIL — unresolved import

- [ ] **Step 3: Implement**

`shouldNotifyOpen` must return false in its default branch. `buildOpenNotification` appends device context only when `deviceClass` is a non-empty string — never the literal "unknown", which would read as a fact rather than an absence.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/dispatch.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add sync/src/push/dispatch.ts sync/src/imap/pool.ts sync/tests/dispatch.test.ts
git commit -m "feat: push dispatch for new mail and confirmed opens"
```

---

### Task 8: Serve the client and deploy

**Files:**
- Modify: `sync/src/api/routes.ts` (static file serving), `sync/deploy/README.md`

**Interfaces:**
- Produces: the client served from the same origin as the API at `https://postbox-valen.duckdns.org`.

**Serving rules that matter:**
- `/api/*` keeps its existing behaviour and auth. Static serving must not shadow it.
- `sw.js` must be served from the root scope with `Cache-Control: no-cache` — a cached service worker is very hard to evict from an installed PWA.
- Unknown non-API paths return `index.html` so client-side routing works on a hard refresh.
- Static files must not require the bearer token; the API still does.

- [ ] **Step 1: Build the client**

```bash
cd client && npm run build   # outputs into sync/public
```

- [ ] **Step 2: Serve static files from the sync service**

Add static handling to `routes.ts` **after** the `/api/*` branches, so no static path can shadow an API route. Serve `sync/public`, fall back to `index.html`, and set `Cache-Control: no-cache` for `sw.js` and `manifest.webmanifest` specifically.

- [ ] **Step 3: Deploy**

```bash
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
PROJECT=$(cat /tmp/postbox-project)
gcloud compute scp --recurse sync/public postbox:/tmp/public --project="$PROJECT" --zone=us-central1-a
gcloud compute ssh postbox --project="$PROJECT" --zone=us-central1-a --command='
  sudo rm -rf /opt/postbox/sync/public && sudo mv /tmp/public /opt/postbox/sync/public
  sudo chown -R postbox:postbox /opt/postbox/sync/public
  sudo systemctl restart postbox-sync'
```

- [ ] **Step 4: Verify from the public internet**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://postbox-valen.duckdns.org/
curl -s -o /dev/null -w '%{http_code}\n' https://postbox-valen.duckdns.org/sw.js
curl -s https://postbox-valen.duckdns.org/api/health | head -c 200
```

Expected: `200` for the app shell, `200` for the service worker, and the existing health JSON. The API must still require its token — confirm `/api/inbox` without credentials returns 401.

- [ ] **Step 5: Commit**

```bash
git add sync/src/api/routes.ts sync/deploy/README.md
git commit -m "feat: serve the client from the sync service origin"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| 7A direction (chronology home, read-state as rail) | Tasks 4, 5 |
| 7A.2 / 7A.4 three honest read-states | Task 5 (`readStateFor`), Task 7 (`shouldNotifyOpen`) |
| L8 device attribution ~0% — show only when present | Tasks 5, 7 |
| C1 $0 — Web Push, no FCM/APNs/Apple Developer | Task 6 |
| C3 no app store — installable PWA | Task 3 (manifest), Task 6 (iOS guidance) |
| One origin, no browser-held credential | Tasks 2, 3, 8 |

**Deferred by design:** directions C and D as home views; compose and tracked send (Plan 4); a Tauri desktop shell (Plan 5). The rail will be sparse until Plan 4 ships a composer, because opens only exist for mail sent through Postbox — six tracked sends exist today, from calibration.

**Type consistency:** `OpenEvent` is defined once in `sync/src/api/opens.ts` and mirrored structurally in the client. `uid` and `size_bytes` arrive as strings from `pg` and are never used arithmetically. `classification` is a plain string across the network boundary; only `readStateFor` and `shouldNotifyOpen` interpret it, and both default to the safe branch.
