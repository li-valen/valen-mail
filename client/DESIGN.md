# Postbox — DESIGN.md

> **Superseded by the Plunk rebase** (see `client/CLAUDE.md`'s "Direction pivot 2") — the visual values below no longer apply.
> §5's read-state semantics and copy voice remain binding.

The visual contract for the Postbox client. Written for an implementer who was not in
the design conversation. Every value here is literal. Where a number is stated, use that
number; do not substitute one that "looks about right."

Read `client/CLAUDE.md` first for the tooling decisions (hand-rolled components, plain
CSS custom properties, `lucide-react`, no Tailwind, no shadcn). Those are settled and are
not relitigated here.

**Provenance.** Direction set once with `impeccable` (Operate mode), token structure from
`ecc:design-system` (three-layer: primitive → semantic → component). The direction
"Chronology" was pinned by the user from a live 4-way picker, which under the direction
skill's own rule ("a user- or brief-pinned direction beats the roll") pre-empts the
concept roll. `concept-seed.mjs` was additionally blocked because this project has no
`PRODUCT.md` and this task was scoped to a single output file. The seven-candidate
derivation that feeds the roll was therefore run by hand; its result and its rejected
alternates are recorded in §8. Disclosed rather than hidden.

---

## 1. Design thesis

Postbox looks like a strip-chart recorder, not an inbox. Time is a continuous vertical
line down the page and every message and every open event is a mark placed on it, so the
gaps are as readable as the marks — an interval where nothing came back looks different
from an interval where the pen was up. Every other email tracker resolves a read into a
green checkmark; Postbox refuses that, because its own calibration run measured four of
six recorded opens as machines, so the interface is built to typeset uncertainty at the
same size, weight, and contrast as certainty rather than greying it out. Colour appears
in exactly one place — the read-state of a sent message — which makes the palette a
vocabulary of three words instead of a decoration. The one thing this product must never
do is look confident about something it does not know.

**The memory test.** If you saw Postbox once and described it an hour later, you should
say: "it's a line down the page with marks on it, and it tells you when it doesn't know."

---

## 2. Token system

Three layers. **Primitive** tokens are raw values with no meaning. **Semantic** tokens
assign meaning and are the only layer that changes between themes. **Component** tokens
are consumed by exactly one component and resolve to semantic tokens.

Components read semantic and component tokens. **A component may never read a primitive
token directly** — that is how a colour ends up hardcoded to one theme.

### 2.1 The theme structure — read this before you write a single colour

The viewer has **three** states, not two:

| Root state | Meaning |
|---|---|
| no attribute | default; only `prefers-color-scheme` applies |
| `data-theme="light"` | user explicitly chose light |
| `data-theme="dark"` | user explicitly chose dark |

Therefore three blocks are required, in this order:

1. **`:root`** — the *complete* light palette. Every semantic token defined here, no
   exceptions.
2. **`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`** —
   redefines *only* the tokens whose value differs in dark. The `:not()` guard is what
   lets an explicit light choice win over a dark OS.
3. **`:root[data-theme="dark"]`** — redefines the same tokens again, so an explicit dark
   choice wins over a light OS.

> **THE BUG THIS PREVENTS — DO NOT SKIP THIS PARAGRAPH.**
> Any colour whose *only* definition sits inside a `@media` block or a `[data-theme]`
> block is a defect, not a style. In the unstamped default state on a light OS, that
> token is undefined; `var()` falls through to its fallback or to `inherit`, and you get
> one theme's text sitting on the other theme's ground — white-on-white, or dark-on-dark.
> The suite in Plan 3 renders no components, so nothing will catch this for you.
> **Rule: every token appears in bare `:root` first. The other two blocks may only
> *re-*define. If you find yourself adding a new token name inside a media block, stop —
> you are writing the bug.**
> Verification is step 9 of the chain in `client/CLAUDE.md`: check all three root states,
> at both breakpoints, by hand.

`body` **must** set `background: var(--bg-page)` explicitly. A transparent body borrows
the host's ground and defeats the entire palette. This is one line and it is mandatory.

### 2.2 Layer 1 — primitives

Neutrals carry a **blue-violet hue bias (≈260°) at very low chroma**, not a cool-blue
one (≈220°) and not pure grey. Reason: 260° is the hue furthest from *both* semantic
chromatics (green ≈152°, amber ≈40°), so neither state colour vibrates against the
ground, and it reads as printer's ink rather than as a stock UI slate.

```css
:root {
  /* ---- primitive: neutrals, light ladder ---------------------------- */
  --p-slate-0:    #ffffff;
  --p-slate-25:   #fcfcfd;   /* L 0.974 — paper */
  --p-slate-50:   #f3f3f7;
  --p-slate-100:  #e9e9f0;
  --p-slate-200:  #dbdbe5;
  --p-slate-400:  #8f8f9e;   /* 3.11:1 on slate-25 — meaningful graphics only */
  --p-slate-600:  #6e6e7e;   /* 4.88:1 on slate-25 — smallest text-safe step */
  --p-slate-800:  #33333f;   /* 12.15:1 */
  --p-slate-950:  #14161f;   /* 17.59:1 — primary text */

  /* ---- primitive: neutrals, dark ladder ------------------------------
     Designed for dark, NOT an inversion of the ladder above. The steps
     between grounds are deliberately smaller than in light: a large tonal
     jump between two dark surfaces reads as a hole, not as a layer.       */
  --p-ink-1000:   #0b0b10;   /* page backdrop */
  --p-ink-950:    #101017;   /* rail ground (recessed) */
  --p-ink-900:    #16161f;   /* inbox ground (working surface) */
  --p-ink-850:    #1d1d28;
  --p-ink-800:    #262633;
  --p-ink-600:    #65657d;   /* 3.18:1 on ink-900 — meaningful graphics only */
  --p-ink-400:    #8a8a9d;   /* 5.31:1 — smallest text-safe step */
  --p-ink-200:    #c9c9d6;
  --p-ink-50:     #e9e9f1;   /* 14.88:1 — primary text. NOT #fff: pure white
                                on near-black is glare, not contrast.       */

  /* ---- primitive: the three read-state chromatics --------------------
     Each pair is chosen independently per ground, never lightened
     algorithmically. Measured contrast is in the comment.                */
  --p-green-700:  #2d6a4f;   /* 6.23:1 on slate-25  */
  --p-green-400:  #4aa47a;   /* 5.89:1 on ink-900   */
  --p-amber-800:  #9a5a0a;   /* 5.33:1 on slate-25  */
  --p-amber-400:  #cf8b22;   /* 6.31:1 on ink-900   */
  --p-steel-700:  #4a5691;   /* 6.76:1 on slate-25  */
  --p-steel-300:  #8e99e0;   /* 6.66:1 on ink-900   */

  /* washes — the only tinted fills in the product */
  --p-green-wash-l:  #e4f0ea;  /* green-700 on it: 5.46:1 */
  --p-amber-wash-l:  #f6ecdc;  /* amber-800 on it: 4.67:1 */
  --p-steel-wash-l:  #e7e9f5;  /* steel-700 on it: 5.73:1 */
  --p-green-wash-d:  #16281f;  /* green-400 on it: 5.07:1 */
  --p-amber-wash-d:  #2c1f0c;  /* amber-400 on it: 5.63:1 */
  --p-steel-wash-d:  #1c1e33;  /* steel-300 on it: 6.07:1 */
}
```

**Load-bearing decisions in this table**

- The three chromatics land in a tight contrast band on both grounds (light 5.3–6.8,
  dark 5.9–6.7). That is deliberate and it is the thesis in numbers: **none of the three
  read-states outranks the others.** `confirmed` is not "success" and `unconfirmable` is
  not "failure"; they are three peer findings. Do not "fix" this by making confirmed
  louder.
- `unconfirmable` is *steel-indigo*, not grey, and specifically it is the colour of the
  machine — a machine touched this message, not a person. Grey would read as disabled.
- `--p-slate-400` / `--p-ink-600` are **never text.** They sit at ~3:1, which is the
  non-text minimum for a meaningful graphic (the time spine) and below the 4.5:1 text
  minimum. Placeholder text uses the 600/400 step. This is not negotiable; craft floor.

### 2.3 Layer 2 — semantic (the complete three-block structure, copyable)

```css
/* =====================================================================
   1. BARE :root — the COMPLETE light palette. Every semantic token
      that exists in this product is defined here and nowhere else first.
   ===================================================================== */
:root {
  color-scheme: light dark;

  /* grounds */
  --bg-page:        var(--p-slate-50);   /* body. Explicit. Mandatory. */
  --bg-inbox:       var(--p-slate-25);   /* the paper — the working surface */
  --bg-rail:        var(--p-slate-50);   /* the casing — recessed one step  */
  --bg-raised:      var(--p-slate-0);    /* popovers, sheets */
  --bg-hover:       var(--p-slate-100);
  --bg-active:      var(--p-slate-200);
  --bg-skeleton:    var(--p-slate-100);

  /* foregrounds */
  --fg-primary:     var(--p-slate-950);
  --fg-secondary:   var(--p-slate-600);
  --fg-placeholder: var(--p-slate-600);  /* NOT slate-400 — see §2.2 */
  --fg-on-accent:   var(--p-slate-0);

  /* lines. There is exactly one rule in this product and it is vertical. */
  --line-spine:     var(--p-slate-400);  /* the time axis — meaningful */
  --line-border:    var(--p-slate-200);  /* control edges only */

  /* read-states */
  --state-confirmed:          var(--p-green-700);
  --state-confirmed-wash:     var(--p-green-wash-l);
  --state-awaiting:           var(--p-amber-800);
  --state-awaiting-wash:      var(--p-amber-wash-l);
  --state-unconfirmable:      var(--p-steel-700);
  --state-unconfirmable-wash: var(--p-steel-wash-l);
  --state-unavailable:        var(--p-slate-600);  /* achromatic, on purpose */
  --state-unavailable-wash:   var(--p-slate-100);

  /* focus — two-layer ring, achromatic, legible on every fill above */
  --focus-inner:    var(--p-slate-25);
  --focus-outer:    var(--p-slate-950);

  /* browser surfaces (craft floor: the parts you did not draw) */
  --selection-bg:   var(--p-steel-wash-l);
  --selection-fg:   var(--p-slate-950);
  --caret:          var(--p-slate-950);
  --scrollbar-thumb:var(--p-slate-200);
  --scrollbar-track:transparent;
}

/* =====================================================================
   2. DEFAULT (unstamped) + dark OS. The :not() guard is what makes an
      explicit light choice beat a dark OS. REDEFINES ONLY. Never
      introduce a token name here that block 1 does not already have.
   ===================================================================== */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg-page:        var(--p-ink-1000);
    --bg-inbox:       var(--p-ink-900);
    --bg-rail:        var(--p-ink-950);
    --bg-raised:      var(--p-ink-850);
    --bg-hover:       var(--p-ink-850);
    --bg-active:      var(--p-ink-800);
    --bg-skeleton:    var(--p-ink-850);

    --fg-primary:     var(--p-ink-50);
    --fg-secondary:   var(--p-ink-400);
    --fg-placeholder: var(--p-ink-400);
    --fg-on-accent:   var(--p-ink-1000);

    --line-spine:     var(--p-ink-600);
    --line-border:    var(--p-ink-800);

    --state-confirmed:          var(--p-green-400);
    --state-confirmed-wash:     var(--p-green-wash-d);
    --state-awaiting:           var(--p-amber-400);
    --state-awaiting-wash:      var(--p-amber-wash-d);
    --state-unconfirmable:      var(--p-steel-300);
    --state-unconfirmable-wash: var(--p-steel-wash-d);
    --state-unavailable:        var(--p-ink-400);
    --state-unavailable-wash:   var(--p-ink-850);

    --focus-inner:    var(--p-ink-1000);
    --focus-outer:    var(--p-ink-50);

    --selection-bg:   var(--p-steel-wash-d);
    --selection-fg:   var(--p-ink-50);
    --caret:          var(--p-ink-50);
    --scrollbar-thumb:var(--p-ink-800);
    --scrollbar-track:transparent;
  }
}

/* =====================================================================
   3. EXPLICIT DARK. Identical body to block 2, so an explicit dark
      choice beats a light OS. Yes, it is duplicated. Do not try to
      collapse blocks 2 and 3 with :is() or a shared custom-property
      indirection — every attempt so far has produced a selector that
      silently loses to the media query in one of the three root states.
   ===================================================================== */
:root[data-theme="dark"] {
  --bg-page:        var(--p-ink-1000);
  --bg-inbox:       var(--p-ink-900);
  --bg-rail:        var(--p-ink-950);
  --bg-raised:      var(--p-ink-850);
  --bg-hover:       var(--p-ink-850);
  --bg-active:      var(--p-ink-800);
  --bg-skeleton:    var(--p-ink-850);

  --fg-primary:     var(--p-ink-50);
  --fg-secondary:   var(--p-ink-400);
  --fg-placeholder: var(--p-ink-400);
  --fg-on-accent:   var(--p-ink-1000);

  --line-spine:     var(--p-ink-600);
  --line-border:    var(--p-ink-800);

  --state-confirmed:          var(--p-green-400);
  --state-confirmed-wash:     var(--p-green-wash-d);
  --state-awaiting:           var(--p-amber-400);
  --state-awaiting-wash:      var(--p-amber-wash-d);
  --state-unconfirmable:      var(--p-steel-300);
  --state-unconfirmable-wash: var(--p-steel-wash-d);
  --state-unavailable:        var(--p-ink-400);
  --state-unavailable-wash:   var(--p-ink-850);

  --focus-inner:    var(--p-ink-1000);
  --focus-outer:    var(--p-ink-50);

  --selection-bg:   var(--p-steel-wash-d);
  --selection-fg:   var(--p-ink-50);
  --caret:          var(--p-ink-50);
  --scrollbar-thumb:var(--p-ink-800);
  --scrollbar-track:transparent;
}

/* mandatory */
body {
  background: var(--bg-page);
  color: var(--fg-primary);
}
::selection { background: var(--selection-bg); color: var(--selection-fg); }
:root { caret-color: var(--caret); scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track); }
```

**Note the ground inversion that is *not* an inversion.** In light, the inbox is the
*lightest* surface and the rail is one step darker. In dark, the inbox is *lifted*
(`ink-900`) above the rail (`ink-950`) and the page backdrop (`ink-1000`). The
relationship is preserved — paper is brighter than casing — but the values were chosen
for each ground independently, and the dark steps are smaller because dark surfaces
separate at lower contrast.

### 2.4 Layer 3 — component tokens

```css
:root {
  /* spacing — 4px base. Layout uses `gap`, never per-element margins. */
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px; --s-5: 20px;
  --s-6: 24px; --s-8: 32px; --s-10: 40px; --s-12: 48px; --s-16: 64px;

  /* radius — deliberately tiny. Nothing in this product is rounded-lg. */
  --r-sm:   3px;    /* chips, controls, popover */
  --r-full: 9999px; /* the confirmed mark and the awaiting ring, only */

  /* shell */
  --shell-toolbar-h: 56px;
  --shell-rail-w:    340px;
  --shell-strip-h:   44px;
  --shell-inbox-max: 72rem;   /* 1152px — dense data, wider than prose */
  --measure:         65ch;    /* running prose only */

  /* the spine */
  --spine-w:         1px;
  --spine-inset:     20px;    /* distance from the rail's leading edge */
  --mark-size:       9px;

  /* rows */
  --row-min-h:       64px;
  --row-pad-x:       var(--s-4);
  --hit-min:         44px;    /* iOS touch target floor */

  /* breakpoints (documentation only — CSS custom properties cannot be
     used inside a media query condition; write the px literal) */
  --bp-rail:         1080px;
  --bp-compact:      720px;

  /* motion */
  --dur-fast: 120ms;
  --dur-base: 180ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

---

## 3. Type

### 3.1 Families and the link tag

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
```

```css
:root {
  --font-ui:      "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system,
                  "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono:    "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo,
                  Consolas, "Liberation Mono", monospace;
  --font-display: "Bricolage Grotesque", var(--font-ui);
}
```

**Why these three, given that IBM Plex is a known default face.** Plex Sans and Plex Mono
are one designed superfamily on a shared skeleton with compatible metrics. In this UI a
mono timestamp sits inline, on the same baseline, in the same row, as a sans sender name
— hundreds of times per screen. Metric compatibility there is structural, not stylistic,
and no unrelated sans/mono pairing supplies it as cheaply. **The mono is not a costume for
"technical":** it is only ever used where characters must align in a column or where the
string is a literal value (timestamps, addresses, classification tokens). Never set a
sentence in mono.

**Bricolage Grotesque has exactly one job: the day rules.** It appears nowhere else — not
in headings, not in buttons, not in labels, not in empty states. Operate mode forbids
display faces in UI chrome, and a display face applied broadly is how this design becomes
a template. The day rule is the spine's calibration mark, so it is set condensed, like a
date stamped on a chart:

```css
.day-rule__label {
  font-family: var(--font-display);
  font-variation-settings: "wdth" 85, "opsz" 24;
  font-weight: 600;
}
```

If the extra webfont request is not worth one element, cut Bricolage entirely and set the
day rule in `--font-ui` at 600 with `letter-spacing: 0.08em; text-transform: uppercase`.
Do not redeploy Bricolage somewhere else to justify it. *(Flagged for a human call — §9.)*

### 3.2 The scale

Fixed rem, never `clamp()`. Product UI is read at consistent DPI; a heading that shrinks
inside a panel looks worse, not better. Ratio ≈1.13 through the UI range, with one
deliberate jump at the display step.

| Token | px / rem | Weight | Line-height | Tracking | Family | Role |
|---|---|---|---|---|---|---|
| `--t-2xs` | 11 / 0.6875 | 500 | 1.35 | 0.06em | mono | classification token (`MPP`), micro-labels |
| `--t-xs`  | 12 / 0.75   | 400 | 1.35 | 0      | mono | timestamps, lag values, address stubs |
| `--t-sm`  | 13 / 0.8125 | 400 | 1.45 | 0      | ui   | rail body text, secondary meta |
| `--t-base`| 15 / 0.9375 | 400 | 1.40 | -0.006em | ui | inbox row default, controls |
| `--t-md`  | 17 / 1.0625 | 400 | 1.60 | -0.008em | ui | message body prose (at `--measure`) |
| `--t-lg`  | 20 / 1.25   | 600 | 1.30 | -0.015em | ui | subject line in reading view |
| `--t-xl`  | 26 / 1.625  | 600 | 1.15 | -0.020em | display | day rule label |
| `--t-2xl` | 34 / 2.125  | 600 | 1.08 | -0.028em | ui | the single large moment: empty / unavailable headline |

Weight steps in use: 400 (body), 500 (mono emphasis, sender of an unread), 600 (headings).
Nothing uses 700. Tracking floor is -0.04em and nothing here approaches it.

### 3.3 Non-negotiable type rules

```css
/* Digits align in columns nearly everywhere in this UI. */
.timestamp, .lag, .count, .day-rule__label, table, .rail__entry, .row__meta {
  font-variant-numeric: tabular-nums;
}
/* Headings only. Never on body copy — it produces ragged short lines. */
h1, h2, h3, .empty__headline, .unavailable__headline { text-wrap: balance; }
/* Prose only. Row snippets are single-line clamped, not measured. */
.prose { max-width: var(--measure); }
```

---

## 4. Layout

### 4.1 Desktop shell, ≥1080px

```
┌────────────────────────────────────────────────┬────────────────┐
│  toolbar                              56px     │                │
├────────────────────────────────────────────────┤  opens rail    │
│                                                │  340px         │
│  inbox — one chronological column              │  always        │
│  max-width 72rem, centred                      │  visible       │
│  vertical scroll                               │  own scroller  │
│                                                │                │
└────────────────────────────────────────────────┴────────────────┘
```

```css
.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--shell-rail-w);
  grid-template-rows: var(--shell-toolbar-h) minmax(0, 1fr);
  grid-template-areas: "toolbar rail" "inbox rail";
  height: 100dvh;                 /* dvh, not vh — iOS PWA chrome */
  overflow: hidden;               /* the page never scrolls; regions do */
}
.inbox { grid-area: inbox; overflow-y: auto; overscroll-behavior: contain;
         background: var(--bg-inbox); }
.rail  { grid-area: rail;  overflow-y: auto; overscroll-behavior: contain;
         background: var(--bg-rail); }
.inbox__inner { max-width: var(--shell-inbox-max); margin-inline: auto;
                padding-inline: var(--s-6); }
```

`minmax(0, 1fr)` — not `1fr` — or a long unbreakable subject blows the grid out and the
body scrolls sideways.

**The page body never scrolls horizontally.** Any wide content (a message with a fixed-
width table, a code block, a wide quoted signature) is wrapped in its own scroller:

```css
.scroll-x { overflow-x: auto; overscroll-behavior-x: contain; max-width: 100%; }
```

Both regions use `gap`, never per-element margins:

```css
.inbox__inner { display: flex; flex-direction: column; gap: var(--s-2); }
.rail__list   { display: flex; flex-direction: column; gap: var(--s-5); }
.row          { display: grid; grid-template-columns: 1fr auto;
                column-gap: var(--s-4); row-gap: var(--s-1); }
```

### 4.2 The time spine

The spine is the design. It is a **1px vertical line, inset 20px from the rail's leading
edge, running the full scroll height of the rail** — not per-entry, one continuous line —
and every open event is a mark centred on it. It is the *only* rule in the product.
There are **no horizontal rules anywhere**: rows are separated by spacing and by day
rules, never by hairlines.

```css
.rail__list { position: relative; padding-inline-start: calc(var(--spine-inset) + var(--s-4)); }
.rail__list::before {
  content: ""; position: absolute; inset-block: 0;
  inset-inline-start: var(--spine-inset);
  width: var(--spine-w); background: var(--line-spine);
}
/* the unavailable case — the pen is up */
.rail__list[data-available="false"]::before {
  background: none;
  border-inline-start: var(--spine-w) dashed var(--state-unavailable);
}
```

Day rules run in the **inbox** column, on the same time logic: a full-width row carrying
the date label in Bricolage, `--t-xl`, with `--s-10` above and `--s-4` below (more space
above a heading than below it — craft floor).

### 4.3 Below 1080px — the rail collapses, it does not disappear

The rail is *persistent* by the direction's definition, so it may not vanish. It collapses
to a **44px strip pinned to the bottom of the viewport** carrying the single most recent
event as one line: mark, headline, relative time. Tapping the strip opens the full rail.

```css
@media (max-width: 1079px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "toolbar" "inbox";
    grid-template-rows: var(--shell-toolbar-h) minmax(0, 1fr);
  }
  .rail { display: none; }
  .rail-strip {
    position: fixed; inset: auto 0 0 0; z-index: 20;
    min-height: var(--shell-strip-h);
    padding-block-end: env(safe-area-inset-bottom, 0px);
    background: var(--bg-rail);
    border-block-start: 1px solid var(--line-border);
  }
  .inbox { padding-block-end: calc(var(--shell-strip-h) + env(safe-area-inset-bottom, 0px)); }
}
```

The expanded rail is a `<dialog>` sheet, not a modal over the whole app and not a
full-screen takeover:

```css
.rail-sheet[open] {
  position: fixed; inset: auto 0 0 0; margin: 0; width: 100%;
  height: min(70dvh, 520px);
  max-width: 100%; border: 0; border-start-start-radius: var(--r-sm);
  border-start-end-radius: var(--r-sm);
  background: var(--bg-raised); color: var(--fg-primary);
  padding-block-end: env(safe-area-inset-bottom, 0px);
}
.rail-sheet::backdrop { background: color-mix(in oklab, var(--p-ink-1000) 45%, transparent); }
```

Below 720px (`--bp-compact`) the message row drops the snippet line and keeps sender,
subject, receiving-account stub, and timestamp. It does not shrink type; it removes
content. Responsive behaviour here is structural, never fluid typography.

**iOS PWA specifics.** `100dvh` everywhere, never `100vh`. `env(safe-area-inset-*)` on
every fixed edge. `-webkit-tap-highlight-color: transparent` on all interactive elements,
paired with a real `:active` background — never remove the highlight without replacing it.
`overscroll-behavior: contain` on both scrollers so a rail flick does not bounce the page.
`touch-action: manipulation` on buttons to kill the 300ms delay.

---

## 5. The three read-states — the centrepiece

### 5.1 Backend mapping (do not invent a fourth state)

`tracking/src/classify.ts` returns `'self' | 'prefetch' | 'mpp' | 'scanner' | 'open'`.

| Backend value | UI state | Note |
|---|---|---|
| `open` | **Confirmed** | The only demonstrated human read. |
| `mpp` | **Unconfirmable** | Apple MPP. Permanent ceiling — see §5.4. |
| `prefetch` | **Unconfirmable** | Gmail proxy at delivery. |
| `scanner` | **Unconfirmable** | Corporate gateway. |
| `self` | **not rendered at all** | The user viewing their own Sent folder is noise. |
| *no events for this token* | **Awaiting** | Genuinely unknown. |
| *any value not in this table* | **Unconfirmable** | Fail closed. Never default to confirmed. This mirrors `classificationIsConfirmed()`, which is deliberately typed `string` for exactly this reason. |

Three hard bans, all measured:

1. **Never render `deviceClass` or `os`.** They are present on `OpenRow` and an
   implementer will be tempted. Gmail's image proxy strips device attribution, so the
   field is architecturally meaningless. No device, no client name, no location, no city,
   no map, no flag, no "read on iPhone." Not in a tooltip, not in a detail panel.
2. **Never display a lag under 60 seconds as a confirmed open.** The server suppresses
   these (`PREFETCH_WINDOW_MS = 60_000`), and the UI must not reintroduce them by, e.g.,
   rendering a raw hits list.
3. **Never render a checkmark glyph, anywhere in Postbox, for any purpose.** Not
   `lucide-react`'s `Check`, `CheckCircle`, `BadgeCheck`, or any variant. The checkmark
   is the lie this product exists to refuse.

### 5.2 Form carries the state, not colour

Colour alone fails for colour-blind users and is the lazy answer. Each state has a
**distinct silhouette at 9px, distinguishable in greyscale**, plus a literal mono word.
Three redundant encodings: form, colour, text.

| State | Mark | Why this shape |
|---|---|---|
| **Confirmed** | **filled disc**, 9×9, `--r-full`, no stroke | Closed. Something is inside it. A point in time, precisely located. |
| **Awaiting** | **open ring**, 9×9, 1.5px stroke, transparent fill | Same footprint, nothing inside. Not an error — an empty container. |
| **Unconfirmable** | **error bar**: 9px wide × 16px tall — two 9px horizontal caps joined by a 1.5px vertical stem | The only mark taller than it is wide. It has *extent*, not a position. Borrowed from how a lab report typesets a calibrated date: the uncertainty is drawn at the same size as the value, never as a footnote. |
| **Unconfirmable, permanent** (Apple) | error bar **plus a 9px cap rule 3px above the top cap** | The interval is bounded and will not move. Visually terminal. |
| **Unavailable** | **no mark**, and the spine goes dashed for that span | The pen is up. Absence of a mark ≠ a mark meaning absence. |

Draw them as inline SVG in `--mark-size` boxes, `currentColor` fill/stroke, `shape-rendering: geometricPrecision`. Marks are centred on the spine with
`margin-inline-start: calc(var(--mark-size) / -2 - var(--s-4))` relative to the entry.

Every entry also carries a mono `--t-2xs` token: `OPEN` · `—` · `MPP` / `PREFETCH` /
`SCANNER` · `NO SIGNAL`. This is not decoration; it is the greyscale/screen-reader path.

### 5.3 Exact copy — what the rail literally says

Write these strings. Do not paraphrase them; the precision *is* the product.

**Confirmed**
- Headline: `Kate Yu opened this.`
- Meta (mono): `14:06 · 2h 11m after sending`
- Token: `OPEN`
- Expanded note (popover): `A fetch that matches no known prefetcher, more than 60 seconds after send. This is the only signal Postbox treats as a person reading.`

**Awaiting**
- Headline: `No signal yet.` — **never** "Not opened." Postbox cannot make that claim.
- Meta (mono): `sent 14:02 · nothing received`
- Token: `—`
- Expanded note: `Nothing has fetched the image in this message. That is not evidence it went unread — a recipient with images off produces this state forever.`

**Unconfirmable**
- Headline: `Something fetched this. It was not a person.`
- Meta (mono): `14:02 · 4s after sending · MPP`
- Token: `MPP` | `PREFETCH` | `SCANNER`
- Expanded note, per classification:
  - `MPP` → `Apple Mail Privacy Protection downloads every image the moment mail arrives, whether or not anyone looks.`
  - `PREFETCH` → `Gmail's image proxy fetched this at delivery. Any read after it is invisible to us.`
  - `SCANNER` → `A mail gateway scanned this message. Gateway traffic and human reads are indistinguishable here.`

### 5.4 The Apple recipient — a ceiling, not a pending state

When a recipient's events classify `mpp`, that recipient's opens can **never** be
confirmed. The UI must not imply that waiting longer will help.

- Mark: error bar **with the terminal cap**.
- Headline: `Apple Mail. Opens can't be confirmed here.`
- Sub: `Not pending — this is the ceiling for this recipient.`
- Meta (mono): `MPP · permanent`
- **The entry has no spinner, no pulse, no shimmer, no "checking…", and no refresh
  control.** Any motion or affordance implying future resolution is a defect. This is
  the single most important behaviour in this document: a permanently unconfirmable
  recipient that *looks* like it is still loading is exactly the dishonesty Postbox
  exists to remove, wearing a different costume.

---

## 6. Component inventory

Every interactive component ships **all** of: default, hover, focus-visible, active,
disabled, loading, empty, error — whichever apply. Half a set is not a component.

**The focus state, once, for everything.** Two-layer achromatic ring, legible on every
ground and every wash:

```css
:where(a, button, [role="button"], input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--focus-outer);
  outline-offset: 2px;
  box-shadow: 0 0 0 2px var(--focus-inner);
  border-radius: var(--r-sm);
}
```
Never `outline: none` without this replacement. `:focus-visible`, not `:focus`.

**Reduced motion, once, for everything:**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important; animation-iteration-count: 1 !important;
    transition-duration: 1ms !important; scroll-behavior: auto !important;
  }
}
```
End states must be identical with and without motion; nothing may be *only* reachable
through an animation.

| # | Component | Anatomy | States |
|---|---|---|---|
| 1 | `AppShell` | grid; toolbar / inbox / rail | — |
| 2 | `Toolbar` | account filter · spacer · theme toggle · rail toggle (<1080) | default / focus-within |
| 3 | `AccountFilter` | native `<select>` restyled, or a listbox button + popover | default / hover / focus / active / disabled / loading |
| 4 | `ThemeToggle` | 3-position segmented control: System · Light · Dark, writes `data-theme` on `<html>` or removes it for System | default / hover / focus / active / selected |
| 5 | `InboxList` | flex column, `gap: --s-2`; virtualization boundary — see `client/CLAUDE.md` | default / loading / empty / error |
| 6 | `DayRule` | Bricolage label `--t-xl`, `--s-10` above / `--s-4` below; sticky at the inbox scroller top | default / stuck |
| 7 | `MessageRow` | grid `1fr auto`; sender (500 if unread) · subject · snippet (1-line clamp) · receiving-account stub (mono `--t-xs`) · timestamp (mono, tabular) | default / hover (`--bg-hover`) / focus / active (`--bg-active`) / selected / unread |
| 8 | `TimeSpine` | 1px pseudo-element on `.rail__list` | solid / dashed (unavailable) |
| 9 | `StateMark` | inline SVG, `--mark-size`, `currentColor` | confirmed / awaiting / unconfirmable / unconfirmable-permanent |
| 10 | `StateToken` | mono `--t-2xs`, `--r-sm`, wash background, `padding: 2px var(--s-2)` | one per state |
| 11 | `OpenEvent` | mark on spine · headline (`--t-sm`, 500) · recipient · meta (mono `--t-xs`) · token; whole entry is one `<button>` opening the note | default / hover / focus / active / permanent (no hover lift) |
| 12 | `StateNote` | Popover API (`popover` attr) anchored to the entry — **not** an `overflow: hidden` child, which clips | open / closed |
| 13 | `OpensRail` | header (count, mono tabular) · `.rail__list` | default / loading / empty / unavailable |
| 14 | `RailStrip` | fixed 44px bottom bar, one event, `--hit-min` target | default / active / empty / unavailable |
| 15 | `RailSheet` | `<dialog>` bottom sheet, drag handle, close button | open / closed |
| 16 | `Skeleton` | shaped blocks in `--bg-skeleton` matching real row geometry — **never a centred spinner** | loading |
| 17 | `EmptyState` | headline `--t-2xl` · one sentence `--t-md` at `--measure` | — |
| 18 | `UnavailableNotice` | headline `--t-2xl` · sub · mono last-contact line | — |
| 19 | `Button` | quiet (default) / primary (compose) / icon-only (`--hit-min` square, `aria-label` required) | default / hover / focus / active / disabled / loading |
| 20 | `Icon` | `lucide-react` only, one family, `stroke-width: 1.5`, 16px in rows / 18px in toolbar. **No emoji, no Unicode glyphs standing in for icons.** | — |

**No account colour legend.** Four accounts are distinguished by the mono address stub in
the row meta and by the toolbar filter — never by colour. Colour in Postbox means a
read-state and nothing else; four account hues would destroy that in one commit.

**Motion, minimal spec (a full pass runs later).** 120–180ms, `--ease-out`, on state
change and feedback only. One rule that is a *content* decision, not a taste one: **a new
rail entry must not slide, fly, or animate in.** It appears in place with a 180ms
opacity settle. A sliding entry says "this just happened," and an event that arrived
while the tab was backgrounded may be hours old.

---

## 7. Empty, loading, and unavailable

Three different absences. Collapsing any two of them is a defect.

### 7.1 Loading

Skeletons shaped like the real content — row-height blocks in `--bg-inbox`, entry-shaped
blocks on a **solid** spine in the rail. Never a spinner in the middle of a region.
`aria-busy="true"` on the region, and the skeleton carries `aria-hidden="true"` with a
single visually-hidden `Loading opens…` live-region announcement.

### 7.2 Empty — service healthy, nothing has come back

- Spine: **solid**, full height.
- Rail controls: **enabled**.
- Colour: none (this is the absence of *events*, not of *capability* — but see 7.3; the
  distinguishing signal here is the solid spine and the enabled controls).
- Headline (`--t-2xl`): `Nothing has come back yet.`
- Sub (`--t-md`, at `--measure`): `Marks appear here as they arrive. Most of what arrives will not be a person.`

That second sentence is the empty state teaching the interface — the user learns the
product's thesis before the first event lands.

Inbox empty (a filter matched nothing): `No messages from this account in this range.`
with the active filter named and a control to clear it.

### 7.3 Unavailable — the tracking service cannot be reached

Triggered by `available: false` (assumption stated in §9). This must be **visibly
different from empty in at least two independent ways**, because both are blank rails and
a viewer will otherwise read "nothing happened."

| | Empty | Unavailable |
|---|---|---|
| Spine | solid | **dashed**, `--state-unavailable` |
| Rail controls | enabled | **disabled** |
| Colour | — | **fully achromatic** — the only state in the product with no chroma |
| Copy | "Nothing has come back yet." | "Postbox can't reach the tracking service." |

Copy:
- Headline (`--t-2xl`): `Postbox can't reach the tracking service.`
- Sub (`--t-md`): `The rail is blank because nothing is being recorded, not because nothing happened.`
- Meta (mono `--t-xs`): `last contact 11:48 · retrying`
- On the collapsed mobile strip: `Tracking unreachable` with the dashed treatment on the
  strip's top border.

