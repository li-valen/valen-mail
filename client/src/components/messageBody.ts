import type { MessageAttachment, ParsedMessage } from '../api';

/**
 * Pure rendering logic for the message reader, split out of
 * MessageView.tsx for the same reason ./inboxDates.ts is split out of
 * InboxList.tsx: client/CLAUDE.md's standing constraint is that no test
 * in this project renders a component, so anything that has to be
 * VERIFIED must be framework-free.
 *
 * What is verified here is the security boundary itself. sync/ returns a
 * message's html exactly as the sender wrote it and deliberately does NOT
 * sanitise it (see sync/src/api/message.ts's own doc comment for why
 * double-sanitising would erode this boundary rather than add one), so
 * `IFRAME_SANDBOX` + the CSP `<meta>` built below are the only things
 * standing between attacker-authored HTML and this origin. Both are
 * constants in this file precisely so a test can assert on them.
 */

/**
 * The `sandbox` attribute value the body iframe carries, verbatim and
 * from exactly one place — tests/message-body.test.ts asserts that every
 * `sandbox=` in client/src/**\/*.tsx is this identifier and nothing else,
 * so a second, laxer iframe cannot appear without failing the suite.
 *
 * WHAT IS ABSENT IS THE POINT — AND IT IS ONE ATTRIBUTE, NOT TWO.
 *
 *  - **No `allow-scripts`.** Nothing in a message body ever executes: no
 *    `<script>`, no `onclick=`, no `javascript:` href, no `onerror=` on a
 *    deliberately broken image. This is the whole boundary, and it holds
 *    against html nobody inspected, which is why it is worth more than any
 *    sanitiser's blocklist.
 *  - **`allow-same-origin` IS present, and it never was the boundary.**
 *    This comment used to claim it was absent and that "adding EITHER
 *    changes what this attribute means". The second half of that was
 *    wrong, and the error was not free: believing the frame could not be
 *    reached is what put a GUESSED height on it, and a guessed height is
 *    what made the message scroll inside the page — the second scrollbar
 *    the user could point at in a screenshot.
 *
 *    Measured rather than reasoned about, with the CSP DELIBERATELY
 *    REMOVED so the sandbox stood on its own: a frame carrying both an
 *    inline `<script>` and an `onerror` handler executed NEITHER, while an
 *    otherwise identical control frame that added `allow-scripts` ran the
 *    handler immediately. The control is what makes the other rows
 *    evidence instead of an untested instrument. An origin is reachable
 *    only by code, and no code runs here.
 *
 *    What it buys: `contentDocument` is readable, so MessageView.tsx sizes
 *    the frame to the message instead of estimating it.
 *
 *    **THE DANGEROUS PAIRING IS NOW ONE EDIT AWAY RATHER THAN TWO, AND
 *    THAT IS THE REAL COST OF THIS CHANGE.** `allow-scripts
 *    allow-same-origin` is the well-known way to remove a sandbox
 *    altogether: a frame holding both can reach into this document and can
 *    rewrite its own `sandbox` attribute. One half of that pair is now
 *    standing here permanently. `allow-scripts` must never join it, and
 *    tests/message-body.test.ts asserts its absence on its own — separately
 *    from the exact-string check, and named for this reason — so that the
 *    test a careless edit breaks explains why it broke.
 *  - **No `allow-forms`, `allow-modals`, `allow-top-navigation`,
 *    `allow-downloads`.** A message cannot post a form, block the UI, or
 *    navigate the app out from under the reader.
 *
 * What IS present, and why: `allow-popups` plus
 * `allow-popups-to-escape-sandbox` make ordinary links work. A link click
 * needs user activation, so no message can open a tab on its own; the
 * `-to-escape-sandbox` half means the tab that DOES open is a normal
 * browsing context rather than a crippled sandboxed copy of the linked
 * site. Without the pair, every link in every email is silently dead —
 * which is not a safer reader, just a broken one.
 */
