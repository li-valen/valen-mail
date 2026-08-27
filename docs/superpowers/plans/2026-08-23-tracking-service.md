# Tracking Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A $0, always-on tracking endpoint that records per-recipient email opens, classifies away prefetch noise, and produces measured false-positive data before any email-client work begins.

**Architecture:** A stateless Vercel Edge function serves a 1x1 PNG at `/o/<token>.png`, resolves the opaque token against Neon Postgres, classifies each hit (self / prefetch / mpp / scanner / open), and records it. Pure functions carry all classification logic so they are unit-testable without network or database.

**Tech Stack:** TypeScript, Vercel Edge Runtime, Neon Postgres (`@neondatabase/serverless` HTTP driver), Vitest, Nodemailer (test harness only).

**Spec:** `docs/superpowers/specs/2026-08-23-postbox-spec.md`

## Global Constraints

- **$0 recurring cost.** Vercel Hobby + Neon free tier only. No domain, no paid plan. (Spec C1)
- **Pixel markup is exactly `<img alt="" src="{PIXEL_BASE}/o/{token}.png">`** — no `width`, `height`, `style`, `class`, or descriptive `alt`; no query-string parameters. (Spec 5.1)
- **Every pixel response sends** `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`, `Pragma: no-cache`, `Expires: 0`. (Spec 5.5)
- **Tokens are random 128-bit hex resolved server-side.** Never encode recipient, account, or message identifiers into the URL. (Spec AD4)
- **Never store a raw recipient IP.** Salted SHA-256 hash only. Location inference is a non-goal. (Spec 7.2)
- **The endpoint always returns the pixel with HTTP 200**, including for unknown tokens and internal errors. A differing status code fingerprints the tracker.
- **Errors are logged, never silently swallowed** — but must not prevent the pixel response.
- **Immutability:** classification functions are pure; never mutate their inputs.
- **`PIXEL_BASE` is a single config value** so a custom domain can replace `*.vercel.app` without a code change. (Spec L4)

---

## File Structure

```
tracking/
  package.json            deps, scripts
  tsconfig.json           strict TypeScript
  vitest.config.ts        test runner config
  .env.example            DATABASE_URL, IP_HASH_SALT, PIXEL_BASE
  src/
    pixel.ts              1x1 PNG bytes + cache-defeating headers  (Task 1)
    token.ts              random token generation + validation     (Task 2)
    ua.ts                 User-Agent -> device class / OS          (Task 3)
    classify.ts           hit classification + dedupe (pure)       (Task 4)
    db.ts                 Neon client, IP hashing, queries         (Task 5)
    schema.sql            tables for tokens / opens / devices      (Task 5)
  api/
    o/[token].ts          the Edge pixel endpoint                  (Task 6)
  scripts/
    send-test.mjs         send a real tracked email                (Task 7)
    report.mjs            classification breakdown report          (Task 7)
  tests/
    pixel.test.ts  token.test.ts  ua.test.ts  classify.test.ts
```

Each `src/` module is a single responsibility with no imports from `api/`, so all logic is testable in isolation.

---

### Task 1: Project scaffold and pixel response

**Files:**
- Create: `tracking/package.json`, `tracking/tsconfig.json`, `tracking/vitest.config.ts`, `tracking/.env.example`
- Create: `tracking/src/pixel.ts`
- Test: `tracking/tests/pixel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PIXEL_BYTES: Uint8Array`, `NO_STORE_HEADERS: Record<string,string>`, `pixelResponse(): Response`.

- [ ] **Step 1: Create the project scaffold**

```bash
mkdir -p tracking/src tracking/api/o tracking/tests tracking/scripts
cd tracking
```

`tracking/package.json`:

```json
{
  "name": "postbox-tracking",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@neondatabase/serverless": "^0.10.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tracking/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "api", "tests"]
}
```

`tracking/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'node' },
});
```

`tracking/.env.example`:

```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
IP_HASH_SALT=replace-with-32-random-bytes-hex
PIXEL_BASE=https://your-project.vercel.app
```

- [ ] **Step 2: Write the failing test**