**The colour rule that makes this work.** Every read-state in the rail is chromatic.
Unavailable is the only achromatic one. So "no colour" reads as "no reading available"
rather than as "disabled" — grey is given a job instead of being the leftover. This is
scoped to the rail's state vocabulary; chrome (text, borders, focus rings) is neutral by
construction and is not part of that vocabulary.

Announce the transition into and out of unavailable through an `aria-live="polite"`
region. Do not toast it repeatedly on retry.

### 7.4 Error, inbox side

A sync failure renders in place at the top of the inbox: what failed, which account, and
one retry control. Never a modal; never a red banner that pushes content down and then
disappears. Copy names the problem and the recovery, per craft floor.

---

## 8. Anti-pattern check

What I changed, and why it read as generic. Everything below was in a draft of this
document before it was removed.

**Starting tokens, changed:**

1. `unconfirmable #6b7280` → **`#4a5691` / `#8e99e0`**. `#6b7280` is Tailwind
   `gray-500` verbatim — the single most recognisable AI-app neutral — and, worse, plain
   grey on a UI reads as *disabled*, which is the exact misreading the brief forbids. The
   replacement is steel-indigo: chromatic, so it reads as a stated value; the colour of
   the machine, so the hue carries the meaning; and it lands 6.76:1 / 6.66:1, slightly
   *above* confirmed, because the dominant real case deserves at least equal legibility.
