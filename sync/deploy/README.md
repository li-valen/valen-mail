# Deploying the sync service to the VM

Target instance (GCP always-free tier):

```
project: postbox-sync-11903
name:    postbox
zone:    us-central1-a
machine: e2-micro — 955 MB RAM, 0 MB swap (before this deploy), 30 GB pd-standard
os:      Ubuntu 24.04.4 LTS
ip:      34.63.164.245
```

Every command below was actually run against that instance on 2026-08-24. SSH
works passwordless via:

```bash
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
gcloud compute ssh postbox --zone=us-central1-a --quiet --command='...'
```

Firewall already allows `tcp:80` and `tcp:443` to network tag
`postbox-https` (which this instance carries) — see `postbox-allow-web` in
`gcloud compute firewall-rules list`. Nothing else is open except `tcp:22`
(SSH) and default ICMP/internal rules. **No new GCP resource was created**
for this deploy: no static IP, no extra disk, no load balancer, no new
firewall rule — the instance, its boot disk, and the existing firewall
rule are the entire footprint, matching the $0 constraint.

All commands that touch a secret (Postgres password, API token, app
passwords) write the value to a local file with `chmod 600`, `scp` the file
up, consume it on the VM, then delete it on both ends. No secret value is
ever printed to a terminal or committed.

---

## 1. Swap (amendment A1)

GCP's Ubuntu image ships with **zero swap**. Postgres + Node + up to four
live IMAP/IDLE connections on 955 MB RAM will hit the OOM killer without a
safety net, and an OOM kill here is a silent stop, not a crash loop — so
this runs before anything else.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/60-postbox-swappiness.conf
```

`vm.swappiness=10` (default is 60) makes swap a safety net for memory
pressure spikes rather than a hot path the kernel reaches for routinely —
routine swapping on a single pd-standard disk would make the box
noticeably slower without actually helping.

**Verified:**

```
$ free -m
               total        used        free      shared  buff/cache   available
Mem:             955         421         162          13         543         534
Swap:           2047           0        2047

$ swapon --show
NAME      TYPE SIZE USED PRIO
/swapfile file   2G  48K   -2

$ cat /proc/sys/vm/swappiness
10

$ grep swap /etc/fstab
/swapfile none swap sw 0 0
```

## 2. Node 26 (NodeSource)

Ubuntu 24.04's own repo carries an older Node that does not support
`--experimental-strip-types`, so NodeSource is used instead, matching the
Mac's `node -v` (v26.7.0):

```bash
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
```

**Verified:** `node -v` → `v26.7.0`, `npm -v` → `11.19.0`.

## 3. PostgreSQL 16

Ubuntu 24.04's own `postgresql` package is already 16.x, so no external
repo is needed:

```bash
sudo apt-get install -y postgresql postgresql-contrib
```

**Verified:** `psql --version` → `psql (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`;
`pg_lsclusters` shows cluster `16 main` online on port 5432.

## 4. Postgres tuning for a 955 MB box (amendment A2)

File: `/etc/postgresql/16/main/conf.d/postbox-tuning.conf` (Ubuntu's
`postgresql.conf` already has `include_dir = 'conf.d'`, so this is the
lowest-friction way to keep the tuning in one reviewable file instead of
scattered edits to the shipped config):

```conf
# postbox-tuning.conf
#
# Tuning for a GCP e2-micro instance: 955 MB RAM total, shared with Node
# (the sync service + up to 4 live IMAP/IDLE connections) and now a 2 GB
# swapfile as a safety net (see /etc/fstab and sysctl vm.swappiness=10).
# Postgres's own defaults assume a dedicated, much larger host; left
# untouched they would let Postgres alone consume most of this box's
# memory and starve Node, causing an OOM kill during sync rather than a
# graceful failure. Values below are deliberately conservative, not
# maximal, for a service, not the only tenant on the machine.

# shared_buffers: Postgres's own page cache. Common guidance is ~25% of
# RAM on a dedicated DB host; this box is not dedicated, so 128MB
# (~13% of 955MB) leaves headroom for Node + OS + IMAP buffers. This
# also matches the Debian/Ubuntu package default, so no change was
# strictly required, but it is set explicitly here so the reasoning is
# documented in one place rather than left as an unexplained default.
shared_buffers = 128MB

# effective_cache_size: a planner hint, not an allocation — tells the
# query planner how much memory is likely available across
# shared_buffers + OS page cache for caching. Set conservatively at
# ~40% of RAM (384MB) rather than the usual 50-75% guidance, again
# because this box is shared with Node and IMAP connections, not
# dedicated to Postgres.
effective_cache_size = 384MB

# work_mem: per-sort/per-hash-join memory, multiplied by the number of
# concurrent sort/hash operations across all active connections. With
# up to max_connections=20 possible, a generous work_mem could multiply
# into hundreds of MB and trigger the OOM killer. 4MB keeps worst-case
# usage bounded; the app's queries are simple lookups over an indexed
# keyset, not large sorts.
work_mem = 4MB

# maintenance_work_mem: used for VACUUM, index builds, and similar
# maintenance operations, which run one at a time rather than once per
# connection. 32MB keeps autovacuum reasonably efficient on this table
# volume (four mailboxes) without holding a large chunk of RAM idle
# most of the time.
maintenance_work_mem = 32MB

# max_connections: the app's own pg pool caps at 4 (sync/src/db.ts,
# MAX_POOL_SIZE). 20 leaves headroom for a manual psql session or an
# admin script without changing behaviour under normal operation.
# Postgres reserves shared memory per possible connection regardless
# of whether it's used, so this is intentionally not left at the
# default of 100 on a 955MB box.
max_connections = 20
```

```bash
sudo mkdir -p /etc/postgresql/16/main/conf.d
# (file copied up via gcloud compute scp, then:)
sudo chown postgres:postgres /etc/postgresql/16/main/conf.d/postbox-tuning.conf
sudo chmod 644 /etc/postgresql/16/main/conf.d/postbox-tuning.conf
sudo systemctl restart postgresql
```

**Verified** (`max_connections` requires a restart, which was done above):

```
$ sudo -u postgres psql -c "SHOW shared_buffers;" -c "SHOW effective_cache_size;" \
    -c "SHOW work_mem;" -c "SHOW maintenance_work_mem;" -c "SHOW max_connections;"
 shared_buffers        | 128MB
 effective_cache_size  | 384MB
 work_mem              | 4MB
 maintenance_work_mem  | 32MB
 max_connections       | 20
```

## 5. `postbox` role and `postbox_sync` database

The VM gets its **own** Postgres role, database, and password — it is
never pointed at the Mac's Docker container. A fresh password was
generated locally (`openssl rand -base64 24 | tr -d '=+/' | cut -c1-32`,
32 chars), written to a `chmod 600` file, `scp`'d up, consumed by `psql`
via `\getenv` (never as a `-c`/`-v` command-line argument, which would be
visible to any local user via `ps`), then shredded on both ends:

```bash
# setup_pg.sql (no secret inside the file itself):
\getenv pgpassword PGPASSWORD_RAW
DO $$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postbox') THEN
      CREATE ROLE postbox LOGIN;
   END IF;
END
$$;
ALTER ROLE postbox WITH PASSWORD :'pgpassword';
SELECT 'CREATE DATABASE postbox_sync OWNER postbox'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'postbox_sync')\gexec
```

```bash
chmod 600 /tmp/pg_password.txt
export PGPASSWORD_RAW=$(cat /tmp/pg_password.txt)
sudo -E -u postgres psql -v ON_ERROR_STOP=1 -f /tmp/setup_pg.sql
shred -u /tmp/pg_password.txt /tmp/setup_pg.sql
```

**Verified:**

```
$ sudo -u postgres psql -c "\du postbox"
 Role name | Attributes
