/**
 * The one test ../searchQuery.ts refused to write, and why it has to
 * exist here anyway.
 *
 * `isSearchHotkey` requires Meta or Control precisely so that the ⌘K
 * handler needs no "is the user in a text field?" check — its header
 * states the reasoning in full, and it is correct: *"That test is the one
 * that always eventually misses a case (a contenteditable, a shadow root,
 * a native picker), and the failure mode is a user losing a sentence
 * mid-word."*
 *
 * Gmail's `j`/`k`/`s`/`g i` are bare keys. There is no modifier to hide
 * behind, so the choice is not "modifier vs. test" any more — it is
 * "write the test, or do not ship the feature". This module writes it,
 * and it treats searchQuery.ts's three named misses as a SPECIFICATION
 * rather than as a warning:
 *
 *   - **contenteditable** — matched via `isContentEditable`, which the
 *     platform computes with INHERITANCE, so a `<b>` nested three levels
 *     inside an editable host answers true. A `getAttribute` check would
 *     not.
 *   - **a shadow root** — `event.target` is RETARGETED to the shadow
 *     host, so an input inside a web component looks like a plain `<div>`
 *     from the outside. `describeEventTarget` below reads
 *     `composedPath()[0]` instead, which is the true innermost node, and
 *     additionally consults the active element THROUGH any shadow root.
 *   - **a native picker** — every `<input>` counts, `type` irrespective.
 *     See `isTypingElement`.
 *
 * And one searchQuery.ts did not have to think about, because a modified
 * chord is unreachable mid-composition anyway:
 *
 *   - **IME composition.** While a Japanese/Chinese/Korean input method
 *     is composing, `keydown` fires for keys that belong to the IME, not
 *     to the app. `isComposing` (and the legacy `keyCode === 229` that
 *     some browsers still report instead) is the platform's own flag for
 *     "these keystrokes are not yours".
 *
 * THE ASYMMETRY IS DELIBERATE. Every ambiguous case resolves to "the user
 * is typing", i.e. to NOT firing the shortcut. A missed `j` costs one
 * keystroke; a stolen `j` costs a word, and — because it also moves the
 * list under them — the user's place. The two errors are not the same
 * size, so the guard is not centred between them.
 */

/**
 * Everything the guard needs about one element, and nothing that requires
 * a DOM to construct — so the decision is exhaustively testable in this
 * project's `environment: 'node'` suite, per client/CLAUDE.md's standing
 * "no test renders a component" constraint.
 */
export interface TargetDescriptor {
  /** Upper-case, as the DOM reports it (`'INPUT'`). `null` for a target
   *  that is not an element at all — `window`, `document`, a text node. */
  readonly tagName: string | null;
  /** The platform's own inherited computation, never a raw attribute
   *  read. `false` when unknown. */
  readonly isContentEditable: boolean;
  /** The element's ARIA `role`, lower-cased, or `null`. */
  readonly role: string | null;
}

/**
 * ARIA roles that accept text, whatever the element under them happens to
 * be. A `<div role="textbox">` is a text field to every screen reader and
 * to every user driving one, so it is a text field here.
 *
 * `combobox` is included because an editable combobox swallows letters to
 * filter its own options; a non-editable one swallows them to jump
 * between them. Both are "this key is already spoken for".
 */
const TEXT_ENTRY_ROLES: ReadonlySet<string> = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
]);

/**
 * Elements that own their own keystrokes.
 *
 * **EVERY `<input>`, `type` IRRESPECTIVE — including `checkbox`.** The
 * narrower rule ("only text-ish types") is the one that eventually ships
 * the bug: it requires a correct, maintained list of the ~22 input types,
 * and a type this app has not used yet (`date`, `time`, `color`, all of
 * which open native pickers with their own key handling) defaults to the
 * WRONG side of it. The cost of being wrong in this direction is that a
 * shortcut does not fire while a checkbox has focus — an event that
 * cannot currently happen, since this app has no checkboxes — and the
 * cost of being wrong in the other direction is a lost sentence. That is
 * not a close trade.
 *
 * `<select>` is here because both arrows and letters already mean
 * something inside one: arrows change the VALUE, and a letter jumps to
 * the next option starting with it. `j` in a focused select is a
 * type-ahead, not a navigation.
 */
export function isTypingElement(target: TargetDescriptor): boolean {
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

  const role = target.role;
  if (role !== null && TEXT_ENTRY_ROLES.has(role)) return true;

  return false;
}