2. `awaiting #b4690e` → **`#9a5a0a` / `#cf8b22`**. Measured: `#b4690e` is 4.12:1 on the
   light ground and fails the 4.5:1 body-text floor. Not a taste change — a defect.
3. `paper #f6f7f9` → **`#fcfcfd` + a `#f3f3f7` rail step**. `#f6f7f9` is `slate-50` and
   its cool-blue hue bias (≈220°) is the default. Re-biased to ≈260° blue-violet, which
   is the hue furthest from *both* semantic chromatics, and split into two grounds so the
   rail can be a recessed layer rather than a border.
4. `ink #10151c` → **a designed dark ladder** (`#0b0b10` / `#101017` / `#16161f` … `#e9e9f1`).
   The original sat at ≈212° and clashed with the neutral ramp's hue. It was also a single
   "darkest ground," which forces dark mode to be an inversion; dark now has its own layer
   relationships with deliberately smaller steps, and primary dark text is `#e9e9f1`, not
   white, because pure white on near-black is glare.

**Structures killed for reading as generic:**

5. **Rounded cards with a coloured left border, one per open event.** My first draft had
   them. That is two named anti-patterns stacked — `rounded-lg` everywhere and an accent
   bar on a rounded card — and it is what every tracker dashboard already looks like.
   Replaced with marks on a continuous spine and **zero containers** in the rail.