-----------+------------
 postbox   |

$ sudo -u postgres psql -l | grep postbox_sync
 postbox_sync | postbox  | UTF8 | libc | C.UTF-8 | C.UTF-8 |

$ PGPASSWORD=<the generated password> psql \
    "host=127.0.0.1 port=5432 dbname=postbox_sync user=postbox sslmode=disable" \
    -c "select current_user, current_database();"
 current_user | current_database
--------------+------------------
 postbox      | postbox_sync
```

TCP password auth on `127.0.0.1`/`::1` for all roles/databases was already
present in the default `pg_hba.conf` shipped by the Ubuntu package — no
`pg_hba.conf` edit was needed.

## 6. `postbox` OS user and directories

Dedicated, non-root, no shell:

```bash
sudo useradd --system --create-home --home-dir /opt/postbox --shell /usr/sbin/nologin postbox
sudo mkdir -p /opt/postbox/sync
sudo chown -R postbox:postbox /opt/postbox
```

`useradd` created `/opt/postbox` as the home directory with mode `750`
(owner-only + group-read), so nothing under it is world-readable by
default.

## 7. Application code

No build step — the service runs straight off `--experimental-strip-types`
source, so the deploy artifact is `src/`, `package.json`, and
`package-lock.json` (no `node_modules`, no `.env`, no `accounts.json`, no
`tests/`):

```bash
# From the repo, on the Mac (branch sync-service):
cd sync && tar czf /tmp/postbox-sync-src.tar.gz src package.json package-lock.json

gcloud compute scp /tmp/postbox-sync-src.tar.gz postbox:/tmp/postbox-sync-src.tar.gz \
  --zone=us-central1-a --quiet

# On the VM:
sudo -u postbox tar xzf /tmp/postbox-sync-src.tar.gz -C /opt/postbox/sync
rm -f /tmp/postbox-sync-src.tar.gz
sudo -u postbox find /opt/postbox/sync -name "._*" -delete   # macOS tar AppleDouble cruft

sudo -u postbox bash -c "cd /opt/postbox/sync && HOME=/opt/postbox npm install --omit=dev --no-audit --no-fund"
```

`npm install --omit=dev` installed the 3 runtime dependencies (`imapflow`,
`mailparser`, `pg`) plus transitive deps — 59 packages, ~5 MB — skipping
`typescript`/`vitest`, which the VM never needs.

**A security fix that shipped alongside this deploy:** `src/api/server.ts`
called `server.listen(config.port, resolve)` with no host argument, which
makes Node's `http.Server` bind **every** interface (`0.0.0.0`/`::`) by
default. Amendment A4 requires the service to listen on `127.0.0.1:8080`
only until TLS terminates in front of it. The app had no `HOST`/bind
config at all, so this was fixed at the source (`sync/src/api/server.ts`,
new `BIND_HOST = '127.0.0.1'` constant passed into `server.listen`),
committed as its own `fix:` commit — see [Commits](#10-commit) below. This
is outside this task's originally-declared file list
(`sync/deploy/postbox-sync.service`, `sync/deploy/README.md`), but
deploying the service as specified in A4 was not otherwise possible:
without it, the service would have been reachable on every interface the
moment it started, with only the GCP firewall (which does not currently
have a rule for 8080, but could be changed independently of this
service) standing between four real mailboxes and the public internet.
The full local test suite (182 passed, 28 skipped — the skipped tests need
live Postgres/IMAP, unrelated to this change) and `tsc --noEmit` both pass
after the change; `server.test.ts`'s `startServer` tests exercise only the
`API_TOKEN` fail-closed guard, which runs before `listen()`, so nothing
needed updating there.

**Verified — runtime import check** (proves the exact deployed source
loads cleanly under Node 26 + `--experimental-strip-types`, without
starting the server — `server.ts`'s `startServer()` call is guarded by
`import.meta.url === file://process.argv[1]`, so importing the module
alone never opens a socket, a DB connection, or an IMAP connection):