export const IFRAME_SANDBOX =
  'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/**
 * The `Content-Security-Policy` enforced INSIDE the srcdoc.
 *
 * `default-src 'none'` is the base: no stylesheets, no fonts, no frames,
 * no media, no XHR — nothing loads from anywhere unless a directive below
 * re-permits it. Exactly three do: `style-src 'unsafe-inline'` (email
 * layout is inline `style=` attributes and `<style>` blocks; with no
 * script able to run, inline CSS cannot exfiltrate anything), `font-src
 * data:`, and `img-src`.
 *
 * **`img-src` PERMITS REMOTE HOSTS, and that is a user decision, not an
 * oversight.** This function used to take an `allowRemote` flag, default
 * false, so a reader had to press "Load remote images" per message — the
 * reasoning being that a remote image tells the sender the exact second
 * their mail was opened, which is precisely the mechanism Postbox uses to
 * detect opens on the mail the USER sends. The user reviewed that and
 * overruled it, verbatim: "remove the dont load images thing i dont care
 * if people can track me with the pixels." Mail now renders the way the
 * sender built it, first time, with no bar and no button.
 *
 * WHAT THIS DOES NOT CHANGE, and the distinction matters because the two
 * were argued together in the old comment: remote images were a PRIVACY
 * control. `IFRAME_SANDBOX` above is the XSS boundary, and it is
 * untouched — no `allow-scripts`, no `allow-same-origin`, both still
 * pinned by tests/message-body.test.ts. A sender can now learn that their
 * mail was opened. A sender still cannot run a line of code, read a
 * cookie, or reach this origin. Trading the first away does not soften
 * the second, and nothing in this file should ever be edited as though
 * it did.
 *
 * `cid:` stays in the list beside `data:` and the remote schemes: it
 * costs nothing, and a browser cannot resolve it anyway (see
 * MessageView's note on embedded images).
 */
export function contentSecurityPolicyFor(): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "style-src 'unsafe-inline'",
    'font-src data:',
    'img-src data: cid: https: http:',
  ].join('; ');
}

/**
 * The stylesheet the srcdoc carries, and the one place this app decides
 * what a message body LOOKS like.
 *
 * **A LIGHT CARD, IN BOTH THEMES, DELIBERATELY.** Every other surface in
 * this client follows the semantic palette into dark mode. This one does
 * not, and must not: an email's own HTML hardcodes its colours against
 * the white background every mail client has ever given it — dark text in
 * an inline `style=`, a logo that is a white-background PNG, a table with
 * `bgcolor="#ffffff"` around half its cells and nothing around the other
 * half. Forcing a dark ground under that produces black-on-black
 * paragraphs and white boxes floating in a dark page: not a dark theme, a
 * broken message. `color-scheme: light` states the same thing to the
 * browser so it does not auto-darken form controls or scrollbars inside
 * the frame either.
 *
 * The reader's own chrome around this frame — header, attachments,
 * thread, every control — IS fully themed, so dark mode still reads as
 * dark mode; the message itself sits on a light card inside it, the way a
 * sheet of paper does. MessageView.tsx frames it as one.
 *
 * **THE REST OF THIS FILE IS THE NO-SIDEWAYS-PAN RULE SET, AND IT
 * REVERSES A PREVIOUS DECISION.** This comment used to end: *"Fixed-width
 * (600px) table layouts are deliberately NOT overridden — squashing them
 * mangles the message, so the frame scrolls horizontally instead."* The
 * user read mail on a phone and overruled it: *"should have no overflow
 * and stuff for some reason i can move left to right on the emails fix
 * that."* Measured against this user's own inbox at a 341px frame, two
 * distinct causes were producing that pan, and each rule below answers
 * one of them:
 *
 *  - **Long unbreakable tokens.** A GitHub notification carrying a code
 *    diff measured 707px wide in a 341px frame with no element wider than
 *    the frame — the overflow was inline content inside `<pre>`, where
 *    `white-space: pre` disables wrapping outright and `overflow-wrap`
 *    never gets a chance. `pre{white-space:pre-wrap}` plus
 *    `overflow-wrap:anywhere` (which, unlike `break-word`, also shrinks
 *    an element's min-content width) takes that message to exactly 341.
 *
 *  - **Fixed-width marketing layouts.** A `<table width="640">` whose
 *    cells hold `<img width="640">`. `max-width:100%` cannot shrink
 *    either: a percentage max-width is treated as `none` while the
 *    browser computes min-content width, which is the very step that
 *    sizes the table. The image cap is therefore expressed as a VIEWPORT
 *    length, which does participate, and that alone dropped one real
 *    message from 4382px to 3617px tall with every image legible.
 *
 * **WHERE A TABLE GENUINELY CANNOT REFLOW, IT SCROLLS IN ITS OWN BOX.**
 * One measured message pins its width at 640 through a single `<tr>` of
 * five `<td>`s (210+140+94+87+109) — a real five-across layout that no
 * stylesheet can stack without destroying it. `body>table` therefore
 * becomes a block-level scroll container: the tbody/tr/td inside keep
 * table layout under an anonymous table box, so the design is untouched,
 * but the overflow is confined to that one element and the DOCUMENT never
 * pans. This is the standard wide-table treatment, and it is applied only
 * to top-level tables — nested ones stay tables, or every multi-column
 * email would collapse into a single column.
 *
 * **`margin-inline:auto` PUTS BACK THE CENTRING `display:block` TOOK
 * AWAY.** That is the whole of it, and it is one declaration because the
 * rule above is what broke this: a table box is shrink-to-fit and is
 * centred by `align="center"`, by an inline `margin:0 auto`, or by the
 * containers around it; a BLOCK box with an explicit `width` is none of
 * those, so a fixed-width message pinned itself to the left edge and put
 * every pixel of slack on the right. Measured in the running app at a
 * 1280 desktop, 960px frame, on the representative `<table width="640">`:
 * `gapLeft 16` (body padding, nothing else) against `gapRight 304`.
 * Auto inline margins take that to `160 / 160`.
 *
 * **IT CENTRES ONLY WHERE THERE IS GENUINELY SLACK, which is why one
 * declaration is enough and no media query is needed.** Auto margins
 * resolve to zero unless the box's own `width` leaves room:
 *
 *  - A full-width email (`width="100%"`, or no width at all — a block box
 *    fills its container) computes to the container width, so both
 *    margins are 0 and it gains no side gaps. Measured unchanged at
 *    `16 / 16` on both viewports.
 *  - A table too wide to fit is clamped by the `max-width:100%` above
 *    before margins are resolved, so it also gets 0 and keeps scrolling
 *    inside its own box. Measured at a 361px frame: an unshrinkable 640
 *    table stays `16 / 16` with `scrollWidth 612 > clientWidth 329`, and
 *    the document still does not pan.
 *
 * **THE SENDER STILL WINS WHERE THE SENDER SAID SOMETHING.** An inline
 * `style="margin-left:0"` outranks this rule, and `align="left"`/`"right"`
 * map to `float`, which auto margins do not touch — both measured to stay
 * exactly where the sender put them. What this changes is only the case
 * where the message expressed no horizontal intent at all, and the old
 * answer to that was "hard left", which no mail client gives.
 */
