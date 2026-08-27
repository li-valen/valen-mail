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

# TWO WAYS IN, BECAUSE ONE OF THEM STOPPED WORKING FOR HALF A DAY.
#
# `gcloud compute scp --tunnel-through-iap` failed eight times running with
# `ConnectionCreationError: [Errno 60] Operation timed out` inside the IAP
# websocket, while the VM was RUNNING, the compute API answered, auth was
# valid, and a raw TLS handshake to tunnel.cloudproxy.app completed in 20ms.
# The tunnel reached "Testing if tunnel connection works." and hung there
# indefinitely. Nothing about the machine or the project explained it.
#
# So: try IAP first, because it is the better path and needs no public SSH,
# and fall back to the instance's external IP, which is reachable because
# `default-allow-ssh` permits tcp:22 from 0.0.0.0/0. If that rule is ever
# tightened to IAP's own range (35.235.240.0/20, which is what it SHOULD be),
# this fallback stops working and the IAP path has to be fixed instead. That
# is the correct trade, and this comment is where to start.
#
# The host key is verified either way: `HostKeyAlias` reuses the entry gcloud
# already wrote into google_compute_known_hosts, so the fallback is a
# different route to the same host, not a weaker check.
KEY=~/.ssh/google_compute_engine
KNOWN=~/.ssh/google_compute_known_hosts
HOST_ALIAS=$(grep -oE "compute\.[0-9]+" "$KNOWN" 2>/dev/null | head -1)
SSH_USER=$(whoami)
DIRECT_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o CheckHostIP=no -o HashKnownHosts=no -o "HostKeyAlias=$HOST_ALIAS"
  -o "UserKnownHostsFile=$KNOWN" -o ConnectTimeout=20)

echo "== 3. ship =="
if gcloud compute scp "$STAGE/sync.tgz" postbox:/tmp/sync.tgz --zone=us-central1-a --tunnel-through-iap 2>/dev/null; then
  VIA=iap
  echo "   via IAP"
else
  echo "   IAP tunnel unavailable - falling back to the external IP"
  IP=$(gcloud compute instances describe postbox --zone=us-central1-a \
        --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
  [ -n "$IP" ] || { echo "   no external IP either - cannot reach the VM"; exit 1; }
  VIA=direct
  scp "${DIRECT_OPTS[@]}" "$STAGE/sync.tgz" "$SSH_USER@$IP:/tmp/sync.tgz"
  echo "   via $IP"
fi

run_remote() {
  if [ "$VIA" = iap ]; then
    gcloud compute ssh postbox --zone=us-central1-a --tunnel-through-iap --command="$1"
  else
    ssh "${DIRECT_OPTS[@]}" "$SSH_USER@$IP" "$1"
  fi
}

echo "== 4. install on VM =="
run_remote '
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
