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

- **TLS must be live before a browser can sign in.** The cookie is set
  `Secure`, so a browser silently discards it over plain `http://` on a
  real hostname. Sign-in then appears to succeed (`204`) and every
  subsequent request still 401s, with nothing in the log to explain it.
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

### Verifying it, once the service is started and TLS is live

```bash
# 1. Bearer path unchanged — expect 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $API_TOKEN" 'https://<duckdns-host>/api/inbox?limit=1'

# 2. No credential — expect 401
curl -s -o /dev/null -w '%{http_code}\n' 'https://<duckdns-host>/api/inbox?limit=1'

# 3. Sign in, keeping the cookie in a jar — expect 204 and a Set-Cookie
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

## Summary of what's running right now

| Component     | State                                             |
|----------------|----------------------------------------------------|
| Swap           | 2 GB, active, persistent, swappiness=10             |
| Node           | v26.7.0 installed                                   |
| PostgreSQL     | 16.15, running, tuned, `postbox`/`postbox_sync` ready |
| App code       | deployed to `/opt/postbox/sync`, deps installed     |
| `.env` / `accounts.json` | present, `600`, owned by `postbox`         |
| systemd unit   | installed, valid, **enabled**, **inactive**         |
| Caddy          | installed, running, staged (no TLS site yet)        |
| postbox-sync   | **NOT started** — left to the controller (A5)       |
| Browser auth   | bearer **or** session cookie; needs TLS live (§13)  |