const BODY_STYLE = [
  'html{color-scheme:light;background:#ffffff}',
  // Named so the image cap below can be derived from the padding instead
  // of repeating it as a literal, and so the scrollbar allowance is a
  // stated quantity rather than a mystery constant. `--scrollbar` exists
  // because `100vw` includes the frame's own vertical scrollbar: without
  // it, a message long enough to scroll pans sideways by exactly that
  // width. Mobile overlay scrollbars are 0, so the allowance only ever
  // makes an image marginally narrower than it could have been.
  ':root{--pad:16px;--scrollbar:16px}',
  'body{margin:0;padding:var(--pad);background:#ffffff;color:#111827;',
  "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
  // `anywhere`, not `break-word`: the two wrap identically, but only
  // `anywhere` also lowers min-content width, which is what lets a table
  // cell holding a 400-character URL stop forcing the table wide.
  'overflow-wrap:anywhere}',
  'img{max-width:min(100%,calc(100vw - 2 * var(--pad) - var(--scrollbar)));height:auto}',
  'a{color:#1d4ed8}',
  'table{max-width:100%}',
  'pre{white-space:pre-wrap;overflow-wrap:anywhere}',
  'body>table{display:block;max-width:100%;overflow-x:auto;margin-inline:auto}',
  // NOT STYLING — THIS CUTS A FEEDBACK LOOP, and it is the only `!important`
  // in this stylesheet for that reason.
  //
  // MessageView.tsx sizes the frame from the body's measured height, and a
  // ResizeObserver on that body re-measures whenever it changes. A message
  // that sets `body{height:100%}` (or `min-height:100%`) resolves that
  // percentage against the VIEWPORT — which is the frame we are sizing. Body
  // then grows to the frame, plus its own 32px of padding; we resize the
  // frame to match; body grows by another 32px. The frame walks down the page
  // 32px at a time and never settles.
  //
  // Damping the observer would only slow that down. Making the body's height
  // content-driven removes the path entirely, which is why this is expressed
  // as a rule the message cannot lose an unimportant declaration to. Real
  // mail loses nothing: a full-viewport body exists to stretch a background
  // colour down a window, and an auto-sized frame has no window to stretch.
  'html,body{height:auto!important;min-height:0!important}',
].join('');

