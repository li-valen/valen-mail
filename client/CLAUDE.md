# Postbox client — frontend build guide

Derived from ~/frontend-CLAUDE.md. That file stays a template; this is its
filled-in instance for this project. Read that file for the full tier tables.

## Project decisions

```
Direction skill:   impeccable          (Tier 1 — product UI / app shell)
Component source:  hand-rolled on tokens; pick-ui-library ONLY for virtualization
Motion library:    motion/react        (single layer — no animista, no GSAP)
Icon set:          lucide-react        (one family, never both)
```

### Why these

**Direction — `impeccable`.** The guide's stated default for product UI, dashboards
and app shells, which is what an inbox is. Direction was already narrowed by the
live 4-way picker the user chose from ("Direction A / Chronology"), which is the
guide's own "I don't know what I want" path: prototype -> picker -> direction skill
on the winner. `impeccable` runs on the winner. Per rule 3 it runs ONCE; after
DESIGN.md exists, stop re-invoking it.

**No second direction-setter.** taste-skill, ui-ux-pro-max and
ecc:frontend-design-direction are deliberately NOT used. The guide's Traps section
is explicit that stacking them averages into exactly the templated look they exist
to prevent, and the user's brief is "different from other email providers".

**Components — hand-rolled, deliberately, against Tier 3's default advice.**
Tier 3 says check shadcn first. Checked, and declined here for two reasons:
shadcn's default look is currently the single most recognizable AI-generated-app
aesthetic (the artifact-design skill flags it by name), which fights the brief; and
it requires Tailwind + Radix for what is roughly six components, colliding with the
already-specified theme.css token approach. The real interactive surface is a
toggle, a rail and a list.
This trade is only acceptable BECAUSE a11y is verified rather than assumed —
ecc:frontend-a11y reviews the hand-rolled semantics, and if it finds hand-rolling
insufficient, Radix primitives get added for those specific controls (Radix alone,
without Tailwind). YAGNI now, verified later, not assumed either way.
`pick-ui-library` is consulted if/when the 60,460-message list needs virtualization.

## Chain for this project (guide rule 2: direction -> components -> motion -> a11y -> verify)

1. `impeccable`            -> client/DESIGN.md          [direction, once]
2. `ecc:design-system`     -> tokens, scales             [after direction]
3. build Tasks 3/4/5 against DESIGN.md
4. `ecc:react-patterns` + `ecc:react-performance`        [after UI works]
5. `ecc:motion-patterns` / `animate`                     [NOT before layout is settled]
6. `review-animations`                                   [builder != reviewer, rule 4]
7. `ecc:frontend-a11y` + `ecc:accessibility`             [non-optional]
8. `ecc:make-interfaces-feel-better`                     [last, on a working UI]
9. `ecc:browser-qa`                                      [never call it done on code alone]

## Standing constraint

No test in Plan 3 renders a component. Layout, theme and focus are unverified by
the suite, and the dark/light token split is the exposed case: a colour defined
only inside a media block renders one theme's text on the other theme's ground.
Step 9 is therefore mandatory, in BOTH colour schemes, at mobile and desktop widths.
