// Easing and motion preferences for the HUD animations (pulses, the edit morph, the pacing of JEV's steps). Timing
// constants of the design note (sections 8.1 and 11) live here so every animation agrees on them.

export const EASE_MS = 240;          // state changes
export const MORPH_MS = 1200;        // the ghost -> edited curve morph (slow enough to follow the edit as a movement)
export const PULSE_MS = 1500;        // a pulse travelling its connector (long enough to follow it from block to block)
export const PULSE_LINGER_MS = 1400; // a pulse's label stays this long after its dot arrived
export const JEV_DWELL_MS = 900;     // a JEV step is shown at least this long (at 1x) before the next one of a burst
export const BREATH_MS = 1600;       // the LLM thinking indicator

export const lerp = (a, b, t) => a + (b - a) * t;

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** True when the viewer asked the system for less motion (travel and breathing are then switched off). */
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