```
$ sudo -u postbox bash -c "cd /opt/postbox/sync && node --experimental-strip-types \
    -e 'const m = await import(\"./src/config.ts\"); console.log(\"config.ts import OK, MAX_ACCOUNTS=\" + m.MAX_ACCOUNTS)'"
config.ts import OK, MAX_ACCOUNTS=10

$ sudo -u postbox bash -c "cd /opt/postbox/sync && node --experimental-strip-types \
    -e 'const m = await import(\"./src/api/server.ts\"); console.log(\"server.ts import OK, exports:\", Object.keys(m).join(\",\"))'"
server.ts import OK, exports: createShutdown,onceOnly,parseAccountsJson,registerAccounts,registerShutdownHandlers,startServer,writeWebResponse
```

## 8. Secrets: `.env` and `accounts.json`

Never committed, logged, or echoed. The VM's `.env` is **not** a copy of
the Mac's — `DATABASE_URL` points at the VM's own freshly-created
`postbox`/`postbox_sync`, and a fresh `API_TOKEN` was generated with
`openssl rand -hex 32` (64 hex chars, well over the app's 32-char minimum
in `requireApiToken`):

```bash
# .env written locally (values interpolated by a script, never echoed):
DATABASE_URL=postgresql://postbox:<vm-postgres-password>@127.0.0.1:5432/postbox_sync
PORT=8080
ACCOUNTS_FILE=/opt/postbox/sync/accounts.json
API_TOKEN=<fresh openssl rand -hex 32>
```

`ACCOUNTS_FILE` is an **absolute path** (amendment A3): systemd's default
working directory is `/`, and the app's own default (`./accounts.json` in
`src/api/server.ts`) would resolve to `/accounts.json` and fail at boot
otherwise.

```bash
gcloud compute scp /tmp/vm.env postbox:/tmp/vm.env --zone=us-central1-a --quiet
gcloud compute scp sync/accounts.json postbox:/tmp/accounts.json --zone=us-central1-a --quiet

# On the VM:
sudo mv /tmp/vm.env /opt/postbox/sync/.env
sudo mv /tmp/accounts.json /opt/postbox/sync/accounts.json
sudo chown postbox:postbox /opt/postbox/sync/.env /opt/postbox/sync/accounts.json
sudo chmod 600 /opt/postbox/sync/.env /opt/postbox/sync/accounts.json
```

**Verified:**

```
$ sudo ls -la /opt/postbox/sync/.env /opt/postbox/sync/accounts.json
-rw------- 1 postbox postbox 226 ... .env
-rw------- 1 postbox postbox 536 ... accounts.json
```

`accounts.json` currently holds the four real Gmail accounts
(`primary`/`personal`/`harvard`/`masterman`), each with its own app
password — copied byte-for-byte from the Mac's `sync/accounts.json`, not
retyped.

## 9. systemd unit

`sync/deploy/postbox-sync.service` amends the brief's version in two
ways: `EnvironmentFile` and `ExecStart`'s `src/api/server.ts` are read
relative to `WorkingDirectory=/opt/postbox/sync` (the concrete deploy
path), and the `accounts.json` comment reflects the real account count
(four, not ten — `MAX_ACCOUNTS` caps the *config* at ten, but only four
accounts are configured today).

```bash
gcloud compute scp sync/deploy/postbox-sync.service postbox:/tmp/postbox-sync.service \
  --zone=us-central1-a --quiet

# On the VM:
sudo mv /tmp/postbox-sync.service /etc/systemd/system/postbox-sync.service
sudo chown root:root /etc/systemd/system/postbox-sync.service
sudo chmod 644 /etc/systemd/system/postbox-sync.service
sudo systemctl daemon-reload
sudo systemd-analyze verify postbox-sync.service
sudo systemctl enable postbox-sync.service
```

**Verified:**

```
$ sudo systemd-analyze verify postbox-sync.service
$ echo $?
0
$ sudo systemctl status postbox-sync.service --no-pager
○ postbox-sync.service - Postbox mail sync service
     Loaded: loaded (/etc/systemd/system/postbox-sync.service; enabled; preset: enabled)
     Active: inactive (dead)
$ sudo systemctl is-enabled postbox-sync.service
enabled
```

### The service was deliberately NOT started

**Amendment A5:** a sync service is currently running on the developer's
Mac against these same four Gmail accounts. Starting the VM's instance
too would double the IMAP/IDLE connections per account and risk tripping
Gmail's per-account connection limits. The unit is installed, valid
(`systemd-analyze verify` exit 0), and `enabled` (will start on the VM's
next boot unless disabled first) — but it is currently **inactive/dead**
and `ss -tlnp` on the VM confirms nothing is listening on 8080. Starting
it (`sudo systemctl start postbox-sync`) is left to whoever stops the Mac
instance first.

## 10. Reverse proxy (Caddy) — staged, not live (amendment A4)