/** Which ground the message is rendered on. */
export type BodyScheme = 'light' | 'dark';

/**
 * The ground used when the live palette cannot be read or does not
 * validate. MUST equal styles.css's dark `--card` / `--background`
 * (`224 71% 4%`), and tests/theme-tokens.test.ts pins exactly that so the
 * two cannot drift apart silently.
 */
export const DEFAULT_DARK_GROUND = '#030711';

/**
 * DARK MODE FOR THE MESSAGE ITSELF, by inversion rather than by restyling.
 *
 * **THIS REVERSES THE DECISION ABOVE, AT THE USER'S REQUEST:** *"Fix the
 * dark mode. When you click into emails the email section still white…
 * you can try to also change the background whites to the dark theme."*
 * The reasoning that kept this card light is still correct and is worth
 * restating, because it is exactly what this rule set has to survive: an
 * email hardcodes its colours against the white ground every client has
 * ever given it, so simply setting a dark `background` produces
 * black-on-black paragraphs wherever the sender set `color:#333` inline
 * and no background to go with it. That failure is not cosmetic — the
 * text becomes unreadable, which is worse than a white card.
 *
 * **SO WE INVERT INSTEAD OF RECOLOURING, and the distinction is the whole
 * point.** Recolouring has to guess which of the sender's colours to keep
 * and which to override, and it guesses wrong on any message that sets
 * one half of a foreground/background pair. Inverting cannot: it is a
 * uniform transform over whatever the sender actually specified, so the
 * CONTRAST the sender chose is preserved exactly while the lightness
 * flips. Black-on-white becomes white-on-black; grey-on-white becomes
 * grey-on-black. There is no combination of sender styles that inverts
 * into an unreadable one, which is the property no recolouring rule set
 * can offer. This is what Outlook and Apple Mail do for the same reason.
 *
 * `hue-rotate(180deg)` follows the inversion because `invert()` alone
 * also flips hue — a blue link would come back orange. Rotating the wheel
 * a half turn puts it back, so brand colours stay recognisably themselves
 * at inverted lightness.
 *
 * **MEDIA IS INVERTED A SECOND TIME, back to normal.** A photograph, a
 * logo, a screenshot — anything whose pixels are content rather than
 * styling — must not come out as a negative. Applying the same transform
 * again is exactly self-cancelling, so these elements render as the
 * sender authored them.
 *
 * **WHAT THIS COSTS, stated plainly rather than buried.** Two things it
 * genuinely cannot fix. A CSS `background-image` (common in marketing
 * mail) is not reachable by any selector that names the element carrying
 * it, so it inverts and looks wrong. And a message already authored dark
 * inverts to light — legible, still contrasty, but not what its sender
 * intended. Both are why MessageView.tsx offers a per-message escape back
 * to the original rendering, which is the same mitigation Outlook ships;
 * neither is a reason to hand the user a white rectangle at night.
 *
 * **THE FILTER IS ON `body`, AND THE GROUND IS PAINTED ON `html`.** That
 * split is the whole of the seam fix, and it is worth spelling out
 * because two more obvious arrangements are both wrong.
 *
 * The ground used to be the `#ffffff` BODY_STYLE sets, on the reasoning
 * that white is the input the filter turns into a near-black ground.
 * Right about the mechanism, wrong about the result: white inverts to
 * `#000000` EXACTLY, while the app around the frame is `--background`
 * (`hsl(224 71% 4%)`, `#030711`). Two different blacks a few units apart
 * read as a visible edge, and the user could point at the seam on a
 * phone screenshot — *"you can tell where the cutoffs are from the app
 * and the actual email; it should be unnoticeable and seamless."*
 *
 * **SOLVING FOR A BETTER PRE-FILTER CONSTANT DOES NOT WORK.**
 * `invert(hue-rotate(180deg, C))` has no exact answer for `C = #030711`
 * in 8-bit colour — the closest candidate MEASURES `#050a12`, three units
 * off in green, because CSS `hue-rotate` is a lossy matrix approximation
 * rather than a true involution. A near-miss constant would also rot
 * silently the moment the palette moved.
 *
 * **AND MAKING THE GROUND TRANSPARENT DOES NOT WORK EITHER — this was
 * tried, shipped to the user, and came back as *"dark mode not working
 * here"*: a white card with near-invisible pale-grey text.** The root
 * element's background PROPAGATES TO THE CANVAS, and the canvas is
 * painted outside the root's own filter. Transparent on both boxes
 * therefore does not mean "nothing is painted" — nothing is never
 * painted — it means the UA falls back to the canvas colour implied by
 * `color-scheme`, which for `light` is an OPAQUE `#ffffff`. The sender's
 * near-black text duly inverted to near-white and then sat on a ground
 * the filter could not reach. (The same trap in the other direction is
 * why `color-scheme:dark` yields an opaque `#121212`.)
 *
 * So the ground is painted OUTSIDE the filter instead of inside it:
 * `html` carries an opaque colour and no filter, `body` carries the
 * filter and no background. The ground stops being an input to the
 * transform at all — there is no `invert(hue-rotate(…))` to undo and no
 * rounding loss to eat, and the app's own colour reaches the pixel
 * literally. `body` MUST stay transparent: anything painted there lands
 * inside the filter and inverts.
 *
 * The colour itself is READ FROM THE LIVE PALETTE by MessageView.tsx and
 * passed in, rather than written here, so the frame cannot drift from the
 * card it sits on. `--card` and `--background` are the same value in dark
 * (styles.css), which is what makes frame, card and app ground agree by
 * construction. `safeGroundColor` is what stands between a token and a
 * stylesheet — see its own doc.
 *
 * **`color-scheme` STAYS `light`.** It was `dark`, to make the UA's own
 * scrollbars and form controls "match the inverted page". Measurement
 * says that was backwards: everything here is inverted once on the way
 * out, so the dark controls `dark` draws come back out LIGHT — grey
 * buttons on a dark message. `light` draws light controls that the filter
 * then inverts to dark, which is what a dark-rendered page wants. It is
 * no longer load-bearing for the canvas, because the canvas is now set
 * explicitly.
 */
