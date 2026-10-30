import { round6 } from './payout';
import type { V4LinearPace } from './types';

/**
 * LINEAR V4 (contract §3): a crash-game climb on a fixed clock that is the same for every ride of a
 * ticket. value(t) = min(cap, start + (bandMax - start) * g(t / T)), g(s) = 0.4 s + 0.6 s^2.
 *   start = effectiveMin and bandMax = top of the ticket's payout band (ticket constants, not ride values);
 *   T = pace time for the climb to reach the band top; cap = this ride's maximum (< bandMax).
 * Before the cap, a quote depends only on t and ticket constants, so it reveals neither this ride's cap
 * nor its crash. The climb stops at the cap, which is reached before T. That moment is the only one
 * that shows the cap, and the cap is independent of the crash time.
 */
export const LINEAR_PACE_SECONDS: Readonly<Record<V4LinearPace, number>> = Object.freeze({
  FAST: 6,
  MEDIUM: 9,
  SLOW: 12,
});

export function linearProgress(s: number): number {
  return 0.4 * s + 0.6 * s * s;
}

export function linearBoostAt(
  tSeconds: number,
  start: number,
  bandTop: number,
  cap: number,
  pace: V4LinearPace
): number {
  const paceSeconds = LINEAR_PACE_SECONDS[pace];
  const s = tSeconds <= 0 ? 0 : tSeconds >= paceSeconds ? 1 : tSeconds / paceSeconds;
  const climb = round6(start + (bandTop - start) * linearProgress(s));
  return climb >= cap ? cap : climb;
}