`tracking/tests/pixel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PIXEL_BYTES, pixelResponse } from '../src/pixel';

describe('pixel', () => {
  it('starts with the PNG signature bytes', () => {
    expect(Array.from(PIXEL_BYTES.slice(0, 8)))
      .toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('declares 1x1 dimensions in its IHDR chunk', () => {
    const view = new DataView(PIXEL_BYTES.buffer, PIXEL_BYTES.byteOffset);
    expect(view.getUint32(16)).toBe(1); // width
    expect(view.getUint32(20)).toBe(1); // height
  });

  it('sends cache-defeating headers so repeat opens are not swallowed', () => {
    const headers = pixelResponse().headers;
    expect(headers.get('cache-control'))
      .toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(headers.get('pragma')).toBe('no-cache');
    expect(headers.get('expires')).toBe('0');
    expect(headers.get('content-type')).toBe('image/png');
  });

  it('responds 200 so the tracker is not fingerprintable by status code', () => {
    expect(pixelResponse().status).toBe(200);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm install && npx vitest run tests/pixel.test.ts`
Expected: FAIL — `Failed to resolve import "../src/pixel"`

- [ ] **Step 4: Write the implementation**

`tracking/src/pixel.ts`:

```ts
/**
 * A 68-byte 1x1 fully transparent RGBA PNG.
 *
 * Invisibility comes from these bytes, NOT from markup. The injected <img>
 * tag deliberately carries no width/height/style/class, because zero
 * dimensions and hidden styling are the primary heuristics tracking-pixel
 * blockers match on. See spec 5.1.
 */
export const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

export const PIXEL_BYTES: Uint8Array = Uint8Array.from(
  atob(PIXEL_PNG_BASE64),
  (char) => char.charCodeAt(0),
);

/**
 * Without these, Gmail's image proxy and Vercel's own CDN cache the
 * response and every open after the first is silently lost. See spec 5.5.
 */
export const NO_STORE_HEADERS: Record<string, string> = {
  'content-type': 'image/png',
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache',
  expires: '0',
};

export function pixelResponse(): Response {
  return new Response(PIXEL_BYTES, { status: 200, headers: NO_STORE_HEADERS });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/pixel.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add tracking/
git commit -m "feat: tracking scaffold and cache-defeating pixel response"
```

---

### Task 2: Opaque token generation

**Files:**
- Create: `tracking/src/token.ts`
- Test: `tracking/tests/token.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `generateToken(): string` (32 lowercase hex chars), `isValidToken(value: string): boolean`.

- [ ] **Step 1: Write the failing test**

`tracking/tests/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateToken, isValidToken } from '../src/token';

describe('generateToken', () => {
  it('returns 32 lowercase hex characters (128 bits)', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat across many calls', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));
    expect(tokens.size).toBe(1000);
  });
});

