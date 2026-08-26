#!/bin/bash
# Full-stack rollout: build the client, ship the sync service, restart, verify.
#
# DEPLOYS FROM A GIT REF, NOT THE WORKING TREE, and that is the whole reason
# this file lives in the repo instead of a scratch directory.
#
# The previous version did `rsync -a sync/ "$STAGE/sync/"`, which copies
# whatever is on disk right now. During this project's agent-heavy sessions
# that repeatedly meant deploying another agent's half-finished work — the
# tree is dirty far more often than not. `git archive` can only emit
# committed content, so a dirty tree can no longer leak into production; it
# just means the uncommitted part does not ship, which is the correct and
# obvious behaviour.
#
# The one thing git cannot supply is the client build: `sync/public` is
# generated and gitignored, so it is overlaid onto the archive afterwards.
#
# Usage: sync/deploy/rollout.sh [ref]      (default: HEAD)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

REF="${1:-HEAD}"
git rev-parse --verify "$REF" >/dev/null

echo "== 0. what is about to ship =="
echo "   ref: $REF  ($(git rev-parse --short "$REF")) — $(git log -1 --format=%s "$REF")"
if [ -n "$(git status --porcelain)" ]; then
  echo "   NOTE: the working tree is dirty. Uncommitted changes will NOT ship:"
  git status --porcelain | sed 's/^/     /'
fi

echo "== 1. build client (writes sync/public) =="
(cd client && npm run build)

echo "== 2. stage sync from $REF, plus the fresh build =="
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/sync"
# Committed source only. Tests and secrets are excluded the same way the
# rsync version excluded them.
git archive "$REF" sync | tar -x -C "$STAGE" --strip-components=0
rm -rf "$STAGE/sync/tests" "$STAGE/sync/.env" "$STAGE/sync/accounts.json"
find "$STAGE/sync" -name '*.test.ts' -delete
# The build output, which git does not carry.
rsync -a --delete client/../sync/public/ "$STAGE/sync/public/"
tar -C "$STAGE" -czf "$STAGE/sync.tgz" sync

echo "== 3. ship =="
gcloud compute scp "$STAGE/sync.tgz" postbox:/tmp/sync.tgz --zone=us-central1-a --tunnel-through-iap

echo "== 4. install on VM =="
gcloud compute ssh postbox --zone=us-central1-a --tunnel-through-iap --command='
  set -e
  sudo systemctl stop postbox-sync
  sudo tar -C /tmp -xzf /tmp/sync.tgz
  sudo rsync -a --delete --exclude ".env" --exclude "accounts.json" --exclude "node_modules" /tmp/sync/ /opt/postbox/sync/
  sudo rm -rf /tmp/sync /tmp/sync.tgz
  sudo bash -c "cd /opt/postbox/sync && npm ci --omit=dev" 2>&1 | tail -2
  # schema: applied at startup by db.applySchema() as the postbox role — a
  # manual psql-as-postgres step would create superuser-owned tables the app
  # cannot touch.
  sudo chown -R postbox:postbox /opt/postbox/sync
  sudo systemctl restart postbox-sync
  sleep 4 && sudo systemctl is-active postbox-sync'

echo "== 5. verify from public internet =="
B=https://postbox-valen.duckdns.org
curl -s -o /dev/null -w "app shell:      %{http_code}\n" $B/
curl -s -D - -o /dev/null $B/sw.js | grep -iE "^HTTP|cache-control"
curl -s -o /dev/null -w "api health:     %{http_code}\n" $B/api/health
curl -s -o /dev/null -w "inbox no-auth:  %{http_code} (want 401)\n" $B/api/inbox
# Unauthenticated, auth runs before routing, so an unknown path is 401 too.
# The 404 for an authenticated caller is pinned by sync/tests/push.test.ts.
curl -s -o /dev/null -w "api unknown:    %{http_code} (want 401 unauthed)\n" $B/api/nope
T=$(curl -s "$B/%2e%2e/%2e%2e/etc/passwd"); echo "$T" | grep -q 'root:' && echo "traversal:      FAIL — file contents leaked" || echo "traversal:      ok (shell or 404, no file body)"