Caddy was installed from its official APT repo (Ubuntu's own repos don't
carry it):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -y
sudo apt-get install -y caddy
```

**Verified:** `caddy version` → `v2.11.4`. The package installs and
enables its own systemd unit automatically (`systemctl is-active caddy` →
`active`, `is-enabled` → `enabled`).

`/etc/caddy/Caddyfile` was replaced with a staged config: a placeholder
`:80` block (Caddy's stock static page — harmless, proxies nothing) plus a
commented-out site block ready for the real hostname:

```caddyfile
# YOUR-HOSTNAME.duckdns.org {
# 	reverse_proxy 127.0.0.1:8080
# }

:80 {
	root * /usr/share/caddy
	file_server
}
```

```bash
gcloud compute scp Caddyfile postbox:/tmp/Caddyfile --zone=us-central1-a --quiet
sudo mv /tmp/Caddyfile /etc/caddy/Caddyfile
sudo chown root:root /etc/caddy/Caddyfile
sudo chmod 644 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Verified:** `caddy validate` → `Valid configuration`; `curl -s -o
/dev/null -w '%{http_code}' http://127.0.0.1:80/` → `200`; `ss -tlnp`
shows only `*:80` listening (Caddy) — nothing on `:443` yet (expected,
no TLS site is configured) and nothing on `:8080` (the app isn't
running).

### The one remaining step to finish TLS

Once the DuckDNS hostname exists and its A record points at
`34.63.164.245`:

1. Edit `/etc/caddy/Caddyfile` on the VM: replace
   `YOUR-HOSTNAME.duckdns.org` with the real hostname, uncomment that
   block, and remove (or leave — it won't be reached once the named site
   takes 80/443) the placeholder `:80 { ... }` block.
2. Run:

   ```bash
   sudo systemctl reload caddy
   ```

That's the single remaining command — Caddy obtains and renews the Let's
Encrypt certificate automatically from there. No firewall change is
needed (`tcp:80`/`tcp:443` are already open to this instance's
`postbox-https` tag), and no additional GCP resource is created.

## 11. Reading logs

Once the controller starts the service:

```bash
gcloud compute ssh postbox --zone=us-central1-a --quiet \
  --command='sudo journalctl -u postbox-sync -f'
```

## 12. Post-start verification (not run in this task — service was not started)

These are the brief's original Steps 3-5, deferred to whoever starts the
service (amendment A5 forbids starting it here):

```bash
# Health — expect ok: true, one entry per account, each "status": "connected"
curl -s https://<duckdns-host>/api/health | jq

# Unified inbox — expect 5 real messages, newest first, from more than one account
curl -s -H "Authorization: Bearer $API_TOKEN" \
  'https://<duckdns-host>/api/inbox?limit=5' | jq '.messages[] | {subject, from_email, date}'

# Byte budget — expect one row per active account, all well under 2 GB
sudo -u postgres psql postbox_sync -c \
  'select account_id, day, pg_size_pretty(bytes_used) from byte_budget order by bytes_used desc;'
```

Before a DuckDNS hostname exists, `/api/health` can be checked locally on
the VM once the service is running:

```bash
gcloud compute ssh postbox --zone=us-central1-a --quiet \
  --command='curl -s http://127.0.0.1:8080/api/health | jq'
```

## 13. Browser sessions — what changed for the operator (Task 3.5)

`/api/*` now accepts **either** credential:

1. `Authorization: Bearer $API_TOKEN` — unchanged. Every `curl` in this
   file, every script, and every existing test keeps working exactly as
   written. Nothing below replaces it.
2. An `HttpOnly` session cookie, which is how the browser client
   authenticates without a token embedded in its JavaScript bundle.

Three new routes: `POST /api/session` (trade the token for a cookie),
`GET /api/session` (204 if signed in, 401 if not), and
`DELETE /api/session` (clear it). `POST` is the only one reachable without
an existing credential, because it is how a browser obtains one.

**No new environment variable, no new dependency, no new GCP resource.**
The cookie is a stateless HMAC over its own expiry, keyed off a value
derived from `API_TOKEN`, so there is no session table to create and
nothing to back up. Still $0.

### Things that will actually bite you

- **TLS must be live before a browser can sign in.** The cookie is named
  `__Host-postbox_session` and set `Secure`, so a browser flatly refuses to
  store it over plain `http://` on a real hostname. Sign-in then appears to
  succeed (`204`) and every subsequent request still 401s, with nothing in
  the log to explain it. (`localhost` is a secure context, so local
  development over plain HTTP is unaffected.)
  Section 10's one remaining step — point the DuckDNS A record at the
  instance, uncomment the site block, `sudo systemctl reload caddy` — is
  therefore a prerequisite for the web client, not an optional extra.
  `localhost` is exempt from the `Secure` rule, so local development works
  over plain HTTP without a change.
- **Do not filter headers in the Caddyfile.** A bare
  `reverse_proxy 127.0.0.1:8080` already forwards the `Cookie` request
  header and returns `Set-Cookie` untouched, which is all this needs. If
  anyone later adds `header_up`/`header_down` directives, both of those
  header names must survive.
- **Rotating `API_TOKEN` signs every browser out.** That is the intended —
  and only — bulk revocation: the cookie carries no server-side session id,
  so there is nothing to delete. Rotate the value in
  `/opt/postbox/sync/.env` and `sudo systemctl restart postbox-sync`; every
  outstanding cookie stops verifying on the next request.
- **Sessions last 30 days.** After that the client shows its sign-in view
  again and the token has to be pasted once more.
- **`SameSite=Strict`** means a link to the app from another site lands
  logged-out on the first navigation. That is deliberate; nothing
  legitimately links into this app from elsewhere.