describe('isValidToken', () => {
  it('accepts a freshly generated token', () => {
    expect(isValidToken(generateToken())).toBe(true);
  });

  it('rejects wrong length, uppercase, non-hex, and path traversal', () => {
    expect(isValidToken('abc')).toBe(false);
    expect(isValidToken('A'.repeat(32))).toBe(false);
    expect(isValidToken('z'.repeat(32))).toBe(false);
    expect(isValidToken('../../etc/passwd')).toBe(false);
    expect(isValidToken('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/token.test.ts`
Expected: FAIL — `Failed to resolve import "../src/token"`

- [ ] **Step 3: Write the implementation**

`tracking/src/token.ts`:

```ts
/**
 * 128 bits of randomness, rendered as hex. The token is opaque: it carries
 * no recipient, account, or message identifier.
 *
 * Mailspring base64-encodes {messageId, accountId, recipient} directly into
 * the URL, which anyone inspecting the pixel can decode — and a forwarded
 * message leaks the original recipient's address. A random token resolved
 * server-side costs one database read and leaks nothing. See spec AD4.
 */
const TOKEN_LENGTH_BYTES = 16;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/token.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add tracking/src/token.ts tracking/tests/token.test.ts
git commit -m "feat: opaque 128-bit tracking tokens"
```

---

### Task 3: User-Agent to device attribution

**Files:**
- Create: `tracking/src/ua.ts`
- Test: `tracking/tests/ua.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DeviceClass = 'desktop' | 'mobile' | 'tablet' | 'unknown'`; `interface DeviceInfo { deviceClass: DeviceClass; os: string | null; client: string | null }`; `parseUserAgent(ua: string): DeviceInfo`.

**Note:** Gmail recipients arrive proxied with no device signal. The correct output is `unknown`, never a guess. See spec 5.7 and L2.

- [ ] **Step 1: Write the failing test**

`tracking/tests/ua.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseUserAgent } from '../src/ua';

describe('parseUserAgent', () => {
  it('reports unknown for Gmail proxy fetches rather than guessing', () => {
    const ua = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 '
      + '(via ggpht.com GoogleImageProxy)';
    expect(parseUserAgent(ua)).toEqual({
      deviceClass: 'unknown', os: null, client: 'Gmail (proxied)',
    });
  });

  it('reports unknown for an empty User-Agent', () => {
    expect(parseUserAgent('')).toEqual({
      deviceClass: 'unknown', os: null, client: null,
    });
  });

  it('identifies iPhone as mobile running iOS', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    const info = parseUserAgent(ua);
    expect(info.deviceClass).toBe('mobile');
    expect(info.os).toBe('iOS');
  });

  it('identifies iPad as a tablet', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(parseUserAgent(ua).deviceClass).toBe('tablet');
  });

  it('distinguishes Android phone from Android tablet by the Mobile token', () => {
    const phone = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
    const tablet = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    expect(parseUserAgent(phone).deviceClass).toBe('mobile');
    expect(parseUserAgent(tablet).deviceClass).toBe('tablet');
  });

  it('identifies Outlook desktop', () => {
    const ua = 'Microsoft Outlook 16.0 (Windows NT 10.0)';
    const info = parseUserAgent(ua);
    expect(info.deviceClass).toBe('desktop');
    expect(info.client).toBe('Outlook');
    expect(info.os).toBe('Windows');
  });

  it('identifies macOS Apple Mail by an AppleWebKit UA with no Version token', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const info = parseUserAgent(ua);
    expect(info.deviceClass).toBe('desktop');
    expect(info.os).toBe('macOS');
    expect(info.client).toBe('Apple Mail');
  });

  it('does not label desktop Safari as Apple Mail', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    expect(parseUserAgent(ua).client).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ua.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ua"`

- [ ] **Step 3: Write the implementation**

`tracking/src/ua.ts`:

```ts
export type DeviceClass = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export interface DeviceInfo {
  readonly deviceClass: DeviceClass;
  readonly os: string | null;
  readonly client: string | null;
}

const UNKNOWN: DeviceInfo = { deviceClass: 'unknown', os: null, client: null };

/**
 * Apple Mail presents an AppleWebKit UA carrying neither a Version/ nor a
 * Safari/ token; real Safari always carries both.
 */
function appleMailClient(ua: string): string | null {
  const isWebKit = ua.includes('AppleWebKit');
  const isBrowser = ua.includes('Version/') || ua.includes('Safari/');
  return isWebKit && !isBrowser ? 'Apple Mail' : null;
}

export function parseUserAgent(ua: string): DeviceInfo {
  if (!ua) return UNKNOWN;

  // Gmail proxies every image fetch. There is no device signal to recover;
  // reporting "unknown" honestly beats guessing. See spec 5.7 / L2.
  if (ua.includes('GoogleImageProxy')) {
    return { deviceClass: 'unknown', os: null, client: 'Gmail (proxied)' };
  }

  if (ua.includes('Microsoft Outlook')) {
    return {
      deviceClass: 'desktop',
      os: ua.includes('Macintosh') ? 'macOS' : 'Windows',
      client: 'Outlook',
    };
  }

  if (/iPhone|iPod/.test(ua)) {
    return { deviceClass: 'mobile', os: 'iOS', client: appleMailClient(ua) };
  }

  if (ua.includes('iPad')) {
    return { deviceClass: 'tablet', os: 'iPadOS', client: appleMailClient(ua) };
  }

  if (ua.includes('Android')) {
    return {
      deviceClass: ua.includes('Mobile') ? 'mobile' : 'tablet',
      os: 'Android',
      client: null,
    };
  }

  if (/Macintosh|Mac OS X/.test(ua)) {
    return { deviceClass: 'desktop', os: 'macOS', client: appleMailClient(ua) };
  }

  if (ua.includes('Windows NT')) {
    return { deviceClass: 'desktop', os: 'Windows', client: null };
  }

  if (ua.includes('Linux')) {
    return { deviceClass: 'desktop', os: 'Linux', client: null };
  }

  return UNKNOWN;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ua.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add tracking/src/ua.ts tracking/tests/ua.test.ts
git commit -m "feat: user-agent device attribution with honest unknowns"
```

---

### Task 4: Hit classification

**Files:**
- Create: `tracking/src/classify.ts`
- Test: `tracking/tests/classify.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; deliberately independent of `ua.ts`).
- Produces: `type Classification = 'self' | 'prefetch' | 'mpp' | 'scanner' | 'open'`; `interface HitContext`; `classifyHit(ctx: HitContext): Classification`; `isDuplicate(occurredAt: number, recentHitTimes: readonly number[]): boolean`; constants `PREFETCH_WINDOW_MS`, `DEDUPE_WINDOW_MS`, `SCANNER_BURST_COUNT`, `SCANNER_BURST_WINDOW_MS`.

**Ordering is load-bearing:** self, then prefetch, then scanner, then MPP, then open. Every branch must be reachable, so do not reorder.

- [ ] **Step 1: Write the failing test**

`tracking/tests/classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyHit, isDuplicate, type HitContext } from '../src/classify';

const SENT_AT = 1_700_000_000_000;

function hit(overrides: Partial<HitContext> = {}): HitContext {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36',
    ip: '203.0.113.7',
    occurredAt: SENT_AT + 60_000,
    sentAt: SENT_AT,
    senderIps: ['198.51.100.1'],
    recentHitTimes: [],
    ...overrides,
  };
}

describe('classifyHit', () => {
  it('classifies a normal later fetch as a real open', () => {
    expect(classifyHit(hit())).toBe('open');
  });

  it('suppresses the sender viewing their own Sent folder', () => {
    expect(classifyHit(hit({ ip: '198.51.100.1' }))).toBe('self');
  });

  it('suppresses a Gmail proxy fetch within the prefetch window', () => {
    const ua = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)';
    expect(classifyHit(hit({ userAgent: ua, occurredAt: SENT_AT + 2_000 })))
      .toBe('prefetch');
  });

  it('counts a Gmail proxy fetch long after send as a real open', () => {
    const ua = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)';
    expect(classifyHit(hit({ userAgent: ua, occurredAt: SENT_AT + 3_600_000 })))
      .toBe('open');
  });

  it('flags known corporate gateway scanners by user agent', () => {
    expect(classifyHit(hit({ userAgent: 'Mimecast Ltd Scanner' }))).toBe('scanner');
    expect(classifyHit(hit({ userAgent: 'Proofpoint-URL-Defense/2' }))).toBe('scanner');
  });

  it('flags a rapid burst on one token as a scanner', () => {
    const now = SENT_AT + 60_000;
    const burst = [now - 500, now - 1_200, now - 2_000];
    expect(classifyHit(hit({ occurredAt: now, recentHitTimes: burst }))).toBe('scanner');
  });

  it('labels Apple MPP prefetch rather than counting it as an open', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(classifyHit(hit({ userAgent: ua }))).toBe('mpp');
  });

  it('labels any fetch from Apple owned address space as MPP', () => {
    expect(classifyHit(hit({ ip: '17.58.12.9' }))).toBe('mpp');
  });

  it('prefers self over every other classification', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    expect(classifyHit(hit({ ip: '198.51.100.1', userAgent: ua }))).toBe('self');
  });
});

