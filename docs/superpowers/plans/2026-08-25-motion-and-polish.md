# Motion, Search and Polish Implementation Plan (Plan 7)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Make Postbox feel built rather than assembled. User: *"a lot of animations…
when I click the sidebar it's almost instant, it's weird… you want this to kinda look
like Gmail… search bar on top, I click it, there's an animation… make it very smooth…
longer descriptions at the bottom, make things fit better… have your own creative
expression."*

**Architecture:** Three separable concerns. (1) Data the UI needs but doesn't have —
message previews and search. (2) A motion system, applied per the project's frontend
guide's decision order. (3) Density/typography polish, applied last on a working UI.

**Spec:** user directive 2026-08-25; `client/CLAUDE.md` (frontend routing rules);
`client/DESIGN.md` §5 read-state semantics (still binding).

## Global Constraints
- **Motion library: `motion` (motion/react).** It was removed as a zombie dep when
  nothing imported it; it comes back now because it is genuinely needed. ONE motion
  layer — no CSS keyframe library alongside, no GSAP.
- **`prefers-reduced-motion` is not optional.** Every transition needs a reduced path
  that removes motion rather than shortening it. A guard test enforces it.
- Dark mode is live: semantic palette or explicit `dark:` variants; the
  hardcoded-neutral guard runs with an empty allowlist.
- XSS: subjects, senders, snippets and search results are attacker-authored → text only.
- $0. No new deps beyond `motion`.
- Suite floors: tracking 104 · sync 702 · client 508.

---

### Task 1 (sync): message previews + search
**Files:** Modify `sync/src/imap/fetch.ts`, `sync/src/normalize.ts`, `sync/src/db.ts`,
`sync/src/api/inbox.ts`, `routes.ts` (thin branch); Test: fetch/normalize/db/search.

**Previews.** `makeSnippet(raw.bodyText)` already exists; `bodyText` is never
populated because the sync path is header-only. 461 rows, 0 snippets.
- **`HEADER_FETCH_OPTIONS` is frozen by an exact-shape causal-guard test** — the byte
  budget estimate is only valid for header-only fetches. Do NOT widen it silently.
  Fetch a bounded preview as a SEPARATE, explicitly-budgeted step: IMAP partial fetch
  (`BODY.PEEK[1]<0.NNN>`, ~512 bytes) so a 4MB mail costs 512 bytes, and PEEK so
  reading a preview never sets `\Seen`.
- Update `ESTIMATED_BYTES_PER_HEADER_FETCH`'s companion accounting so the budget sees
  the new bytes. State the new per-message arithmetic in a comment.
- Strip quoted text and signatures crudely (leading `>` lines, `-- ` blocks) so the
  preview shows new content, as Gmail's does. `makeSnippet`'s existing char cap stands.
- Backfill is out of scope: new syncs populate it; existing rows stay NULL and the UI
  must render fine either way (Task 3 handles absence).

**Search.** `GET /api/search?q=…&limit=…` — case-insensitive over `subject`,
`from_name`, `from_email`, and `snippet`. Parameterized; `ILIKE` with escaped
wildcards is acceptable at this scale (461 rows) — do NOT add a tsvector column or an
extension. Compose with the existing `folder`/`account` filters. Same auth gate,
`PRIVATE_NO_STORE`, same cursor shape or an explicit no-pagination decision (state it).
Empty `q` → 400. `q` length-capped.

### Task 2 (client): the motion system
**Files:** Create `client/src/motion/` (tokens + shared variants); Modify the shell,
sidebar nav, view transitions, reader open/close, composer open/close, rail rows.

**Use the project's frontend skills, in the guide's decision order.** Invoke
`emil-design-eng` for the philosophy and `animate` to build — it enforces the order
(should it animate → which property → curve → duration → interruption → exit). Do NOT
invoke `review-animations` yourself; the guide is explicit that builders and reviewers
are different skills, and a separate reviewer runs after.

Non-negotiables regardless of what the skills suggest:
- **Interruptible.** Clicking a second nav item mid-transition must not queue or jank.
- **Transform/opacity only** for anything that runs per-frame; never animate layout
  properties on a list of 50+ rows.
- **The list must not re-animate on every poll.** The opens feed refreshes on an
  interval — only genuinely-new rows animate in, and identity must be keyed on
  something stable (the token), not array index.
- Durations in the 120–260ms band for UI feedback; nothing over 400ms.

### Task 3 (client): search bar + density polish
**Files:** Create `client/src/components/SearchBar.tsx`; Modify `MessageRow`,
`InboxList`, `AppShell`.
- **Gmail-shaped search bar in the top bar** — expands on focus (this is the specific
  interaction the user named), Cmd/Ctrl-K to focus, Esc clears and blurs, debounced,
  results replace the list with a clear "searching X" affordance and a way back.
- **Preview line in rows** (the user's "longer descriptions at the bottom"): sender,
  subject, then a muted snippet line, truncating cleanly. **Must look right when
  `snippet` is null** — no reserved empty line, no layout shift between rows that have
  one and rows that don't.
- Fit and rhythm: consistent vertical rhythm, aligned columns, no orphaned single
  words, sensible max line lengths.

### Task 4: motion review + polish audit
Separate agents: `review-animations` on the motion diff, and
`ecc:make-interfaces-feel-better` on the working UI (the guide says: run it LAST).
Then one fix wave.

## Self-Review
Coverage: previews→T1+T3, search→T1+T3, animation→T2, "fit better"→T3, creative
latitude→T2/T3 explicitly. The frozen fetch-options guard is the main hazard and is
called out. No placeholders.