const DARK_BODY_STYLE = [
  // OPAQUE, and deliberately NOT filtered — this is the canvas colour the
  // whole fix turns on. The value arrives as a CUSTOM PROPERTY rather than
  // baked in, so the parent can repaint the ground by setting one property
  // on the live document instead of rebuilding it; see `applySchemeTo`.
  `html[data-scheme="dark"]{background:var(--ground,${DEFAULT_DARK_GROUND})}`,
  'html[data-scheme="dark"] body{filter:invert(1) hue-rotate(180deg);background:transparent}',
  // Re-inverted so their pixels survive the page-level transform. `svg` is
  // included because inline SVG in mail is nearly always a logo or icon,
  // i.e. content; where it is used as decoration the double inversion is
  // no worse than the single one would have been.
  'html[data-scheme="dark"] :is(img,picture,video,canvas,svg,embed,object)' +
    '{filter:invert(1) hue-rotate(180deg)}',
].join('');

/**
 * Switches an ALREADY-LOADED message document between light and dark, in
 * place, and repaints its ground.
 *
 * **THIS EXISTS BECAUSE REBUILDING THE DOCUMENT COSTS THE USER SOMETHING
 * REAL, AND IT IS NOT THE FLICKER.** The scheme used to be compiled into
 * the `srcDoc` string, so every theme toggle handed React a new string and
 * reloaded the frame. Measured against a message carrying one 1x1 pixel:
 * opening it fetched that pixel once, and then EVERY toggle fetched it
 * again — 1 hit on open, 6 after five ordinary interactions. Remote images
 * in mail are overwhelmingly tracking pixels; this app's own Opens feature
 * is built on exactly that mechanism. Reloading the frame therefore told
 * the sender the message had been opened six times when it was opened once.
 * The user accepted being tracked on OPEN ("i dont care if people can track
 * me with the pixels"); they did not ask to be counted again every time
 * they touch the theme switch.
 *
 * It also re-parsed and re-laid-out the whole message — 5875px of it, in
 * the measured case — and left the OLD document painted inside the newly
 * themed frame for a frame or two on the way: light mail on a dark frame at
 * t+16ms, blank at t+25ms, correct at t+30ms. That was the visible flash.
 *
 * Both go away if the document is built once and switched afterwards, which
 * is possible only because the frame is same-origin now (see
 * `IFRAME_SANDBOX`). Nothing about the boundary moves: this writes an
 * attribute and a custom property from the PARENT into a document that
 * still cannot run a line of code.
 *
 * Returns whether it reached the document, so a caller can retry on load
 * rather than silently leaving a message in the wrong scheme.
 */
export interface SchemableDocument {
  readonly documentElement: {
    setAttribute(name: string, value: string): void;
    readonly style: { setProperty(name: string, value: string): void };
  } | null;
}