describe('isDuplicate', () => {
  it('collapses a repeat hit inside the dedupe window', () => {
    expect(isDuplicate(SENT_AT + 5_000, [SENT_AT + 1_000])).toBe(true);
  });

  it('accepts a hit outside the dedupe window', () => {
    expect(isDuplicate(SENT_AT + 60_000, [SENT_AT + 1_000])).toBe(false);
  });

  it('accepts the first ever hit on a token', () => {
    expect(isDuplicate(SENT_AT + 1_000, [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/classify.test.ts`
Expected: FAIL — `Failed to resolve import "../src/classify"`

- [ ] **Step 3: Write the implementation**

`tracking/src/classify.ts`:

```ts
export type Classification = 'self' | 'prefetch' | 'mpp' | 'scanner' | 'open';

/** A Gmail proxy fetch this soon after send is delivery prefetch, not a read. */
export const PREFETCH_WINDOW_MS = 10_000;
/** Repeat hits on one token inside this window collapse to a single event. */
export const DEDUPE_WINDOW_MS = 10_000;
export const SCANNER_BURST_COUNT = 3;
export const SCANNER_BURST_WINDOW_MS = 5_000;

/** Apple owns 17.0.0.0/8 outright. */
const APPLE_NET_PREFIX = '17.';

const SCANNER_UA_PATTERNS: readonly RegExp[] = [
  /Mimecast/i, /Proofpoint/i, /Barracuda/i, /SafeLinks/i,
  /Symantec/i, /Forcepoint/i, /TrendMicro/i, /MessageLabs/i,
];

export interface HitContext {
  readonly userAgent: string;
  readonly ip: string;
  readonly occurredAt: number;
  readonly sentAt: number;
  readonly senderIps: readonly string[];
  /** Prior hit timestamps for this same token. */
  readonly recentHitTimes: readonly number[];
}

/**
 * Apple Mail Privacy Protection prefetches images for every message a user
 * receives, whether or not they read it. Apple Mail is roughly half of all
 * email opens, so counting these as reads is the single largest source of
 * false positives in any tracking product. See spec L1.
 *
 * MPP fetches present an AppleWebKit UA carrying neither a Version/ nor a
 * Safari/ token. This heuristic needs calibration against the real-world
 * data Task 7 collects.
 */
export function isApplePrivacyProxy(ua: string, ip: string): boolean {
  if (ip.startsWith(APPLE_NET_PREFIX)) return true;
  const isWebKit = ua.includes('AppleWebKit');
  const isBrowser = ua.includes('Version/') || ua.includes('Safari/');
  return isWebKit && !isBrowser;
}

function isScannerBurst(ctx: HitContext): boolean {
  const recent = ctx.recentHitTimes.filter(
    (time) => ctx.occurredAt - time < SCANNER_BURST_WINDOW_MS,
  );
  return recent.length >= SCANNER_BURST_COUNT;
}

export function classifyHit(ctx: HitContext): Classification {
  if (ctx.senderIps.includes(ctx.ip)) return 'self';

  const ageSinceSend = ctx.occurredAt - ctx.sentAt;
  if (ctx.userAgent.includes('GoogleImageProxy') && ageSinceSend < PREFETCH_WINDOW_MS) {
    return 'prefetch';
  }

  if (SCANNER_UA_PATTERNS.some((pattern) => pattern.test(ctx.userAgent))) return 'scanner';
  if (isScannerBurst(ctx)) return 'scanner';
  if (isApplePrivacyProxy(ctx.userAgent, ctx.ip)) return 'mpp';

  return 'open';
}

export function isDuplicate(
  occurredAt: number,
  recentHitTimes: readonly number[],
): boolean {
  return recentHitTimes.some((time) => occurredAt - time < DEDUPE_WINDOW_MS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/classify.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add tracking/src/classify.ts tracking/tests/classify.test.ts
git commit -m "feat: classify pixel hits into self/prefetch/mpp/scanner/open"
```

---

### Task 5: Database schema and queries

**Files:**
- Create: `tracking/src/schema.sql`
- Create: `tracking/src/db.ts`

**Interfaces:**
- Consumes: `Classification` from `src/classify.ts`, `DeviceInfo` from `src/ua.ts`.
- Produces: `hashIp(ip: string, salt: string): Promise<string>`; `lookupToken(token: string): Promise<TokenRow | null>`; `recentHitTimes(token: string, sinceMs: number): Promise<number[]>`; `recordOpen(input: RecordOpenInput): Promise<void>`; `interface TokenRow { token, accountId, messageId, threadId, recipientEmail, subject, sentAt, senderIp }`.

**No unit tests for this task** — it is a thin database adapter with no branching logic. It is exercised end to end by Task 7 against real Neon.

- [ ] **Step 1: Write the schema**

`tracking/src/schema.sql`:

```sql
create table if not exists tokens (
  token           text primary key,
  account_id      text not null,
  message_id      text not null,
  thread_id       text,
  recipient_email text not null,
  subject         text,
  sent_at         timestamptz not null default now(),
  sender_ip       text
);
create index if not exists tokens_account_sent on tokens (account_id, sent_at desc);

create table if not exists opens (
  id             bigserial primary key,
  token          text not null references tokens(token) on delete cascade,
  occurred_at    timestamptz not null default now(),
  classification text not null,
  user_agent     text,
  device_class   text,
  os             text,
  raw_ip_hash    text
);
create index if not exists opens_token_time on opens (token, occurred_at desc);
create index if not exists opens_recent on opens (occurred_at desc)
  where classification = 'open';

create table if not exists devices (
  id         bigserial primary key,
  endpoint   text unique not null,
  p256dh     text not null,
  auth       text not null,
  label      text,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Apply the schema to Neon**

Create a free Neon project at https://neon.tech, copy its connection string into `tracking/.env` as `DATABASE_URL`, then:

```bash
psql "$DATABASE_URL" -f tracking/src/schema.sql
```

Expected: `CREATE TABLE` / `CREATE INDEX` with no errors.

- [ ] **Step 3: Write the database adapter**

`tracking/src/db.ts`:

```ts
import { neon } from '@neondatabase/serverless';
import type { Classification } from './classify';
import type { DeviceInfo } from './ua';

const sql = neon(process.env.DATABASE_URL ?? '');

export interface TokenRow {
  readonly token: string;
  readonly accountId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly recipientEmail: string;
  readonly subject: string | null;
  readonly sentAt: number;
  readonly senderIp: string | null;
}

export interface RecordOpenInput {
  readonly token: string;
  readonly occurredAt: number;
  readonly classification: Classification;
  readonly userAgent: string;
  readonly device: DeviceInfo;
  readonly ipHash: string;
}

/**
 * Raw recipient IPs are never persisted. Superhuman shipped IP-derived
 * location, took public backlash in 2019, removed the feature and deleted
 * the historical data. See spec 7.2.
 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function lookupToken(token: string): Promise<TokenRow | null> {
  const rows = await sql`
    select token, account_id, message_id, thread_id,
           recipient_email, subject, sent_at, sender_ip
    from tokens where token = ${token}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    token: row.token,
    accountId: row.account_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    sentAt: new Date(row.sent_at).getTime(),
    senderIp: row.sender_ip,
  };
}

export async function recentHitTimes(token: string, sinceMs: number): Promise<number[]> {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = await sql`
    select occurred_at from opens
    where token = ${token} and occurred_at > ${cutoff}
    order by occurred_at desc limit 50
  `;
  return rows.map((row) => new Date(row.occurred_at).getTime());
}

export async function recordOpen(input: RecordOpenInput): Promise<void> {
  await sql`
    insert into opens
      (token, occurred_at, classification, user_agent, device_class, os, raw_ip_hash)
    values (
      ${input.token}, ${new Date(input.occurredAt).toISOString()},
      ${input.classification}, ${input.userAgent},
      ${input.device.deviceClass}, ${input.device.os}, ${input.ipHash}
    )
  `;
}
```

- [ ] **Step 4: Verify connectivity**

```bash
node --env-file=tracking/.env -e "
  const { neon } = require('@neondatabase/serverless');
  neon(process.env.DATABASE_URL)\`select count(*) from tokens\`
    .then(r => console.log('tokens:', r[0].count));
"
```

Expected: `tokens: 0`

- [ ] **Step 5: Commit**

```bash
git add tracking/src/schema.sql tracking/src/db.ts
git commit -m "feat: neon schema and tracking query adapter"
```

---

### Task 6: The Edge pixel endpoint

**Files:**
- Create: `tracking/api/o/[token].ts`
- Create: `tracking/vercel.json`

**Interfaces:**
- Consumes: `pixelResponse` (Task 1), `isValidToken` (Task 2), `parseUserAgent` (Task 3), `classifyHit` / `isDuplicate` / `DEDUPE_WINDOW_MS` (Task 4), `lookupToken` / `recentHitTimes` / `recordOpen` / `hashIp` (Task 5).
- Produces: the deployed `GET {PIXEL_BASE}/o/<token>.png` route.

**Binding behaviour:** the handler returns the identical pixel with HTTP 200 in every case — valid token, unknown token, malformed token, database outage. Any variation in status, body, or timing lets a recipient fingerprint the tracker. Errors are logged, never surfaced.

- [ ] **Step 1: Write the endpoint**

`tracking/api/o/[token].ts`:

```ts
import { pixelResponse } from '../../src/pixel';
import { isValidToken } from '../../src/token';
import { parseUserAgent } from '../../src/ua';
import { classifyHit, isDuplicate, DEDUPE_WINDOW_MS } from '../../src/classify';
import { lookupToken, recentHitTimes, recordOpen, hashIp } from '../../src/db';

export const config = { runtime: 'edge' };

function extractToken(url: string): string | null {
  const match = new URL(url).pathname.match(/\/o\/([^/]+)\.png$/);
  return match?.[1] ?? null;
}

async function record(request: Request): Promise<void> {
  const token = extractToken(request.url);
  if (!token || !isValidToken(token)) return;

  const row = await lookupToken(token);
  if (!row) return;

  const occurredAt = Date.now();
  const priorHits = await recentHitTimes(token, DEDUPE_WINDOW_MS);
  if (isDuplicate(occurredAt, priorHits)) return;

  const userAgent = request.headers.get('user-agent') ?? '';
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';

  const classification = classifyHit({
    userAgent,
    ip,
    occurredAt,
    sentAt: row.sentAt,
    senderIps: row.senderIp ? [row.senderIp] : [],
    recentHitTimes: priorHits,
  });

  await recordOpen({
    token,
    occurredAt,
    classification,
    userAgent,
    device: parseUserAgent(userAgent),
    ipHash: await hashIp(ip, process.env.IP_HASH_SALT ?? ''),
  });
}

export default async function handler(request: Request): Promise<Response> {
  try {
    await record(request);
  } catch (error) {
    // The image must render regardless. Log for diagnosis, but never let a
    // failure change the response — a differing status or latency profile
    // would let a recipient fingerprint the tracker.
    console.error('tracking: failed to record hit', error);
  }
  return pixelResponse();
}
```

`tracking/vercel.json`:

```json
{ "rewrites": [{ "source": "/o/:token.png", "destination": "/api/o/:token" }] }
```

- [ ] **Step 2: Deploy to Vercel**

```bash
cd tracking && npx vercel --prod
```

Then in the Vercel dashboard set `DATABASE_URL` and `IP_HASH_SALT` as environment variables, and redeploy. Record the assigned `*.vercel.app` origin as `PIXEL_BASE`.

- [ ] **Step 3: Verify the endpoint end to end**

```bash
curl -si "$PIXEL_BASE/o/$(openssl rand -hex 16).png" | head -20
```

Expected: `HTTP/2 200`, `content-type: image/png`, `cache-control: no-store, no-cache, must-revalidate, max-age=0`, and a 68-byte body — for an unknown token, proving unknown tokens are indistinguishable from real ones.

- [ ] **Step 4: Commit**

```bash
git add tracking/api tracking/vercel.json
git commit -m "feat: edge pixel endpoint with constant-response behaviour"
```

---

### Task 7: Live measurement harness

**Files:**
- Create: `tracking/scripts/send-test.mjs`
- Create: `tracking/scripts/report.mjs`
- Create: `tracking/docs/measurement-results.md`

**Interfaces:**
- Consumes: `generateToken` (Task 2), the deployed endpoint (Task 6), the `tokens` table (Task 5).
- Produces: `docs/measurement-results.md` — the measured false-positive rate that Success Criterion 7 requires and that gates every later plan.

**This task is the point of the whole plan.** It answers empirically whether tracking carries signal against the user's real contacts before any email-client work begins.

- [ ] **Step 1: Write the send script**

`tracking/scripts/send-test.mjs`:

```js
import nodemailer from 'nodemailer';
import { neon } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';

const [recipient, label] = process.argv.slice(2);
if (!recipient) {
  console.error('usage: node scripts/send-test.mjs <recipient> [label]');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const token = randomBytes(16).toString('hex');
const messageId = `test-${Date.now()}@postbox.local`;
const subject = `Valen Mail tracking test — ${label ?? recipient}`;

await sql`
  insert into tokens (token, account_id, message_id, recipient_email, subject, sender_ip)
  values (${token}, ${process.env.GMAIL_USER}, ${messageId}, ${recipient},
          ${subject}, ${process.env.SENDER_IP ?? null})
`;

// Markup is exactly as spec 5.1 requires: no width, height, style, class, or
// descriptive alt. Those attributes are what pixel blockers match on.
const html = `<p>Tracking calibration test. Please open this once, normally, `
  + `then reply "done".</p><img alt="" src="${process.env.PIXEL_BASE}/o/${token}.png">`;

const transport = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

await transport.sendMail({
  from: process.env.GMAIL_USER, to: recipient, subject, html,
  messageId: `<${messageId}>`,
});

console.log(`sent to ${recipient}\n  token ${token}\n  pixel ${process.env.PIXEL_BASE}/o/${token}.png`);
```

- [ ] **Step 2: Write the report script**

`tracking/scripts/report.mjs`:

```js
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const rows = await sql`
  select t.recipient_email, t.subject, t.sent_at,
         o.occurred_at, o.classification, o.device_class, o.os, o.user_agent
  from tokens t left join opens o on o.token = t.token
  order by t.sent_at desc, o.occurred_at asc
`;

const byClass = {};
for (const row of rows) {
  if (!row.classification) continue;
  byClass[row.classification] = (byClass[row.classification] ?? 0) + 1;
}

console.log('\nClassification breakdown');
console.table(byClass);

const total = Object.values(byClass).reduce((a, b) => a + b, 0);
const noise = total - (byClass.open ?? 0);
console.log(`\nfalse-positive share: ${total ? ((noise / total) * 100).toFixed(1) : '0.0'}% `
  + `(${noise}/${total} hits suppressed or labelled)\n`);

console.table(rows.map((r) => ({
  to: r.recipient_email,
  sent: r.sent_at,
  opened: r.occurred_at ?? '—',
  class: r.classification ?? 'no hits',
  device: r.device_class ?? '—',
  os: r.os ?? '—',
})));
```

Install the one dependency:

```bash
cd tracking && npm install nodemailer
```

- [ ] **Step 3: Run the calibration matrix**

Send one message to each mail client you actually correspond with. Use a distinct label per target. Generate an app password at https://myaccount.google.com/apppasswords first, and put `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `tracking/.env`.

```bash
cd tracking
node --env-file=.env scripts/send-test.mjs you@gmail.com        "gmail-web"
node --env-file=.env scripts/send-test.mjs you@gmail.com        "gmail-ios-app"
node --env-file=.env scripts/send-test.mjs you@icloud.com       "apple-mail-ios"
node --env-file=.env scripts/send-test.mjs you@outlook.com      "outlook-web"
node --env-file=.env scripts/send-test.mjs friend@example.com   "real-contact"
```

Open each on the intended client exactly once. Wait 24 hours so delayed prefetches and scanners land, then:

```bash
node --env-file=.env scripts/report.mjs
```

- [ ] **Step 4: Record the findings**

Write `tracking/docs/measurement-results.md` capturing, per target client: whether the open registered at all, the classification assigned, whether device attribution succeeded, how many spurious hits arrived, and the overall false-positive share.

Then answer these three questions explicitly in that file:

1. **Did any true open go unrecorded?** If a real open never fired, images are blocked for that client and tracking cannot see it (spec L3).
2. **Was any true open misclassified as `mpp`, `prefetch`, or `scanner`?** If so, tune the constants in `src/classify.ts` and note the change. The MPP heuristic in particular is explicitly flagged in that file as needing calibration.
3. **Is the signal worth building a client around?** If the false-positive share is high and device attribution mostly returns `unknown` because your contacts are on Gmail, say so plainly. That finding is a legitimate and valuable outcome of this plan.

- [ ] **Step 5: Commit**

```bash
git add tracking/scripts tracking/docs/measurement-results.md tracking/package.json
git commit -m "feat: live tracking measurement harness and calibration results"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 5.1 pixel markup | Task 1 (bytes), Task 7 (exact tag in the send script) |
| 5.4 open classification | Task 4 |
| 5.5 cache headers | Task 1 |
| 5.7 device attribution | Task 3 |
| §6 data model | Task 5 |
| 7.2 no raw IP | Task 5 (`hashIp`) |
| 7.5 endpoint sees no content | Task 6 |
| AD4 opaque tokens | Task 2 |
| Success Criterion 7 | Task 7 |

**Deferred to later plans by design:** 5.2 pixel placement before `.gmail_quote`, 5.3 per-recipient bodies, 5.6 pixel stripping and the third-party blocklist, and 7.1 HTML sanitization all belong to Plan 4 (compose and tracked send), which owns the composer. They are spec requirements with no task here, and that is intentional — this plan ships no composer.

**Type consistency:** `Classification` is defined once in `classify.ts` and imported by `db.ts` and the endpoint. `DeviceInfo` is defined once in `ua.ts` and imported by `db.ts`. `TokenRow.sentAt` is a millisecond number everywhere, converted at the database boundary in `lookupToken`. `HitContext.recentHitTimes` and the return of `recentHitTimes()` are both `number[]` in milliseconds.

**Placeholder scan:** no TBDs; every code step carries complete runnable content.