- **Request bodies are capped at 8 KB** and answered `413` above it. Only
  `POST /api/session` reads a body at all.
- **`POST /api/session` is rate limited: 10 failed attempts per 60
  seconds**, answered `429` with a `Retry-After` once spent. Successful
  sign-ins never consume budget, so setting up several devices in a row is
  fine. **The worst case is a 60-second wait**, and restarting the service
  clears the counter outright.

  The window is short on purpose, and the reasoning matters if you are ever
  tempted to lengthen it. Against a 256-bit token a longer window buys **no
  security at all** — ten guesses per minute and ten per fifteen minutes
  are both infeasible by a margin of billions of years. The limiter's real
  job is to stop a flood burning CPU and filling the journal on a 955 MB
  box, which 60 seconds does just as well. What a longer window *does* buy
  is downtime: the counter is global, so anyone who knows this URL can
  spend the budget with ten requests and hold **you** out of your own
  mailbox for however long the window lasts, repeatedly.

  **The counter is global rather than per-IP, and that is not an
  oversight.** This process sits behind Caddy on loopback and the only
  address it can see is whatever the client wrote in `X-Forwarded-For` — a
  header the client controls. Keying on it would let an attacker step
  around the limiter by rotating a string, while growing an unbounded map
  in memory as they did it, turning a rate limiter into a
  memory-exhaustion vector. Do not "fix" this into a per-IP limiter.

  No other route is limited, also deliberately: they are all authenticated
  and serve one person, and a limiter there would eventually throttle your
  own inbox polling.
- **Do not put a caching layer in front of `/api/*`.** Mailbox responses
  (`/api/inbox`, `/api/opens`, `/api/thread/*`, message bodies and
  attachments) now send `Cache-Control: private, no-store`, because they
  are authorised by an ambient cookie rather than only by an
  `Authorization` header. Caddy does not cache by default; keep it that
  way.

### Verifying it, once the service is started and TLS is live

```bash
# 1. Bearer path unchanged — expect 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $API_TOKEN" 'https://<duckdns-host>/api/inbox?limit=1'

# 2. No credential — expect 401
curl -s -o /dev/null -w '%{http_code}\n' 'https://<duckdns-host>/api/inbox?limit=1'

# 3. Sign in, keeping the cookie in a jar — expect 204 and a Set-Cookie
#    named __Host-postbox_session. A 429 here means the failure window is
#    spent; wait 60 seconds (Retry-After says how long) or restart the
#    service to clear the counter.
curl -s -D - -o /dev/null -c /tmp/postbox-cookies.txt \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$API_TOKEN\"}" \
  https://<duckdns-host>/api/session | grep -i set-cookie

# 4. The cookie alone authorises the inbox — expect 200
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/postbox-cookies.txt \
  'https://<duckdns-host>/api/inbox?limit=1'

# 5. Sign out, then confirm the jar no longer works — expect 204 then 401
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -b /tmp/postbox-cookies.txt \
  -c /tmp/postbox-cookies.txt https://<duckdns-host>/api/session
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/postbox-cookies.txt \
  'https://<duckdns-host>/api/inbox?limit=1'

rm -f /tmp/postbox-cookies.txt
```

Step 3 writes `$API_TOKEN` into the shell's history if it is typed
literally — read it from the `.env` on the VM into a variable instead, and
delete the cookie jar afterwards as shown.

## 14. Web Push — what the VM still needs (Task 6)

Task 6 adds `POST /api/push/subscribe`, `DELETE /api/push/subscribe` and
`GET /api/push/key`, a `push_subscriptions` table (created automatically by
`applySchema()` on the next start), a service worker at `/sw.js`, and one
new runtime dependency, `web-push`. **No new GCP resource, no third-party
account, no bill.** Apple and Google operate the push endpoints the browser
hands us, but nothing registers with either of them: the VAPID keypair is
generated locally and lives only in a `.env`. Still $0.

### THE THING THAT WILL BITE YOU: the VM's `.env` is not a copy of the repo's

**Do not `scp` `sync/.env` up.** `/opt/postbox/sync/.env` already diverges
from the developer machine's copy — §8 above generated a *fresh*
`API_TOKEN` for the VM and points `DATABASE_URL` at the VM's own
`postbox`/`postbox_sync`. Overwriting it would rotate the VM's API token
out from under every signed-in browser and point the service at a database
that does not exist there.

The VAPID keys therefore have to be **appended deliberately**, not copied.

### Generating and installing the pair

Generate **one** pair and use it in both places. The public key is what
each browser subscribes with, and rotating it invalidates every stored
subscription — every device then has to be toggled off and on again.

```bash
# On the Mac, in sync/ — writes to a chmod 600 file, never to the terminal.
# `npx web-push generate-vapid-keys --json` prints both keys to stdout;
# this pipes them straight into a file instead of letting them land in
# scrollback and the shell history.
umask 077
npx web-push generate-vapid-keys --json > /tmp/vapid.json
```

Append them to the VM's existing `.env` — note `>>`, and note that the
whole thing runs on the VM so the private key never appears in a local
argument list (visible to any user via `ps`):

