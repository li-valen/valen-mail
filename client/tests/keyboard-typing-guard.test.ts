import { describe, expect, it } from 'vitest';
import {
  describeActiveElement,
  describeEventTarget,
  isActivationElement,
  isComposingEvent,
  isTypingContext,
  isTypingElement,
} from '../src/keyboard/typingTarget';
import type { TargetDescriptor } from '../src/keyboard/typingTarget';
import { isRowTarget } from '../src/keyboard/revealRow';

/**
 * The guard ../src/searchQuery.ts refused to write, tested against the
 * three misses it named by name plus the IME case.
 *
 * These are the tests that matter most in this feature: a `j` that jumps
 * the list while someone types "jazz" into the search box is not a
 * cosmetic bug, it is the feature being wrong in the one way that makes
 * users turn it off.
 */

function element(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return { tagName: 'DIV', isContentEditable: false, role: null, ...overrides };
}

describe('isTypingElement', () => {
  it('treats a plain div as not typing', () => {
    expect(isTypingElement(element())).toBe(false);
  });

  it('treats a text input as typing', () => {
    expect(isTypingElement(element({ tagName: 'INPUT' }))).toBe(true);
  });

  it('treats a textarea as typing', () => {
    expect(isTypingElement(element({ tagName: 'TEXTAREA' }))).toBe(true);
  });

  it('treats a select as typing, because letters are a type-ahead inside one', () => {
    expect(isTypingElement(element({ tagName: 'SELECT' }))).toBe(true);
  });

  // The FIRST of searchQuery.ts's three named misses.
  it('treats a contenteditable as typing', () => {
    expect(isTypingElement(element({ isContentEditable: true }))).toBe(true);
  });

  it('treats a nested node inside a contenteditable as typing', () => {
    // `isContentEditable` is inherited by the platform, so a <b> three
    // levels down reports true — which is exactly why the guard reads
    // that property rather than a `contenteditable` attribute.
    expect(isTypingElement(element({ tagName: 'B', isContentEditable: true }))).toBe(true);
  });

  it.each(['textbox', 'searchbox', 'combobox', 'spinbutton'])(
    'treats role=%s as typing whatever the element is',
    (role) => {
      expect(isTypingElement(element({ tagName: 'DIV', role }))).toBe(true);
    },
  );

  it('does not treat role=button as typing', () => {
    expect(isTypingElement(element({ tagName: 'DIV', role: 'button' }))).toBe(false);
  });

  // The THIRD named miss: native pickers. The rule is "every input",
  // which is what makes a type this app has never used still safe.
  it.each(['checkbox', 'date', 'color', 'file', 'range', 'password', 'email'])(
    'treats input[type=%s] as typing, because the rule is every input',
    () => {
      expect(isTypingElement(element({ tagName: 'INPUT' }))).toBe(true);
    },
  );

  it('treats a non-element target as not typing', () => {
    expect(isTypingElement(element({ tagName: null }))).toBe(false);
  });
});

describe('isActivationElement', () => {
  it.each(['BUTTON', 'A', 'SUMMARY'])('recognises <%s>', (tagName) => {
    expect(isActivationElement(element({ tagName }))).toBe(true);
  });

  it.each(['button', 'link'])('recognises role=%s', (role) => {
    expect(isActivationElement(element({ role }))).toBe(true);
  });

  it('does not recognise a plain div', () => {
    expect(isActivationElement(element())).toBe(false);
  });

  it('does not treat a text input as an activation target', () => {
    // The two predicates answer different questions and must not be
    // conflated: suppressing `j` on a button would break navigation from
    // the very element the cursor focuses.
    expect(isActivationElement(element({ tagName: 'INPUT' }))).toBe(false);
  });
});

describe('isComposingEvent', () => {
  it('is true while an IME reports isComposing', () => {
    expect(isComposingEvent({ isComposing: true })).toBe(true);
  });

  it('is true for the legacy keyCode 229 some browsers report instead', () => {
    expect(isComposingEvent({ keyCode: 229 })).toBe(true);
  });

  it('is false for an ordinary keystroke', () => {
    expect(isComposingEvent({ isComposing: false, keyCode: 74 })).toBe(false);
  });

  it('is false for an event that reports neither field', () => {
    expect(isComposingEvent({})).toBe(false);
  });
});

