# Self-hosting

This is a single-user application. There is no sign-up, no multi-tenancy,
and one master token guards everything. Stand it up for yourself.

## What you need

| | |
|---|---|
| A VM | Runs comfortably on a GCP `e2-micro` (955 MB, always-free tier). See [the deploy notes](../sync/deploy/README.md) for the swap file and Postgres tuning that box needs. |
| Node 26 | The service and both build steps. |
| PostgreSQL 16 | On the same box is fine. |
| A Gmail app password per account | Requires 2FA on the account. Not your Google password. |
| A hostname with TLS | The session cookie is `__Host-`-prefixed, which *requires* HTTPS. It will not work over plain HTTP, including on localhost. |
| A Vercel + Neon account | Only if you want open tracking. Everything else works without it. |

## 1. Database

```bash
sudo -u postgres createuser --pwprompt postbox
sudo -u postgres createdb --owner=postbox postbox_sync
```

The schema is applied by the service at startup, as the `postbox` role.
**Do not apply `schema.sql` by hand as the `postgres` superuser** — that
creates superuser-owned tables the application then cannot write to, and the
failure surfaces much later as confusing permission errors.

## 2. Accounts

```bash
cp sync/accounts.example.json sync/accounts.json
```

One object per mailbox. Exactly one must be `"isPrimary": true` — that is
the identity replies are sent from by default.

```json
[
  { "id": "primary", "email": "you@gmail.com", "appPassword": "…", "isPrimary": true }
]
```

`accounts.json` is gitignored. Keep it that way; it holds credentials that
grant full mailbox access.

## 3. Configuration

```bash
cp sync/.env.example sync/.env
openssl rand -hex 32          # → API_TOKEN
```

`sync/.env.example` documents every variable inline, including why the
service refuses to start with a token shorter than 32 characters rather than
serving real mailboxes unauthenticated.

The VM's `.env` and your local one are **not** meant to match: they hold
different tokens by design, so a leaked development value grants nothing in
production. Never copy one over the other.

## 4. Run it

```bash
cd sync && npm ci && npm start          # the service
cd client && npm ci && npm run build    # writes into sync/public
```

The service serves the built client itself, so there is no second web
server.

## 5. Deploy

```bash
sync/deploy/rollout.sh              # deploys HEAD
sync/deploy/rollout.sh <sha>        # or any ref, which is how you roll back
```

It ships **committed content only** — `git archive`, not your working tree —
and prints the ref plus every uncommitted path it is deliberately leaving
behind before it builds. The one thing git cannot supply is the client
build, which is generated and gitignored, so that is overlaid afterwards.

It tries IAP first and falls back to the instance's external IP. That
fallback exists because the IAP tunnel once failed for hours with the VM
running and everything else healthy; it works only because the default
firewall rule allows SSH from `0.0.0.0/0`. **That rule should be narrowed to
IAP's own range (`35.235.240.0/20`).** Doing so disables the fallback and
makes fixing the IAP path mandatory — which is the correct trade.

## 6. The macOS app (optional)

```bash
cd desktop && npm ci && npm run build
```

It wraps the deployed URL, so it needs the service reachable over HTTPS
first. `tauri.conf.json` holds the origin.

Note that macOS suppresses notification banners while an app is frontmost —
test with the window in the background, or you will conclude notifications
are broken when they are working.

## Tracking (optional)

`tracking/` deploys separately to Vercel Edge with a Neon database. Without
it, mail still sends; you simply get no open events. See `tracking/docs/`
for the measurement work behind the classifier, including what Apple Mail's
Protect Mail Activity does to the signal.