```bash
gcloud compute scp /tmp/vapid.json postbox:/tmp/vapid.json \
  --zone=us-central1-a --quiet

gcloud compute ssh postbox --zone=us-central1-a --quiet --command='
  set -e
  sudo chmod 600 /tmp/vapid.json
  PUB=$(sudo node -e "console.log(require(\"/tmp/vapid.json\").publicKey)")
  PRIV=$(sudo node -e "console.log(require(\"/tmp/vapid.json\").privateKey)")
  printf "VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\nVAPID_SUBJECT=%s\n" \
    "$PUB" "$PRIV" "https://postbox-valen.duckdns.org" \
    | sudo tee -a /opt/postbox/sync/.env > /dev/null
  sudo chown postbox:postbox /opt/postbox/sync/.env
  sudo chmod 600 /opt/postbox/sync/.env
  sudo shred -u /tmp/vapid.json
'

shred -u /tmp/vapid.json    # and on the Mac
sudo systemctl restart postbox-sync
```

Then put the **same** pair into the Mac's `sync/.env` (gitignored) so local
development is not silently running with push disabled.

`VAPID_SUBJECT` is the JWT's `sub` claim (RFC 8292 §2.1) — a `mailto:` or
`https:` URI a push service operator could use to reach whoever runs this
deployment. An https: URL is used rather than a mailto: so no personal
address is embedded in every JWT sent to Apple and Google. It is optional
and defaults to the deployment's own hostname.

### Installing the dependency on the VM

`web-push` is a runtime dependency, so §7's install command has to run
again after the next code upload:

```bash
sudo -u postbox bash -c "cd /opt/postbox/sync && HOME=/opt/postbox \
  npm install --omit=dev --no-audit --no-fund"
```

### It degrades rather than failing to start

Deliberately unlike `API_TOKEN`, and for the same reason `TRACKING_*` does:
email sync is this service's primary job. With either key missing the
service **still starts**, logs one loud warning at startup, and:

- `GET /api/push/key` answers `200 {"available": false, "publicKey": null}`
- `POST /api/push/subscribe` answers `503`
- `DELETE /api/push/subscribe` still works, so a device that subscribed
  before the keys were removed can still be turned off

The client renders the toggle as unavailable rather than as broken. If push
appears not to work, `journalctl -u postbox-sync | grep VAPID` is the first
thing to read.

### Things that will actually bite you

- **iOS requires a Home Screen install.** Safari only permits
  `PushManager.subscribe()` from a web app installed via Share → Add to
  Home Screen. In a Safari tab the toggle renders that instruction instead
  of a switch; this is expected, not a bug.
- **The service worker caches nothing, on purpose.** `/sw.js` handles
  `push` and `notificationclick` and registers no `fetch` handler. Mailbox
  responses are authorised by an ambient cookie, so a worker that stored
  one would write four real mailboxes to the device's disk. Do not add
  offline support to it without a deliberate decision about what may be
  persisted. `client/tests/push-toggle.test.ts` fails if a `fetch` handler
  or any Cache Storage use appears in that file.
- **The worker is registered only when someone turns notifications on**,
  never at app start — a worker is hard to evict from an installed PWA.
- **Whatever serves `/sw.js` must send a `Cache-Control: max-age` of 86400
  or less** (Task 8 owns static serving). A browser caches a service
  worker like any other file, so a long max-age on this one means a broken
  worker cannot be replaced by shipping a fixed one — it stays in control
  of an installed PWA until the cache expires. This is the one static file
  on this origin where the freshness header is a recoverability property
  rather than a performance one.
- **Endpoints are credentials.** A `push_subscriptions.endpoint` is a
  capability URL: whoever holds one can push to that device. Nothing in
  this service logs, echoes or returns one, and neither should any
  debugging you add. Do not `select endpoint from push_subscriptions` into
  a shared terminal.
- **404/410 are the only statuses that prune a subscription.** They mean
  the browser permanently discarded it. A 429 or a 5xx is transient, and
  pruning on one would silently unsubscribe a phone with nothing to notice
  it by.
- **Nothing sends a push yet.** Task 6 built the subscription path and the
  `sendPush` function; Task 7 is what dispatches on new mail and on open
  events.

### Verifying it, once the service is restarted

```bash
# Expect {"available":true,"publicKey":"B..."}. The PUBLIC key is safe to
# see — the browser sends it to Apple/Google on every subscribe.
curl -s -H "Authorization: Bearer $API_TOKEN" \
  https://<duckdns-host>/api/push/key | jq

# Expect 400 — a malformed subscription is refused, and nothing is stored.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"endpoint":"http://not-https.example/x"}' \
  https://<duckdns-host>/api/push/subscribe

# Expect the table to exist and be empty until a real browser subscribes.
sudo -u postgres psql postbox_sync -c \
  'select count(*), max(created_at) from push_subscriptions;'

# Expect 200 and a JavaScript content-type (Task 8 serves static files;
# before that lands this 404s, which is expected).
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://<duckdns-host>/sw.js
```

## Summary of what's running right now

| Component     | State                                             |
|----------------|----------------------------------------------------|
| Swap           | 2 GB, active, persistent, swappiness=10             |
| Node           | v26.7.0 installed                                   |
| PostgreSQL     | 16.15, running, tuned, `postbox`/`postbox_sync` ready |
| App code       | deployed to `/opt/postbox/sync`, deps installed     |
| `.env` / `accounts.json` | present, `600`, owned by `postbox`         |
| systemd unit   | installed, valid, **enabled**, **active** (2026-08-25 rollout) |
| Caddy          | running, **TLS live** at https://postbox-valen.duckdns.org |
| postbox-sync   | **running** — 4 accounts connected; opens poll ticking (sentinel verified) |
| Browser auth   | bearer **or** `__Host-` session cookie — TLS live, login verified (§13) |
| Web Push       | live — VAPID keys on the VM; `push_subscriptions` created at boot (§14) |
| `web-push` dep | installed on the VM (`npm ci --omit=dev`, 2026-08-25) |

