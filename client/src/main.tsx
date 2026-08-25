import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('main: #root element is missing from index.html');
}

/**
 * `reducedMotion="user"` is the motion layer's SECOND line of defence,
 * not its first (Plan 7 Task 2).
 *
 * The first is per-component: every animated component reads
 * `useReducedMotion()` and hands the answer to a `*VariantsFor(isReduced)`
 * builder in src/motion/variants.ts, which returns a variant pair whose
 * two ends are identical — the motion is removed, not shortened. This
 * prop makes `motion` itself refuse to animate transforms for a viewer
 * who asked for reduced motion, so a component added later that forgets
 * the hook still degrades correctly instead of shipping a moving surface.
 * `motion`'s own default is `"never"`, i.e. ignore the preference — which
 * is precisely why this cannot be left off.
 *
 * It does NOT replace the per-component path, and the guard test
 * (tests/motion-reduced-guard.test.ts) deliberately does not accept "the
 * root has MotionConfig" as an answer for a component file: `"user"`
 * suppresses transform and layout animation, not opacity, and this
 * project's contract is that reduced motion removes the whole thing.
 */
createRoot(container).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