export function applySchemeTo(
  frameDocument: SchemableDocument | null | undefined,
  scheme: BodyScheme,
  ground: string,
): boolean {
  const root = frameDocument?.documentElement;
  if (root === null || root === undefined) return false;
  root.setAttribute('data-scheme', scheme === 'dark' ? 'dark' : 'light');
  // Validated on the way in for the same reason it is validated when it is
  // compiled into the stylesheet: this lands in a style declaration.
  root.style.setProperty('--ground', safeGroundColor(ground));
  return true;
}


/**
 * A colour that is safe to interpolate into the message document's
 * stylesheet.
 *
 * The value comes from this app's OWN palette, not from a sender, so this
 * is not defending against an attacker — it is defending against the
 * stylesheet becoming a place where arbitrary CSS can arrive. Everything
 * this file does rests on that `<style>` block containing exactly what it
 * is believed to contain: a value carrying `}` could close the rule and
 * open another, and `url(` could reach the network from inside a document
 * whose whole security story is a `default-src 'none'` CSP. Pinning the
 * shape is cheap; discovering later that it was never pinned is not.
 *
 * Accepts only the three notations a resolved custom property can hold —
 * `#rgb`-family hex, `rgb()`/`rgba()`, `hsl()`/`hsla()` — with a charset
 * that admits digits, separators and units and nothing else. Anything
 * unrecognised falls back to `DEFAULT_DARK_GROUND` rather than throwing:
 * a mis-read token should cost a slightly stale colour, never a reader
 * that will not render.
 */
const SAFE_GROUND = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%/\s]+\)|hsla?\([0-9.,%/\sdegra]+\))$/;

export function safeGroundColor(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  return SAFE_GROUND.test(value) ? value : DEFAULT_DARK_GROUND;
}

/**
 * Builds the complete document handed to the body iframe's `srcdoc`.
 *
 * `html` is attacker-authored and is embedded VERBATIM, which is safe
 * only because of the two things wrapped around it: `IFRAME_SANDBOX` on
 * the element and the CSP `<meta>` this puts first in `<head>`, before
 * any markup that could trigger a load. Nothing here escapes, strips or
 * rewrites the message — see this file's header, and sync/src/api/
 * message.ts, for why introducing a sanitiser at either end would make
 * this weaker rather than stronger.
 *
 * The result is passed to React's `srcDoc` prop, which sets the attribute
 * through the DOM. It is never concatenated into this app's own markup,
 * so a `"` or a `</iframe>` in a message cannot break out into the parent
 * document — there is no parent-document HTML parse for it to break out
 * of.
 *
 * `<meta name="referrer" content="no-referrer">` survives the
 * remote-image decision and is not part of it: the user chose to let
 * senders learn THAT their mail was opened, not to hand every host a
 * message linked to the URL the reader came from. Kept.
 *
 * There is no longer an options bag. `allowRemote` was its only member
 * and it has one possible value now, so a parameter nothing sets would be
 * a config knob pretending to still be a decision.
 */
export function srcDocFor(
  html: string,
  scheme: BodyScheme = 'light',
  /** The opaque ground a DARK document is painted on — the app's own
   *  `--card`, read live by MessageView.tsx so the frame cannot drift
   *  from the card it sits in. Ignored in light. Validated, never
   *  trusted verbatim: see `safeGroundColor`. */
  ground: string = DEFAULT_DARK_GROUND,
): string {
  const csp = contentSecurityPolicyFor();
  // The scheme and the ground are stamped on the ROOT ELEMENT, not selected
  // between here, so that both rule sets ship in every document and
  // switching between them costs an attribute write rather than a reload.
  // They are still stamped at BUILD time, and that matters: an effect that
  // applied the scheme after load would let the browser paint one frame of
  // the wrong theme first, which is the flicker this whole arrangement
  // removes.
  const attrs =
    ` data-scheme="${scheme === 'dark' ? 'dark' : 'light'}"` +
    ` style="--ground:${safeGroundColor(ground)}"`;
  return (
    `<!doctype html><html${attrs}><head>` +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // Target only, no href: links open in a new tab (the sandbox's
    // allow-popups pair is what lets them) instead of navigating the
    // frame away from the message. `base-uri 'none'` above still blocks a
    // message supplying its own <base href> to re-point relative URLs.
    '<base target="_blank">' +
    `<style>${BODY_STYLE}${DARK_BODY_STYLE}</style>` +
    '</head><body>' +
    html +
    '</body></html>'
  );
}