## 15. Full-stack deploy — Plan 3 (Task 8)

**Everything above this section is a retrospective log: it documents
commands that were actually run against the VM, with their real output.**
This section is different in kind — it is a **procedure written for the
controller to execute**, not a record of something already done. The task
that wrote it explicitly does not deploy, does not run `gcloud`, and does
not touch the VM; nothing below carries a "Verified:" block for that
reason, and none of it should be read as already having happened.

### Why this replaces the brief's original Step 3

Task 8's brief said, in full: build the client, `gcloud compute scp
--recurse sync/public postbox:/tmp/public`, move it into place, restart.
That step is **defective** for this deploy, for one reason: **it only ever
ships `sync/public`.** The VM is still running Plan 2-era `sync/src` —
every change since then has never left this Mac:

- Task 3.5's session-cookie auth (`src/api/session.ts`, the hybrid
  `isAuthorized` gate in `src/api/routes.ts`)
- Task 2's `/api/opens` tracking proxy
- Task 6's Web Push routes and the `web-push` runtime dependency — **not
  installed on the VM at all**, per the summary table above
- Task 7's push dispatch on new mail and on opens
- This task's static file serving (`src/api/static.ts`) and the
  `createRouter` wiring that calls it

Copying only `sync/public` onto that stale `src/` and restarting would
serve a brand-new client shell against a backend that cannot authenticate
a browser session, has no push routes, and has never even loaded
`web-push`. The procedure below ships the whole tree.

### Step 1 — build the client locally

```bash
cd client && npm run build   # writes sync/public
cd ..
```

Confirm it actually produced output before going further:

```bash
ls sync/public/index.html sync/public/sw.js sync/public/manifest.webmanifest
```

### Step 2 — ship source + manifests + built client to the VM

Same staging pattern §7 already established (`scp` to `/tmp`, then a
`sudo` move into place) — extended to cover everything Task 8 needs and
nothing it must not. **Excluded, deliberately:** `.env` (§8's "never copy
this" rule, restated below), `accounts.json` (a live credential file — the
VM's own, from §8, must not be overwritten by the Mac's), `node_modules`
(reinstalled on the VM in Step 3, not shipped — different OS/arch than a
Mac dev machine), and `tests/` (never runs on the VM).

The service is stopped before anything under `/opt/postbox/sync` is
touched. Harmless today — amendment A5 means `postbox-sync` is not
running yet — but this procedure is meant to be re-run for every future
deploy too, and `rm -rf`'ing `src/` out from under a running process
(below) is exactly the kind of thing that is fine until the one time it
isn't. `|| true` because `systemctl stop` on an already-inactive unit is
not a failure worth aborting the deploy over.

```bash
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"

gcloud compute ssh postbox --zone=us-central1-a --quiet --command='
  sudo systemctl stop postbox-sync || true
'

cd sync
tar czf /tmp/postbox-sync-deploy.tar.gz \
  src package.json package-lock.json public
cd ..

gcloud compute scp /tmp/postbox-sync-deploy.tar.gz \
  postbox:/tmp/postbox-sync-deploy.tar.gz \
  --zone=us-central1-a --quiet

gcloud compute ssh postbox --zone=us-central1-a --quiet --command='
  set -e
  sudo -u postbox mkdir -p /tmp/postbox-sync-staging
  sudo -u postbox tar xzf /tmp/postbox-sync-deploy.tar.gz -C /tmp/postbox-sync-staging
  rm -f /tmp/postbox-sync-deploy.tar.gz
  sudo -u postbox find /tmp/postbox-sync-staging -name "._*" -delete

  # accounts.json and .env already live under /opt/postbox/sync and are
  # NOT part of the tarball at all (see the exclusion list above) — so a
  # plain directory swap here cannot touch either one. src/, public/ and
  # the two package manifests are replaced; everything else already under
  # /opt/postbox/sync (.env, accounts.json, node_modules) is left alone.
  sudo -u postbox rm -rf /opt/postbox/sync/src /opt/postbox/sync/public
  sudo -u postbox cp -r /tmp/postbox-sync-staging/src /opt/postbox/sync/src
  sudo -u postbox cp -r /tmp/postbox-sync-staging/public /opt/postbox/sync/public
  sudo -u postbox cp /tmp/postbox-sync-staging/package.json /opt/postbox/sync/package.json
  sudo -u postbox cp /tmp/postbox-sync-staging/package-lock.json /opt/postbox/sync/package-lock.json
  rm -rf /tmp/postbox-sync-staging
'

rm -f /tmp/postbox-sync-deploy.tar.gz   # and on the Mac
```

### Step 3 — install dependencies on the VM

`npm ci` (not `npm install`) because this deploy ships a `package-lock.json`
specifically pinned by this repo — `ci` refuses to write to it and installs
exactly what the lockfile says, which is the right guarantee for a
production box. This is also the step that finally installs `web-push`
(§14's "not yet installed on the VM" line in the summary table above):

```bash
gcloud compute ssh postbox --zone=us-central1-a --quiet --command='
  sudo -u postbox bash -c "cd /opt/postbox/sync && HOME=/opt/postbox \
    npm ci --omit=dev --no-audit --no-fund"
