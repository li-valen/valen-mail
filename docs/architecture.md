# Architecture

Four deployables. They are separate because they have different failure
modes, different hosting requirements, and — in one case — because putting
them together would break the thing they exist to measure.

```
   Gmail (IMAP/SMTP)
        │
        ▼
   ┌──────────┐        ┌──────────┐        ┌────────────────┐
   │  sync/   │◀──────▶│ Postgres │        │   tracking/    │
   │  (VM)    │        │  (VM)    │        │ Vercel + Neon  │
   └────┬─────┘        └──────────┘        └───────┬────────┘
        │ JSON API                                 │ pixel
        ▼                                          ▼
   ┌──────────┐                             recipient's mail
   │ client/  │  ← PWA, and the page desktop/ wraps
   └──────────┘
```

## `sync/` — the service

Owns every conversation with Gmail and every row in Postgres. The clients
never speak IMAP.

**One IMAP connection per account, and a mutex around it.** Gmail throttles
aggressively, and a second connection to the same mailbox is the fastest way
to get an account temporarily locked out. `KeyedMutex` (`src/imap/`)
serialises per-account work. It is deliberately **not re-entrant**, which is
documented at each call site that could otherwise deadlock by acquiring it
twice.

**IDLE for new mail, backfill for old.** The idle loop listens for the
untagged `EXISTS` event rather than awaiting `idle()`, because imapflow
resolves that promise on its own schedule.

There is a trap here worth knowing about, because it cost a three-minute
notification delay: imapflow caches `mailbox.uidNext`, and an untagged
`EXISTS` during IDLE updates only `mailbox.exists`. `getMailboxLock()`
issues no `SELECT` when the mailbox is already selected, so the cached
ceiling stays stale — and a fetch bounded by it retrieves everything up to
the message *before* the one that woke it. The fix is to bound the range
with IMAP's `*` rather than a cached number.

**A daily byte budget.** `DAILY_BYTE_LIMIT` is 2 GiB per account
(`src/budget.ts`). Reservation is *advisory*: always record what you
actually spent before checking again, or concurrent fetches each see the
same headroom.

**Folders are discovered, never hardcoded.** `\Trash`, `\Junk` and friends
come from the server's special-use flags. `[Gmail]/Trash` is wrong the
moment an account is not English.

**Auth is one master token.** Scripts send `Authorization: Bearer`; browsers
exchange it once at `POST /api/session` for an HttpOnly `__Host-` cookie
that is an HMAC derived from the token and never contains it. The `__Host-`
prefix is load-bearing: it forbids `Domain`, forbids a `Path` other than
`/`, and requires Secure, which together prevent a subdomain from writing a
cookie the app would then trust. Rotating the token invalidates every
session — that is the only bulk revocation, deliberately, since there is no
session store. `POST /api/session` allows 10 failed attempts per 60s; no
other route is limited.

## `client/` — the PWA

React, Vite, Tailwind. Talks only to `sync/`'s JSON API with the session
cookie.

**Message bodies are sandboxed.** `IFRAME_SANDBOX` carries no
`allow-scripts`, so nothing in a message executes — verified across all four
sandbox combinations with the CSP deliberately removed, so the sandbox stood
alone. It *does* carry `allow-same-origin`, which is what lets the parent
measure the frame and size it exactly; that is a separate attribute and not
the boundary. The pairing `allow-scripts allow-same-origin` removes a
sandbox entirely, so `allow-scripts` has its own named guard test.

**No test renders a component.** Anything requiring verification is
extracted into a plain module. Component wiring is checked by reading source
with `?raw` imports and asserting on it — which is why those guards are
paired with synthetic fixtures proving the pattern would catch its own
regression.

## `tracking/` — the pixel

A separate deployment (Vercel Edge + Neon) for one structural reason: **the
thing being measured must not be the thing doing the measuring.** A pixel
served from the same host as the app would be indistinguishable from the
app's own requests, and would go down with it.

One token per recipient, so an open identifies *who*. Placement is binding:
the pixel goes immediately before the quoted original, never inside it —
Gmail collapses quoted text behind a toggle and does not fetch images inside
the collapsed region, so a pixel placed there reports every tracked reply as
unopened, forever, and does it silently.

## `desktop/` — the macOS app

Tauri, wrapping the deployed URL rather than bundling assets. Bundling is
not possible here: the client uses relative API paths, a `__Host-` cookie
that requires a real secure origin, and there is no CORS.

Notifications are posted from Rust, not the page, because the webview cannot
do Web Push — measured, not assumed: `PushManager` is undefined,
`Notification.requestPermission()` resolves `"denied"` with no prompt, and
`showNotification()` throws. The Rust side polls the inbox every 60s,
borrowing the session cookie from WebKit's own store so no credential is
stored anywhere.