describe('describeEventTarget', () => {
  it('reads tagName, contenteditable and role off the target', () => {
    const target = {
      tagName: 'input',
      isContentEditable: false,
      getAttribute: (name: string) => (name === 'role' ? 'SearchBox' : null),
    };
    // Both normalised: tagName upper, role lower, so neither comparison
    // depends on how the document happened to be authored.
    expect(describeEventTarget({ target })).toEqual({
      tagName: 'INPUT',
      isContentEditable: false,
      role: 'searchbox',
    });
  });

  // The SECOND named miss. `event.target` is retargeted to the shadow
  // HOST, so the outside world sees a <div>; composedPath()[0] is the
  // real innermost node.
  it('prefers composedPath()[0], which sees through a shadow root', () => {
    const host = { tagName: 'MY-EDITOR', isContentEditable: false, getAttribute: () => null };
    const inner = { tagName: 'TEXTAREA', isContentEditable: false, getAttribute: () => null };
    const described = describeEventTarget({ target: host, composedPath: () => [inner, host] });
    expect(described.tagName).toBe('TEXTAREA');
    expect(isTypingElement(described)).toBe(true);
  });

  it('falls back to target when composedPath is unavailable', () => {
    const target = { tagName: 'TEXTAREA', isContentEditable: false, getAttribute: () => null };
    expect(describeEventTarget({ target }).tagName).toBe('TEXTAREA');
  });

  it('describes a missing target as a non-element', () => {
    expect(describeEventTarget({}).tagName).toBeNull();
  });
});

describe('describeActiveElement', () => {
  it('reads document.activeElement', () => {
    const active = { tagName: 'INPUT', isContentEditable: false, getAttribute: () => null };
    expect(describeActiveElement({ activeElement: active }).tagName).toBe('INPUT');
  });

  it('descends through nested shadow roots to the real focused node', () => {
    const inner = { tagName: 'INPUT', isContentEditable: false, getAttribute: () => null };
    const mid = { tagName: 'INNER-HOST', shadowRoot: { activeElement: inner }, getAttribute: () => null };
    const host = { tagName: 'OUTER-HOST', shadowRoot: { activeElement: mid }, getAttribute: () => null };
    expect(describeActiveElement({ activeElement: host }).tagName).toBe('INPUT');
  });

  it('terminates on a shadow root that points at itself', () => {
    // A bounded walk rather than a `while (true)`: a cyclic or absurdly
    // deep tree must not hang the key handler.
    const cyclic: Record<string, unknown> = { tagName: 'LOOP', getAttribute: () => null };
    cyclic.shadowRoot = { activeElement: cyclic };
    expect(describeActiveElement({ activeElement: cyclic }).tagName).toBe('LOOP');
  });

  it('describes a null document as a non-element', () => {
    expect(describeActiveElement(null).tagName).toBeNull();
  });
});

describe('isTypingContext — the union the window listener actually calls', () => {
  const plainTarget = { tagName: 'BODY', isContentEditable: false, getAttribute: () => null };
  const inputTarget = { tagName: 'INPUT', isContentEditable: false, getAttribute: () => null };

  it('is false when neither the event target nor the active element is a field', () => {
    expect(isTypingContext({ target: plainTarget }, { activeElement: plainTarget })).toBe(false);
  });

  it('is true from the event target alone', () => {
    expect(isTypingContext({ target: inputTarget }, { activeElement: plainTarget })).toBe(true);
  });

  it('is true from the active element alone', () => {
    // The disagreement case: a synthesised event, or a browser reporting
    // <body> for keys inside a native picker. Either source is enough.
    expect(isTypingContext({ target: plainTarget }, { activeElement: inputTarget })).toBe(true);
  });

  it('is true mid-composition even when nothing looks like a field', () => {
    expect(
      isTypingContext({ target: plainTarget, isComposing: true }, { activeElement: plainTarget }),
    ).toBe(true);
  });
});

describe('isRowTarget — Enter on a row is ours, Enter on a button is not', () => {
  const rowAttribute = 'data-message-key';

  function node(closestResult: unknown) {
    return { closest: (selector: string) => (selector === `[${rowAttribute}]` ? closestResult : null) };
  }

  it('is true for the row button itself', () => {
    const row = node({ tag: 'the row' });
    expect(isRowTarget({ target: row })).toBe(true);
  });

  it('is true for a span nested inside a row', () => {
    // `closest` walks up, which is why the check uses it rather than
    // reading the attribute off the target directly — the sender name and
    // the subject are both spans inside the one button.
    expect(isRowTarget({ target: node('the ancestor row') })).toBe(true);
  });

  it('is false for a button that is not a row', () => {
    // "Load more" and "Clear search" keep their own Enter.
    expect(isRowTarget({ target: node(null) })).toBe(false);
  });

  it('sees through a shadow root, like the typing guard does', () => {
    const inner = node('a row');
    expect(isRowTarget({ target: node(null), composedPath: () => [inner] })).toBe(true);
  });

  it('is false for a target that cannot be walked', () => {
    expect(isRowTarget({ target: {} })).toBe(false);
    expect(isRowTarget({})).toBe(false);
  });
});