6. **Hairline rules between inbox rows.** Broadsheet hairlines are on the avoid list, and
   they were doing nothing that spacing does not do better. There is now exactly **one**
   rule in the product — the vertical time spine — and it is load-bearing, because a
   mark's position on it is data. Radius was cut to 3px so nothing reads as a card.
7. **Numbered markers on rail entries (01 / 02 / 03).** Removed. The opens list is a time
   series, not a sequence; position on the spine already carries ordering, so the numbers
   would have been decoration pretending to be structure.
8. **Four account colours.** Colour was about to become decoration, which would have
   destroyed the "colour means a read-state" rule in one commit. Accounts are named (mono
   address stub) and filtered, not coloured.
9. **Bricolage Grotesque as a general display face.** It was heading everything. Operate
   mode forbids display faces in UI chrome, and a display face used broadly is precisely
   how a design becomes a template. Cut to one element — the day rule — set condensed at
   `wdth 85` so it reads as a stamped date rather than a heading.
10. **The hero metric: "68% opened," big number, small label, accent bar.** This is the
    strongest catch, because it was not merely generic — it was *dishonest*. An open rate
    computed over a population that is four-sixths machines is a fabricated number, and
    the hero-metric template would have given it the most authoritative position on the
    screen. Removed entirely. There is no aggregate open-rate figure anywhere in Postbox,
    and there should never be one.
