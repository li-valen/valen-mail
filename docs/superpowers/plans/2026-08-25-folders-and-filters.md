# Folders + Account Filtering Implementation Plan (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Sidebar folders (Inbox, Starred, Sent, Spam, Trash) and click-to-filter
accounts — the unified inbox becomes a full Gmail replacement surface.

**Architecture:** The pool syncs four folders per account (special-use discovery,
not hardcoded names); Starred is a virtual flag-query, not a synced folder; the
inbox API gains folder+account filter params on the existing keyset cursor; the
sidebar's folder nav and account rows drive them.

**Spec:** 2026-08-23-postbox-spec.md §7A (read-state-first design unchanged) +
user goal 2026-08-25 ("starred. sent. spam. trash… cycle through the accounts…
nicer version of gmail").

## Global Constraints
- Schema is ALREADY per-(account, folder) everywhere (messages.folder,
  sync_state PK (account_id, folder)) — Plan 2 built this right. NO schema change;
  any task believing it needs one is misreading.
- Folder discovery via IMAP special-use (\Sent \Junk \Trash from list()), never
  hardcoded "[Gmail]/…" names. INBOX stays literal.
- Newest-50 per folder per account (budget: 4 folders x 4 accts x ~2KB/header
  fetch — far inside the 2GB/day budget; state the math in the task).
- IDLE remains INBOX-only; other folders sync each wake cycle sequentially on the
  SAME connection (no new connections — Gmail's 15-connection ceiling).
- New-mail push notifications: INBOX ONLY. High-water mark becomes per
  (account, folder) keyed but only INBOX dispatches. No spam/sent buzzes, tested.
- Starred = `'\Flagged' = any(flags)` across ALL synced folders, virtual, no sync.
- API: GET /api/inbox gains `folder` (inbox|sent|spam|trash|starred, default
  inbox) + `account` (accountId, default all). Keyset cursor unchanged and MUST
  remain lossless under both filters (boundary-timestamp test with filters on).
- Trash/Spam are read-only views in this plan (no move/delete actions yet — that
  is a later plan; no dead buttons shipped).
- All existing floors hold; all three services' review disciplines apply.

### Task 1 (sync): multi-folder sync
Files: sync/src/imap/folders.ts (new: discoverFolders(connection) → {inbox, sent,
spam, trash} via special-use, cached per connection), pool.ts (syncOnce iterates
discovered folders; high-water mark keyed (account, folder); dispatch guard:
notify only folder===INBOX), fetch.ts untouched (HEADER_FETCH_OPTIONS frozen).
Tests: discovery from fake list() with localized names; per-folder marks isolated
(sent UID never suppresses inbox notify); spam new mail → zero dispatch calls;
budget math comment. Floor 448/28 + new.

### Task 2 (sync): API filters
Files: routes.ts thin param parse + db.ts query additions (folder filter =
folder = $n; starred = '\\Flagged' = any(flags); account = account_id = $n; all
parameterized, keyset order/tiebreak unchanged).
Tests: filter+cursor losslessness at shared timestamps; starred crosses folders;
unknown folder value → 400; account+folder compose.

### Task 3 (client): sidebar wiring
Files: AppShell (folder nav section with lucide icons + active state, account rows
clickable with All-accounts row + active state, counts stay), App (view state:
{folder, account} lifted; Inbox title reflects selection), api.ts (params through
getInbox), InboxList (empty-state copy per folder — "No starred messages" etc.,
honest per-folder).
Tests: pure state helpers; existing floors.

### Task 4: deploy + verify (controller)
Battery: /api/inbox?folder=sent authed 200 with rows from Sent; ?folder=starred
returns flagged; ?account=harvard filters; unknown folder 400; UI click-through
at 1280/400 both states; THEN sync observes: journal shows 16 folder syncs/cycle.
