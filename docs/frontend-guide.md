# Frontend build guide

Drop this in a project root as `CLAUDE.md` when the work is frontend.
It routes between an overlapping skill library — coverage is not the problem, overlap is.
Loading three design skills for one task gives three vocabularies and no decision.

## The five rules

1. **One direction-setter per project. Never two.** (Tier 1.)
2. **Direction → components → motion → a11y → verify.** Motion on an undecided layout is wasted work.
3. **Set direction once per project, not once per task.** Record the outcome in this file, then stop re-invoking the direction skill.
4. **Builders and reviewers are different skills.** `animate` builds, `review-animations` judges. Never let the builder grade itself.
5. **Prefer `ecc:`-prefixed skills where a bare name collides.** The bare copies in `~/.claude/skills/` are older forks.

---

## Project decisions

Fill these in once, at the start. Everything below reads from them.

```
Direction skill:   impeccable             PROPOSED - confirm at Plan 3
Component source:  shadcn + pick-ui-library   PROPOSED - confirm at Plan 3
Motion library:    motion/react           PROPOSED - confirm at Plan 3
Icon set:          lucide                 PROPOSED - confirm at Plan 3
```

**These are PROPOSED, not set.** The guide's own rule 3 says direction is set once
per project and then recorded — so these get confirmed or overridden deliberately at
the start of Plan 3, not inherited by accident. Reasoning behind each proposal:

- **`impeccable`** over `taste-skill`: Postbox is a long-lived product UI — app shell,
  dense message lists, compose forms, empty states — which is exactly the split the
  guide draws. `taste-skill` is for landing pages and marketing sites. Not both
  (guide: stacking direction skills produces averaged mush).
- **`pick-ui-library` over smoothui/unlumen**: an email client's hard problem is
  **list virtualization** — a 50k-message unified inbox cannot render naively — plus a
  command menu for the Superhuman-style keyboard flow. Those are precisely what
  `pick-ui-library` is for. smoothui and unlumen are weighted toward marketing blocks
  and cursor craft, which this app does not need. Neither is chosen, per the guide's
  "pick one, not both" rule, because the right answer may be neither.
- **`motion/react`** via the `ecc:motion-foundations` -> `-patterns` tier order: the
  Superhuman feel depends on interruptible transitions, which rules out `animista`
  (pure CSS keyframes cannot interrupt cleanly).
- **`lucide`**: shadcn's default. Adding Phosphor means two visual grammars for no gain.

**Relocate this file to the client package root as `CLAUDE.md` when Plan 3 scaffolds
it.** It lives in `docs/` for now deliberately — at the repo root it would load on every
backend task in `tracking/`, which is listing noise with no frontend in scope.

---

## Tier 1 — Design direction (pick exactly ONE)

| Skill | Use for | Skip when |
|---|---|---|
| **`impeccable`** | **Default for product UI.** Deepest vocabulary — 7 pillars, anti-pattern detection, 23 sub-commands (`/impeccable polish`, `audit`, `critique`, `distill`, `harden`, `animate`, `colorize`). Dashboards, app shells, forms, onboarding, empty states. | A single-component tweak. |
| **`taste-skill:design-taste-frontend`** | **Landing pages, portfolios, marketing sites**, and "make this not look AI-generated". Best at inferring a direction from a loose brief. | Long-lived apps that need a real design system. |
| **`frontend-design`** | Small self-contained UI needing judgment without a whole process. Lightest of the three. | An audit or systematic pass is wanted. |
| **`ecc:frontend-design-direction`** | ECC-house-style production work. | Alongside `impeccable` — same job. |
| **`ui-ux-pro-max`** | **Lookup only** — 161 palettes, 57 font pairings, 50+ styles, 99 UX guidelines. Pull a palette *from* it. | As the direction-setter. It's a catalog, not a point of view. |

### taste-skill specifics

Folder names and invoke names differ — invoke by the **name**, not the folder:

| Want | Invoke |
|---|---|
| General default (v2, experimental) | `taste-skill:design-taste-frontend` |
| Pin the older, stable behavior | `taste-skill:design-taste-frontend-v1` |
| Audit-first upgrade of an existing site | `taste-skill:redesign-existing-projects` |
| Calm, expensive, spacious | `taste-skill:high-end-visual-design` |
| Editorial product UI (Notion/Linear) | `taste-skill:minimalist-ui` |
| Swiss/terminal, hard contrast | `taste-skill:industrial-brutalist-ui` |
| Agent keeps truncating output | `taste-skill:full-output-enforcement` |

`design-taste-frontend` exposes three 1–10 dials at the top of its file. Set them explicitly rather than accepting defaults:

- **DESIGN_VARIANCE** — low: centered and clean · high: asymmetric and modern
- **MOTION_INTENSITY** — low: hover only · high: scroll-driven and magnetic
- **VISUAL_DENSITY** — low: spacious · high: dense dashboards

Skip on Claude Code: `gpt-taste` (GPT/Codex-targeted), `image-to-code` and `stitch-design-taste` (other harnesses), `brandkit` / `imagegen-frontend-web` / `imagegen-frontend-mobile` (need an external image generator).

Source: https://github.com/Leonxlnx/taste-skill · update with `npx skills add https://github.com/Leonxlnx/taste-skill`

## Tier 2 — Design system & tokens

- **`ecc:design-system`** — three-layer tokens (primitive → semantic → component), CSS variables, spacing and type scales. **After** direction, **before** components.
- **`ui-styling`** — shadcn + Tailwind + Radix implementation patterns. The "how do I write it" layer.
- **`ecc:make-interfaces-feel-better`** — polish checklist: spacing, borders, shadows, hit areas, optical alignment. Run **last**, on a working UI.
- **`brand`** / **`ecc:brand-discovery`** — only when the deliverable carries a brand identity.

## Tier 3 — Component sourcing (don't hand-roll)

Check in this order before writing a component from scratch:

1. **`shadcn`** — the base layer. Buttons, dialogs, forms, selects, tables. Owns `components.json`, theming, and registry config for everything below.
2. **`pick-ui-library`** — for the hard specifics: numbers, OTP inputs, charts, command menus, virtualization, drag-and-drop. Ask it **before** npm-searching, so we don't install something abandoned.
3. **`smoothui`** — 130 animated React components + 34 marketing blocks. Best at AI chat interfaces, shader page transitions, text effects, and complete landing sections (`header-*`, `pricing-*`, `faq-*`, `footer-*`).
4. **`unlumen-ui`** — 181 free + 54 Pro motion components. Best at cursor/pointer craft, tooltips, highlights, tilt, scroll reveals, and the low-level `primitives-effects-*` / `primitives-texts-*` layer to wrap our own elements.
5. **`21st-cli`** — when it should come from the 21st.dev catalog or a team registry.

> **Pick smoothui OR unlumen, not both.** They overlap heavily (animated text, counters, magnetic buttons, cursors) with different motion languages. Two = incoherent.

**Supporting:** `phosphor-icons` (grep the bundled name list before writing an icon name — the naming is not the obvious one: `caret-right` not `chevron-right`, `magnifying-glass` not `search`) · `ask-sonner` (toasts) · `migrate-radix-to-base`.

## Tier 4 — Motion

**Judgment layer** — wrap these around the implementation:

| Skill | Role |
|---|---|
| `emil-design-eng` | The philosophy. Load whenever motion quality matters. |
| `animate` | **Builds** one animation in the right decision order: should it animate → which property → curve → duration → interruption → exit. |
| `review-animations` | **Judges** existing motion against a strict bar. Run on every diff touching animation. |
| `improve-animations` | Audits a whole codebase, emits prioritized plans other agents can execute. |
| `find-animation-opportunities` | Read-only: where motion is *missing* — and what not to animate. |
| `animation-vocabulary` | Reverse lookup: "the bouncy thing when a popover opens" → the real term. Use when the user is describing, not naming. |
| `apple-design` | Gesture-driven UI, springs, sheets, interruptible transitions, translucent materials. |
| `animate-expo` | Same bar for React Native / Expo (Reanimated, Gesture Handler, haptics). |

**Implementation layer** — pick by the project's library:

- **`framer-motion-react` / `-layout` / `-scroll` / `-gestures` / `-variants`** — API reference. Load only the one matching the task.
- **`ecc:motion-foundations` → `ecc:motion-patterns` → `ecc:motion-advanced`** — tiered React/Next system on `motion/react`: tokens and spring presets → button/modal/toast/stagger/page transitions → drag, SVG path, imperative sequences. Follow the tier order.
- **`animista`** — 671 pure-CSS keyframes bundled locally. Right for static sites and no-JS-library projects. **Wrong** if Motion or GSAP is already present — never run two animation layers.
- **`motion-design`** — framework-agnostic timing/easing/choreography principles.
- **`scroll-world`** — scroll-driven 3D "brand world" landing pages: generates scenes, camera flights, frame-matched connector clips, plus a drop-in scroll engine. Big, specific, expensive.
- **`animmaster-lib`** — only if the paid Animmaster folder is on disk. Ask for the path first; nothing is fetchable.

**Default motion chain:** `animate` → `review-animations` → fix. Whole app: `improve-animations` first, then execute its plans.

## Tier 5 — Framework correctness & performance