11. **The checkmark.** Banned outright, in every icon variant, for every purpose. Named
    in §5.1 so it cannot creep back in as a "resolved" affordance somewhere unrelated.

**What I deliberately kept despite a warning.** Green for confirmed, even though green is
the colour of every competitor's dishonest badge. Postbox is the only client entitled to
it, and reclaiming green by *earning* it says more than inventing a novel hue for the one
state that needs no explanation. Likewise IBM Plex, which is on the overused-faces list
but is justified here by the Sans/Mono metric compatibility (§3.1), which is structural in
a UI where mono and sans share a baseline hundreds of times per screen.

---

## 9. Assumptions and open decisions

**Assumptions made** (stated rather than asked, per the brief):

- The opens client returns `{ opens: OpenRow[] }` on success and `{ available: false }`
  on failure, mapping the endpoint's 503 `{ error: 'unavailable' }` and any network error
  onto that flag. §7.3 is written against that shape; if the wrapper differs, change the
  wrapper, not the design.
- `self`-classified events are hidden entirely rather than shown in a collapsed "your own
  views" group.
- Relative times are shown alongside absolute times, never instead of them: the mono meta
  line always carries the wall-clock value, because a bare "2h ago" is unverifiable.
- Timestamps render in the user's local zone with no zone label, since there is one user.

