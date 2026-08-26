import { describe, it, expect } from 'vitest';
import { nextFocusIndex, isMenuKey } from '../src/components/actionMenuFocus';

describe('nextFocusIndex — moving focus inside the reader’s overflow menu', () => {
  const COUNT = 3;

  it('steps down and up through the items', () => {
    expect(nextFocusIndex(0, 'ArrowDown', COUNT)).toBe(1);
    expect(nextFocusIndex(1, 'ArrowDown', COUNT)).toBe(2);
    expect(nextFocusIndex(2, 'ArrowUp', COUNT)).toBe(1);
  });

  it('WRAPS at both ends rather than clamping', () => {
    // WAI-ARIA's menu pattern wraps. Clamping strands an arrow key at the
    // bottom of a three-item menu with no feedback, which reads as the
    // control being broken rather than as having reached an edge.
    expect(nextFocusIndex(2, 'ArrowDown', COUNT)).toBe(0);
    expect(nextFocusIndex(0, 'ArrowUp', COUNT)).toBe(2);
  });

  it('gives a menu opened by POINTER a sensible first arrow press', () => {
    // -1 is "nothing focused yet", which is how the menu opens on a click.
    expect(nextFocusIndex(-1, 'ArrowDown', COUNT)).toBe(0);
    expect(nextFocusIndex(-1, 'ArrowUp', COUNT)).toBe(COUNT - 1);
  });

  it('jumps to the ends', () => {
    expect(nextFocusIndex(1, 'Home', COUNT)).toBe(0);
    expect(nextFocusIndex(1, 'End', COUNT)).toBe(COUNT - 1);
  });

  it('survives a menu with nothing in it rather than returning a bad index', () => {
    // Reachable: every item is optional, and a message with no mailbox
    // handlers and no star handler renders none of them.
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const) {
      expect(nextFocusIndex(0, key, 0)).toBe(-1);
    }
  });

  it('handles a single item without spinning or going out of range', () => {
    expect(nextFocusIndex(0, 'ArrowDown', 1)).toBe(0);
    expect(nextFocusIndex(0, 'ArrowUp', 1)).toBe(0);
  });

  it('recognises exactly the keys it implements, and no others', () => {
    // If these two ever disagree, a key routes into `nextFocusIndex`'s
    // switch and falls out the bottom as undefined.
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(isMenuKey(key)).toBe(true);
    for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Tab', ' ']) {
      expect(isMenuKey(key)).toBe(false);
    }
  });
});