`ecc:react-patterns` (hooks discipline, server/client boundaries, Suspense, form actions) · `ecc:react-performance` (70+ Vercel rules) · `ecc:frontend-patterns` · `ecc:nextjs-turbopack` · `ecc:vite-patterns` · `bun-runtime`.

Other stacks: `ecc:vue-patterns` · `ecc:nuxt4-patterns` · `ecc:angular-developer` · `ecc:react-native-patterns` · `ecc:swiftui-patterns`.

Run **after** the UI works, **before** review. These catch the bug class design skills are blind to.

## Tier 6 — Accessibility (non-optional)

`ecc:accessibility` (WCAG 2.2 AA) · `ecc:frontend-a11y` (React/Next: semantic HTML, ARIA, focus management, keyboard nav) · `ecc:a11y-architect` agent for design-system-level work.

Every interactive component ships with keyboard access, visible focus, and a `prefers-reduced-motion` path. Check before declaring done.

## Tier 7 — Verification

`ecc:browser-qa` · `ecc:click-path-audit` · `e2e-testing` / `ecc:react-testing` · `ecc:ui-demo` (Playwright walkthrough video) · `gsd-ui-review` (retroactive 6-pillar visual audit).

**Never call frontend work done on the strength of the code alone.** Run it and look at it.

## Tier 8 — Exploration & deliverables

- **`prototype`** — several genuinely different versions behind a live picker. The right move when the user doesn't know what they want. Beats asking.
- **`gsd-sketch`** (throwaway HTML mockups) · **`gsd-ui-phase`** (UI-SPEC design contract)
- **`frontend-slides`** / **`slides`** (HTML presentations) · **`banner-design`** · **`design`** (logos, identity, icons)
- **`remotion-best-practices`** — router into the 12 official Remotion skills (`-create`, `-markup`, `-render`, `-studio`, `-captions`, `-multimedia`, `-maps`, `-interactivity`, `-saas`, `-docs`, `-upgrade`). **Enter through the router, not the leaves.**
- **`video-editing`** / **`fal-ai-media`** — real-footage pipelines and AI media generation.

---

## Standard chains

**New landing page**
`taste-skill:design-taste-frontend` → `smoothui` blocks (header/features/pricing/faq/footer) → `animate` on the hero only → `review-animations` → `ecc:accessibility` → `ecc:browser-qa`

**New product UI / dashboard**
`impeccable` → `ecc:design-system` → `shadcn` + `pick-ui-library` → `ecc:react-patterns` → `ecc:motion-patterns` → `ecc:frontend-a11y` → `ecc:browser-qa`

**Redesign an existing page**
`taste-skill:redesign-existing-projects` or `/impeccable audit` (**audit first, always**) → apply → `ecc:make-interfaces-feel-better` → `ecc:browser-qa`

**"Make this feel better"**
`ecc:make-interfaces-feel-better` + `find-animation-opportunities` → `animate` the two or three that earn it → `review-animations`

**"Add an animation to X"**
`animate` → `review-animations`. Nothing else.

**"I don't know what I want"**
`prototype` (3–4 versions, live picker) → direction skill on the winner.

**Plain CSS / static site**
`frontend-design` → `animista` → done. No React skills.

---

## Traps

- **`ecc:taste` is not a UI taste skill.** It's creative direction for music videos and short-form edits. For UI taste use `taste-skill:design-taste-frontend` or `impeccable`.
- **32 skills exist under both a bare name and `ecc:`** — `frontend-patterns`, `design-system`, `frontend-slides`, `nextjs-turbopack`, `e2e-testing`, `bun-runtime`, `api-design`, `backend-patterns`, `coding-standards`, `security-review`, `tdd-workflow`, `verification-loop`, `video-editing`, `deep-research`, `exa-search` and more. The `~/.claude/skills/` copies are older forks (May–Jul 2026); the `ecc:` copies are current (Aug 2026). **Prefer `ecc:`.**
- **`~/.claude/skills/` holds 46 empty directories** (`autoplan`, `qa`, `ship`, `review`, `design-review`, `design-shotgun`, `design-consultation`, `design-html`, `benchmark`, `browse`, `canary`, `codex`, `learn`, `retro`, `skillify`, …) with no `SKILL.md`. They do nothing but add listing noise. Safe to delete.
- **Don't stack direction skills.** `impeccable` + `taste-skill` + `ui-ux-pro-max` in one task produces averaged mush — precisely the templated output all three exist to prevent.
- **Don't stack motion layers.** CSS keyframes + Motion + GSAP in one project makes interruption and sequencing incoherent. One layer.
- **Don't mix icon families.** shadcn defaults to `lucide-react`; adding Phosphor means two visual grammars. Migrate fully or stay put.