**Needs a human decision — flagged, not guessed:**

1. **Bricolage Grotesque for one element.** A whole variable webfont for the day rule
   alone. Keep it (it is the direction's one piece of voice), or cut it and use the §3.1
   fallback. Decide before the first build; do not resolve it by finding Bricolage more
   jobs.
2. **Hidden `self` events.** Silently dropping data is a small dishonesty in a product
   about honesty. A muted "3 views from you" line in the rail header is the alternative.
   My call is to hide, since the user knows they opened their own Sent folder; the user
   may disagree.
3. **Retry cadence and copy in the unavailable state.** The design shows
   `last contact 11:48 · retrying`; whether that is a live countdown, a manual button, or
   silent background polling is a behaviour decision that changes the copy.

---

## 10. Verification checklist for step 9 of the chain

Run in **all three root states** (unstamped on a light OS, unstamped on a dark OS,
`data-theme="light"`, `data-theme="dark"`), at 1440px, 1024px, and 390px:

- [ ] No token resolves to `unset`/`inherit` in any root state. Grep the stylesheet: every
      `--` name defined in a media or `[data-theme]` block also exists in bare `:root`.
- [ ] `body` background comes from `--bg-page` and is never transparent.
- [ ] Body text ≥4.5:1, placeholders ≥4.5:1, the spine and all marks ≥3:1, on both grounds.
- [ ] The four state marks are distinguishable in a greyscale screenshot at 100%.
- [ ] No horizontal scrollbar on `<body>` at any width, with a 200-character subject line
      and a message containing a 900px-wide table.
- [ ] Every interactive element shows the two-layer focus ring under keyboard nav.
- [ ] `prefers-reduced-motion: reduce` reaches every end state; nothing is unreachable.
- [ ] The unavailable rail and the empty rail are told apart at a glance, in greyscale.
- [ ] An Apple/`mpp` recipient shows no spinner, no pulse, and no refresh control.
- [ ] `deviceClass` and `os` appear nowhere in the rendered DOM.
- [ ] No checkmark glyph is rendered anywhere.
- [ ] The mobile rail strip clears the iOS home indicator with the safe-area inset applied.

---

## 11. Amendment 1: density & ergonomics (user-directed)

Task 7.5A of Plan 3. The user reviewed the running app and said: *"There are a lot of
UI changes that need to be fixed... use superhuman or gmail design as a guide."* This
amendment is scoped to ergonomics — density, hierarchy, and a foundational font bug —
not identity. The token system, the three honest read-states, and the design's voice
(§1–§2, §5) are unchanged. Where a value below conflicts with an earlier section, this
amendment wins; the earlier section is left as written, as a record of what changed and
why, rather than silently edited.

### 11.1 The font bug (root cause)

`body` (§2.1's own three-block structure) declared `background` and `color` but never
`font-family`. `--font-ui` / `--font-mono` / `--font-display` all existed (§3.1); every
component that did not opt into one of them per-selector — email subjects, list rows,
whatever a future component forgot — fell through to the browser's serif default.
Computed style on a live row, before this fix: `font: Times`. This was diagnosed as the
single biggest reason the shipped app didn't look like a real product, ahead of any
spacing or hierarchy problem below.

Fix, in `theme.css`:

```css
body {
  background: var(--bg-page);
  color: var(--fg-primary);
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
}
```

The redundant `font-family: var(--font-ui)` this made unnecessary was removed from
every selector in this task's files that had one: `MessageRow.css` (`.row__sender`,
`.row__subject`), `InboxList.css` (`.inbox-list__empty-copy`, `.inbox-list__error`,
`.inbox-list__load-more-button`), `shell.css` (the banner text, §11.4), and
`PushToggle.css` (`.push-toggle__switch`, `.push-toggle__note` — see §11.4's note on
why this file was touched at all). Selectors that explicitly need `--font-mono` or
`--font-display` still declare them; those are real departures from the inherited
default, not restatements of it. `login.css` and the concurrently-owned rail files
(`OpensRail.css`, `ReadState.css`) carry the same redundant declarations and were left
alone — they inherit the fix automatically, and this task's file ownership does not
extend to them.

### 11.2 Row anatomy — supersedes §4.1's `.row` sample and §6 component #7

Old: `.row { grid-template-columns: 1fr auto; }` with sender and subject sharing one
flex box as the first column. That nesting is what let the subject column mis-size and
truncate far too early — the sender and subject were competing for one flex box's width
against the meta column, instead of the subject getting every pixel left over after a
fixed sender width. Computed on a live row, before this fix: height 80px (min-height 64
+ padding-block 8 top and bottom), for a single line of text.

New, in `MessageRow.css`:

```css
.row {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr) auto; /* sender · subject · meta */
  column-gap: var(--s-4);
  align-items: baseline;
  min-height: var(--row-h); /* 40px desktop */
  padding-block: var(--s-2); /* 8px */
}
@media (max-width: 720px) {
  .row { min-height: var(--hit-min); } /* 44px — the existing iOS touch-target floor */
}
```

Sender is a fixed 168px column; subject is `minmax(0, 1fr)` and gets all remaining
width; meta (`auto`) is paperclip, then the account chip (§11.3), then the time, right-
aligned by grid position. `min-width: 0` stays on both `.row__sender` and
`.row__subject` — required for `text-overflow: ellipsis` to actually clip inside a grid
item rather than overflow its track.

**A new token, `--row-h: 40px`, not a changed `--row-min-h`.** `--row-min-h` (64px) is
also used by `OpensRail.css`, owned by a concurrent task on this same branch. Shrinking
it in place would have silently shrunk the rail's row height out from under that task.
`--row-h` is the inbox row's own token; `--row-min-h` is untouched and still means
64px, exclusively for the rail. `InboxList.css`'s loading skeleton
(`.inbox-list__skeleton-row`) was repointed from `--row-min-h` to `--row-h` so shaped
loading blocks still match the real row height they resolve into.

**Hover** reuses `--bg-hover` — the same token every other hover state in the product
already uses. There is no separate "raise" token in this system, so none was invented.
Rows stay plain, non-interactive `<li>`s; hover is a scanning aid, not a click
affordance (no detail view exists yet for a row to open).

Total row height, desktop: 40 + 8 + 8 = 56px. In an 800px-tall inbox scroller, that is
approximately 14 rows of plain message rows back to back (fewer wherever a day rule's
own margin — §11.3 — falls in the same span). Mobile: 44 + 8 + 8 = 60px.

### 11.3 Day rule — supersedes §3.2's `--t-xl` row, §4.2's margins, and §6 component #6

Old: 26px (`--t-xl`), `--s-10` (40px) above / `--s-4` (16px) below, sentence case,
`letter-spacing: -0.02em`, always the full `Tuesday, August 25, 2026` form — DESIGN.md's
original position was explicitly "never a relative Today/Yesterday" (the rationale
lived in `inboxDates.ts`'s own doc comment, not in this file), reasoned on keeping
`groupByDay` clock-independent. This amendment reverses that call: relative labels are
worth the `now` parameter `groupByDay` now takes to stay pure while having them (every
row in one render already agreed on "now" via the same `now` state `formatWhen` uses;
`groupByDay(messages, now)` extends that agreement to day-rule labels rather than
introducing a second, uncoordinated read of the clock).

New format, in `inboxDates.ts`'s `formatDayLabel(date, now)`:

- `Today` — same local calendar day as `now`.
- `Yesterday` — exactly one calendar day before.
- Otherwise `Mon, Aug 24` — `en-US` `{ weekday: 'short', month: 'short', day: 'numeric' }`.

Every glyph in all three forms (letters, digits, comma, space) is inside the Bricolage
Grotesque `&text=` subset `index.html` requests. No period, colon, or other punctuation
is introduced anywhere in this function — any of those would silently fall back to the
UI face rather than error, which is why this was checked against the actual subset
string before shipping, not assumed.

New size and style, in `InboxList.css`'s `.day-rule__label`:

```css
font-family: var(--font-display);
font-variation-settings: 'wdth' 85, 'opsz' 14; /* opsz was 24, tuned for the old 26px size */
font-size: var(--t-xl); /* redefined below, was 1.625rem/26px */
font-weight: 600;
line-height: 1.3;
letter-spacing: 0.06em; /* was -0.02em — see the direction note below */
text-transform: uppercase;
margin-block-start: var(--s-6); /* 24px, was --s-10/40px */
margin-block-end: var(--s-2); /* 8px, was --s-4/16px */
```

`--t-xl` itself was redefined in `theme.css`, `1.625rem` (26px) → `0.8125rem` (13px) —
this was a value correction in place, not a new token: nothing else in the product
reads `--t-xl` (checked before changing it), so there was no risk of a second caller
silently shrinking, and no orphaned token left behind either way.

The brief left the choice between "uppercase with letter-spacing" and "small-caps feel"
open; this amendment picked **uppercase + positive tracking**. Small-caps support is
inconsistent enough across variable fonts to be the less reliable of the two, and
`text-transform` is a CSS-only transform — `Today`, `Yesterday`, and a screen reader's
own casing all stay normal-case in the accessibility tree; only the visual rendering
uppercases. The letter-spacing *sign* had to flip from the original: `-0.02em` was
correct for tightening large (26px) display type, but uppercase text at 13px needs
positive tracking for legibility, not negative.

Sticky positioning and the opaque `background: var(--bg-inbox)` stuck-header treatment
are both unchanged — a prior review finding, explicitly not to be regressed here.

### 11.4 Account chip (new) — the account label moves out of the meta text

§6 component #7's original anatomy put the account id directly in the meta text
(mono, `--t-xs`). It now renders as a short chip, `MessageRow.tsx`'s `accountChip`:
the first three characters of `account_id`, lower-cased — `primary` → `pri`,
`harvard` → `har`, `personal` → `per`, `masterman` → `mas`, covering every account id
this inbox has today. It sits between the subject and the time in `.row__meta`.

```css
.row__chip {
  font-family: var(--font-mono);
  font-size: var(--t-2xs); /* 11px */
  font-weight: 500;
  padding: 2px var(--s-2);
  border: 1px solid var(--line-border);
  border-radius: var(--r-sm);
}
```

Deliberately achromatic, borrowing StateToken's (component #10) quiet visual language
(mono, `--t-2xs`, `--r-sm`, small padding) without its wash background — washes are
read-state-exclusive, and §6's own "No account colour legend" rule bans colour as an
account signal outright. `--line-border`'s token comment in `theme.css` ("control edges
only") is exactly this chip's case. It is a label, never a filter: no click handler, no
`role="button"`, nothing it does when pressed.

### 11.5 Banners — supersedes part of §7.4, extends §6 component #19

Two banners were diagnosed as broken in the running app: the toolbar's
notifications-blocked note (`PushToggle.tsx`) and the shell-level session error
(`App.tsx`'s `SessionError`). Both were a single line of text with no way to put it
away — for the notifications note specifically, since no other toolbar content exists
yet (no `AccountFilter`/`ThemeToggle`/rail toggle — still Task-4/5-shaped gaps per
`App.tsx`'s own comment), that note was the *entire* rendered content of the 56px
toolbar, permanently, on every load, in the `ios-install` / `unsupported` / `blocked`
capability states.

Both now pair the message with an icon-only dismiss button, matching §6 component #19's
existing spec for that button shape (`--hit-min` square, `aria-label` required — nothing
new invented, just applied for the first time): `X` from `lucide-react`, 14px,
`stroke-width: 1.5`. Dismiss state is component-local (`useState`), not persisted, per
this task's own instruction — it resets on reload, which is fine for both: neither
message needs to stay hidden forever once read.

`App.tsx`'s dismissal is keyed on the message text, not a bare boolean, so a retry that
resurfaces a *different* error still shows; only a repeat of the exact message already
dismissed stays hidden. The inline "Try again" retry link is unaffected — dismissing
the banner does not remove the retry action, it only stops the banner rendering.

`PushToggle.tsx`/`PushToggle.css` are outside this task's normal file ownership (see
`client/CLAUDE.md`'s task-7.5A brief) but were touched for exactly this fix, plus the
matching font-family cleanup (§11.1) — that file's own render branch was the only place
the notifications-banner root cause could actually be fixed. Nothing else in that
component changed: the switch/track/knob markup, its `role="switch"`/`aria-checked`,
and the permission-gesture discipline documented in its own top comment are untouched.

### 11.6 Tests updated

`tests/inbox.test.ts`: every `groupByDay(...)` call gained a second `NOW` argument —
the function's signature changed from `(messages)` to `(messages, now)` to support
relative day-rule labels (§11.3). No existing assertion was deleted; all of them
previously checked only group counts, order, and dateless handling, never label text,
so none needed to change beyond adding the new required argument. A new
`describe('groupByDay — day-rule label format (Amendment 1)')` block was added: it pins
`Today`, `Yesterday`, the `Mon, Aug 20` form for anything older, the unchanged `No date`
trailing-group label, and a regex guard (`/^[A-Za-z0-9, ]+$/`) that every label stays
inside the Bricolage subset described in §11.3.

`tests/theme-tokens.test.ts` (the theme-guard) and `tests/opens-rail-static-guards.test.ts`
(the static-guard) were not modified and remain green — neither guard's assertions
touch anything this amendment changed.