'
```

### Step 4 — deleted: schema changes apply automatically, do not add a manual step here

There is deliberately no `psql -f schema.sql` command in this procedure. A draft of this
section had one and it was removed after review — it was actively dangerous, not merely
redundant:

- `psql -f` reads the file client-side as whatever OS user runs the command. `/opt/postbox`
  is `750 postbox:postbox`, so running it as `postgres` (the role that owns the database)
  gets a permission-denied reading `schema.sql` off disk, and `set -e` aborts the whole
  deploy right there.
- The obvious fix — copy `schema.sql` to `/tmp` first, matching §5's own pattern — makes
  this WORSE: `psql` then succeeds, but as the Postgres **superuser**. Any table that does
  not yet exist (`push_subscriptions`, which has never been created on the VM) gets created
  owned by `postgres`, not `postbox`. The app connects as `postbox` and every subsequent
  `insert`/`delete` against that table then fails with `permission denied for table
  push_subscriptions` — silently, since the deploy itself reported success.
- It is also simply unnecessary: `sync/src/api/server.ts`'s `startServer()` already calls
  `await db.applySchema()` on every boot (§14 documents this), running as the `postbox` role
  the app itself connects as — the only role that should ever own these tables. Step 6's
  restart is what applies the schema; nothing manual is needed before or after it.

### Step 5 — the one thing to never do: copy `.env`

**Never `scp` `.env` in either direction, full stop.** §8 and §14 both
already say this and it bears repeating a third time because Task 8 is
exactly the kind of "just get it all deployed" step where it's tempting to
shortcut: overwriting the VM's `.env` with the Mac's would rotate
`API_TOKEN` out from under every signed-in browser and point `DATABASE_URL`
at a database that doesn't exist on the VM; overwriting the Mac's `.env`
with the VM's would do the same in reverse to local development.

**Before running Step 6, confirm the VM's `.env` already carries every key
this deploy needs** — beyond the original four from §8
(`DATABASE_URL`, `PORT`, `ACCOUNTS_FILE`, `API_TOKEN`), that's the five
added across §13/§14's history: `TRACKING_BASE_URL`, `TRACKING_READ_TOKEN`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (names only — this
procedure never handles the values). Check which are present without ever
printing one:

```bash
gcloud compute ssh postbox --zone=us-central1-a --quiet --command='
  sudo grep -oE "^[A-Z_]+=" /opt/postbox/sync/.env | sort
'
```

If any of the five are missing, append them the same deliberate,
value-never-touches-the-Mac's-terminal way §14 did for the VAPID pair —
never by copying a whole `.env` over. `STATIC_ROOT` is deliberately absent
from this list: it is optional, and its default (resolved inside
`src/api/static.ts` from the module's own location, not the process's
working directory) already lands on `/opt/postbox/sync/public`, which is
exactly where Step 2 puts the built client. No new environment variable is
needed for this task.

### Step 6 — restart and verify

```bash
gcloud compute ssh postbox --zone=us-central1-a --quiet --command='
  sudo systemctl restart postbox-sync
  sleep 2
  sudo systemctl is-active postbox-sync
'
```

Then the full verification battery, from wherever the hostname resolves
(the Mac, once TLS is live per §10's remaining step — see that section if
`https://postbox-valen.duckdns.org` isn't answering yet):

```bash
HOST=postbox-valen.duckdns.org

# 1. App shell — expect 200, text/html
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "https://$HOST/"

# 2. Service worker — expect 200 and Cache-Control: no-cache (Task 8,
#    point 3 — a cached sw.js is nearly impossible to evict afterwards)
curl -s -D - -o /dev/null "https://$HOST/sw.js" | grep -i cache-control

# 3. A hashed asset — expect Cache-Control: public, max-age=31536000,
#    immutable. Derived from the real build output rather than a
#    placeholder filename, so this snippet is copy-pasteable as-is.
ASSET=$(basename "$(ls sync/public/assets/*.js | head -1)")
curl -s -D - -o /dev/null "https://$HOST/assets/$ASSET" | grep -i cache-control

# 4. API health — expect 200, ok:true, one entry per account
curl -s "https://$HOST/api/health" | jq

# 5. API without credentials — expect 401, not 200-with-index.html
#    (the load-bearing check from this task's brief: static serving must
#    never shadow /api/*)
curl -s -o /dev/null -w '%{http_code}\n' "https://$HOST/api/inbox"

# 6. Unknown API path — expect 404 (JSON), not the SPA fallback
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $API_TOKEN" "https://$HOST/api/nope"

# 7. Traversal attempt — status code alone proves nothing here: Caddy and
#    the router's own `new URL()` both collapse "%2e%2e" during parsing,
#    so a PASSING result is 200-with-the-app-shell, which is
#    indistinguishable from 200-with-real-/etc/passwd by status code
#    alone. Check the body instead — TRAVERSAL-FAIL must never print.
curl -s "https://$HOST/%2e%2e/%2e%2e/etc/passwd" \
  | grep -q 'root:' && echo TRAVERSAL-FAIL || echo ok

# 8. Sign-in with a wrong token — expect 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{"token":"wrong"}' \
  "https://$HOST/api/session"
```

Read `$API_TOKEN` out of the VM's own `.env` into a shell variable for
check 6 rather than typing it literally — the same reasoning §13 already
gives for not leaving it in shell history.

**If check 5 ever returns 200:** stop immediately. That means static
serving is shadowing the API, which is the single most important property
this task's router-ordering change protects — see
`sync/src/api/routes.ts`'s `createRouter` dispatcher and
`sync/tests/static-routing.test.ts`'s "does not shadow /api/*" suite for
what should have caught this before it ever reached the VM.

### After this deploy

Update this file's summary table (§ "Summary of what's running right
now") with the new state: `postbox-sync` **started**, Web Push keys and
`web-push` dependency both live, and the client served from the same
origin. That table is the single place this document's own reader is
expected to check first — leaving it stale defeats the purpose of keeping
this as a living deploy log.