/**
 * Elements the PLATFORM already activates on Enter or Space, so this app
 * must not activate them a second time.
 *
 * Only `Enter`/`o` care about this (see ./shortcuts.ts): a focused row IS
 * a `<button>`, the browser fires its click on Enter, and a window-level
 * handler that also opened the selection would run the open path twice
 * for one keystroke. `j`/`k`/`s`/`g` have no such conflict and fire here
 * exactly as they do anywhere else.
 *
 * Not folded into `isTypingElement` because they are different claims: a
 * button is not somewhere you can lose a sentence, and suppressing `j`
 * on one would break navigation from the very element the cursor puts
 * focus on.
 */
export function isActivationElement(target: TargetDescriptor): boolean {
  const tag = target.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true;

  const role = target.role;
  return role === 'button' || role === 'link';
}

/* ────────────────────────────────────────────────────────────────────
   The DOM edge. Everything below needs a real event; everything above
   does not. The split is what keeps the decision testable.
   ──────────────────────────────────────────────────────────────────── */

/** The subset of `Element` this module reads. Structural, so a plain
 *  object satisfies it and the edge stays reachable from a test that has
 *  no DOM. */
interface ElementLike {
  readonly tagName?: unknown;
  readonly isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  readonly shadowRoot?: { readonly activeElement?: unknown } | null;
}

function describeElement(node: unknown): TargetDescriptor {
  const element = node as ElementLike | null | undefined;
  if (element === null || element === undefined) {
    return { tagName: null, isContentEditable: false, role: null };
  }

  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : null;
  const role =
    typeof element.getAttribute === 'function' ? element.getAttribute('role')?.toLowerCase() ?? null : null;

  return {
    tagName,
    // Strict `=== true`: an element-like object that does not implement
    // the property at all must read as "not editable" rather than as
    // truthy-undefined.
    isContentEditable: element.isContentEditable === true,
    role,
  };
}

/** The subset of `KeyboardEvent` the edge reads. */
export interface KeyEventLike {
  readonly target?: unknown;
  readonly isComposing?: unknown;
  readonly keyCode?: unknown;
  composedPath?: () => readonly unknown[];
}

/**
 * The keyCode a browser reports for a keystroke the IME has taken. Legacy
 * — `isComposing` is the modern flag — but Safari and some Android
 * keyboards still report only this, and a missed composition is the
 * loudest possible version of this feature's worst failure.
 */
const IME_KEY_CODE = 229;

/** True while an input method is mid-composition, by either signal. */
export function isComposingEvent(event: KeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === IME_KEY_CODE;
}

/**
 * The innermost node the keystroke actually landed on.
 *
 * `composedPath()[0]` rather than `event.target`, because retargeting
 * rewrites `target` to the shadow HOST for anything that happened inside
 * a shadow root — the exact miss ../searchQuery.ts names. Falls back to
 * `target` where `composedPath` is unavailable.
 *
 * Exported because ./revealRow.ts needs the same node for a different
 * question ("is this one of the list's rows?"), and two copies of this
 * three-line resolution is how one of them eventually stops seeing
 * through shadow roots.
 */
export function innermostTarget(event: KeyEventLike): unknown {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : undefined;
  return path !== undefined && path.length > 0 ? path[0] : event.target;
}

export function describeEventTarget(event: KeyEventLike): TargetDescriptor {
  return describeElement(innermostTarget(event));
}

/**
 * The focused element, followed THROUGH shadow roots.
 *
 * A second, independent read of "where is the user". `document.
 * activeElement` reports the shadow HOST for focus inside a component, so
 * this descends `shadowRoot.activeElement` until it stops moving — a
 * bounded walk (shadow trees nest, but not infinitely; the cap makes that
 * a fact rather than an assumption).
 *
 * WHY BOTH THIS AND THE EVENT TARGET. They disagree in real cases: a
 * keystroke dispatched programmatically, an event whose target has since
 * been removed, a browser that reports `document.body` for keys inside
 * certain native pickers. `isTypingContext` takes the union — if EITHER
 * says the user is in a field, the shortcut does not fire.
 */
const MAX_SHADOW_DEPTH = 10;

export function describeActiveElement(root: { readonly activeElement?: unknown } | null): TargetDescriptor {
  let node: unknown = root?.activeElement ?? null;
  for (let depth = 0; depth < MAX_SHADOW_DEPTH; depth += 1) {
    const inner = (node as ElementLike | null)?.shadowRoot?.activeElement;
    if (inner === null || inner === undefined) break;
    node = inner;
  }
  return describeElement(node);
}

/**
 * The whole guard, in the shape a window listener can call: true when
 * this keystroke belongs to something the user is typing into.
 *
 * Composition first, then the union of the two element reads. Order is
 * only for readability — all three are independent sufficient reasons.
 */
export function isTypingContext(
  event: KeyEventLike,
  documentLike: { readonly activeElement?: unknown } | null,
): boolean {
  if (isComposingEvent(event)) return true;
  if (isTypingElement(describeEventTarget(event))) return true;
  return isTypingElement(describeActiveElement(documentLike));
}