/**
 * THE BODY FRAME'S HEIGHT, MEASURED FROM THE MESSAGE ITSELF.
 *
 * **THIS REPLACES AN ESTIMATE, AND THE ESTIMATE WAS A BUG WITH A TIDY
 * EXPLANATION.** What stood here counted characters (0.7px each), images
 * (90px) and table rows (16px) out of the html string and clamped the
 * total to [240, 2200]px, because the comment above `IFRAME_SANDBOX` said
 * the frame could not be measured. It can. The consequences of guessing
 * were both visible to the user and pointed at directly: guess low, or hit
 * the 2200px clamp that ~30% of real mail exceeds, and the frame scrolls
 * INSIDE the page — *"There shouldnt be two scroll bars"*. Guess high and
 * the message is followed by white space. There is no cap here now: a tall
 * message simply makes a tall page, which is the entire request — *"It
 * should all be one ... just one thing i can scroll through."*
 *
 * **WHY THE BODY AND NOT `documentElement.scrollHeight`.** The obvious
 * measurement is the wrong one, and it fails in the direction that cannot
 * be seen in a test. `documentElement.scrollHeight` is floored at the
 * VIEWPORT, so it reports the frame's own height whenever the frame is
 * taller than its content: measured, a 3000px frame holding 1535px of
 * message reported **3000**. Sizing from that is a ratchet — the frame can
 * grow and can never shrink, so one over-tall render is permanent and the
 * white space it leaves is unremovable. The body box is content-driven and
 * does not observe the viewport at all; the same message measured
 * **1535.125** through it, at the same instant.
 *
 * **AND WHY `Math.ceil`, WHICH IS NOT FUSSINESS.** That 1535.125 is real:
 * body boxes land on subpixels. `body.scrollHeight` had already rounded it
 * DOWN to 1535, and a frame one eighth of a pixel short of its content is a
 * frame with a scrollbar — the precise bug being fixed, reintroduced by a
 * rounding mode. Ceiling to 1536 measured `scrollHeight > clientHeight` as
 * false, with no `overflow:hidden` needed anywhere.
 *
 * `scrollHeight` is still consulted alongside the box, as the larger of the
 * two: it is what catches a child that overflows the body's border box, an
 * absolutely-positioned footer being the common case in marketing mail.
 *
 * Pure and framework-free, and typed against the structural shape it
 * actually needs rather than `Document`, so the suite can hand it a plain
 * object — client/CLAUDE.md's standing constraint is that no test here
 * renders a component, and a real layout is not available to one anyway.
 */

/** What a measurement needs from a document: a body that can report its
 *  own box. `Document` satisfies this structurally. */
export interface MeasurableBody {
  readonly scrollHeight: number;
  getBoundingClientRect(): { readonly height: number };
}

/** @see MeasurableBody */
export interface MeasurableDocument {
  readonly body: MeasurableBody | null;
}

/**
 * The height to give the frame when the message has NOT been measured —
 * either the document has not finished loading, or it could not be reached
 * at all.
 *
 * It is deliberately generous, and it is paired with a frame that is still
 * internally scrollable (nothing sets `overflow:hidden` inside the
 * document). That pairing is the whole safety property: an unmeasurable
 * message is rendered the way it was rendered before this change — tall,
 * and scrollable if the guess falls short — rather than CLIPPED to a
 * height nobody could verify. The failure mode is the old bug, never an
 * unreadable message.
 */
export const FALLBACK_BODY_HEIGHT_PX = 1200;

export function measuredBodyHeightPx(
  frameDocument: MeasurableDocument | null | undefined,
): number | null {
  const body = frameDocument?.body;
  if (body === null || body === undefined) return null;

  const boxHeight = body.getBoundingClientRect().height;
  const overflowHeight = body.scrollHeight;
  const tallest = Math.max(
    Number.isFinite(boxHeight) ? boxHeight : 0,
    Number.isFinite(overflowHeight) ? overflowHeight : 0,
  );

  // Zero is what an unlaid-out or display:none document reports. It is
  // indistinguishable from a real answer once returned, so it is refused
  // here and the caller falls back rather than collapsing the frame.
  return tallest > 0 ? Math.ceil(tallest) : null;
}

/** Which of the three body surfaces the reader should render. */
export type BodyKind = 'html' | 'text' | 'empty';

/**
 * Picks the body to render: html when there is one, the plain-text
 * alternative when there is not, and `'empty'` when the message carries
 * neither — which is a real message, not an error (an attachment-only
 * mail, or a body the size cap in sync/src/api/fetch-part.ts truncated
 * away), and gets an empty state plus its attachment list rather than a
 * failure.
 *
 * Whitespace-only counts as absent on both fields: a body of `"\n\n"` is
 * not content, and treating it as html would render a blank frame with no
 * hint that a perfectly good `text/plain` alternative was sitting next to
 * it.
 */
export function bodyKind(message: Pick<ParsedMessage, 'html' | 'text'>): BodyKind {
  if (typeof message.html === 'string' && message.html.trim() !== '') return 'html';
  if (typeof message.text === 'string' && message.text.trim() !== '') return 'text';
  return 'empty';
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

/**
 * A human byte size for one attachment row: `812 B`, `1.5 KB`, `2.3 MB`.
 *
 * **The number this formats is the DECODED size** — what the file is once
 * saved — because that is what sync/src/api/message.ts's ParsedAttachment
 * carries. The `size_bytes` on an inbox row is a DIFFERENT number: the
 * ENCODED size from BODYSTRUCTURE, roughly 4/3 larger for base64. Same
 * name, ~33% apart. Never cross-reference the two; this reader only ever
 * shows the one it is given here.
 *
 * `null` is the honest answer for an attachment whose size the parse did
 * not produce, and reads as such — never `0 B`, which claims an empty
 * file, and never a blank, which reads as a layout bug.
 */
export function formatSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < BYTES_PER_KB) return `${Math.round(bytes)} B`;

  const [value, unit] =
    bytes < BYTES_PER_MB
      ? [bytes / BYTES_PER_KB, 'KB']
      : bytes < BYTES_PER_GB
        ? [bytes / BYTES_PER_MB, 'MB']
        : [bytes / BYTES_PER_GB, 'GB'];
  // One decimal, and no trailing `.0`: `1 KB`, not `1.0 KB`.
  return `${Math.round(value * 10) / 10} ${unit}`;
}

/**
 * Whether this attachment can be offered as a download at all.
 *
 * **`partId === ''` means "not addressable", and it is not hypothetical.**
 * mailparser reconstructs part numbers by counting MIME boundaries, IMAP
 * assigns them structurally, and the two disagree for sibling multiparts;
 * sync/src/api/message.ts reconciles against the part numbers already
 * stored from BODYSTRUCTURE and, when it CANNOT establish one, emits an
 * empty string rather than a plausible-looking guess. A guessed part
 * number is the 4th segment of the attachment route, so it downloads the
 * wrong part or 404s.
 *
 * This is therefore the 404-avoidance, and the reason MessageView renders
 * such an entry as a visible but non-downloadable row: the attachment
 * exists and the user should know it does, but there is no honest URL to
 * put behind it. Whitespace is treated as empty for the same reason — it
 * would produce a URL segment that resolves to nothing.
 */
export function isDownloadable(attachment: Pick<MessageAttachment, 'partId'>): boolean {
  return attachment.partId.trim() !== '';
}

/**
 * The download URL for one attachment, matching the route in
 * sync/src/api/routes.ts verbatim:
 * `/api/attachment/{accountId}/{folder}/{uid}/{partId}` — four segments,
 * the last of which is the part id.
 *
 * Every segment is percent-encoded because the server's own pattern is
 * `([^/]+)` per segment and it `decodeURIComponent`s three of them
 * (`decodeSegments`): a Gmail folder like `[Gmail]/Sent Mail` contains a
 * literal `/` and would otherwise split into two segments and miss the
 * route entirely. `uid` is digits in practice, so encoding it is a no-op
 * that costs nothing and removes one thing to remember.
 *
 * Callers must gate on `isDownloadable` first — this function builds
 * whatever it is given, and an empty `partId` produces a URL that cannot
 * resolve.
 */
export function attachmentUrl(
  accountId: string,
  folder: string,
  uid: string,
  partId: string,
): string {
  const segments = [accountId, folder, uid, partId].map(encodeURIComponent);
  return `/api/attachment/${segments.join('/')}`;
}

/**
 * The identity of one inbox row, `accountId:uid` — unique across the
 * merged inbox, where a bare uid is not (uids are per-mailbox, so four
 * accounts routinely share one).
 *
 * One helper for four call sites that must agree: InboxList's React key,
 * the `data-message-key` MessageRow puts on its button, App's focus
 * restore when the reader closes, and MessageView's thread list dropping
 * the message already being read. Those last two are the ones that break
 * silently if a copy drifts.
 */
export function messageKey(message: { readonly account_id: string; readonly uid: string }): string {
  return `${message.account_id}:${message.uid}`;
}
