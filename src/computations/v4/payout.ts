/**
 * Payout space. The WAVES final mapping of finalBoostCalculator.ts, unchanged:
 *   mid = (effMin + effMax) / 2
 *   adjusted = mid + (rideValue - mid) * (0.5 + 0.8 * ticketStrength)
 *   raw = adjusted * (0.4 + 0.6 * ticketStrength)
 *   final = clamp(raw, effMin, effMax)
 * V4 applies it to the two ends of the profile ride range only. The image [bandMin, bandMax] is the
 * exact payout range V3 could produce for this ticket. The curve is then built inside that band.
 *
 * Calibration (owner decision 2026-10-30, "V4 sign-off choices" item 2: WAVES back to roughly V3 cost).
 * Where V3's clamp pinned the low part of the ride range to the floor, V3 paid the floor there (flat
 * runs); a straight level-to-band map instead pays more. V4 bends the map toward the floor by the
 * amount V3 pinned, without flattening it:
 *   pinned = share of the profile ride range that V3 maps onto the floor (0 when V3 never clamps there)
 *   bend   = min(MAX_BEND, BEND_PER_PINNED_RATIO_SQ * (pinned / (1 - pinned))^2)
 *   payout = bandMin + g(u) * (bandMax - bandMin),   g(u) = u / (1 + bend * (1 - u))
 * g(0) = 0 and g(1) = 1, so the band (floor, top, ride maximum range) is unchanged; g is strictly
 * increasing (slope >= 1 / (1 + bend) > 0, so no new flats) and is the identity when bend = 0, so
 * where V3 never clamps V4 still equals V3's affine map exactly. Basic IEEE arithmetic only.
 */
export interface PayoutInputs {
  minBoostPct: number;
  maxBoostPct: number;
  effectiveMin: number;
  effectiveMax: number;
  ticketStrength: number;
}

export const PAYOUT_CALIBRATION = Object.freeze({
  /**
   * bend per (pinned / moving)^2 of V3's ride range. Fitted once on the ride-lab V3 baseline
   * (random-lock mean, 14 tickets incl. weak/medium/strong); see handback 1b-ii-c.
   */
  BEND_PER_PINNED_RATIO_SQ: 3.7,
  /**
   * No-flat guard: the curve never moves slower than 1 / (1 + MAX_BEND) of the straight map. Binds only
   * where V3 pinned more than about half of the range (there V4 stays a little above V3 cost).
   */
  MAX_BEND: 4,
});

/** V3's unclamped WAVES mapping (the affine part of wavesFinalMapping). */
function rawMapping(rideValue: number, p: PayoutInputs): number {
  const mid = (p.effectiveMin + p.effectiveMax) / 2;
  const adjusted = mid + (rideValue - mid) * (0.5 + 0.8 * p.ticketStrength);
  return adjusted * (0.4 + 0.6 * p.ticketStrength);
}

export function wavesFinalMapping(rideValue: number, p: PayoutInputs): number {
  return Math.max(p.effectiveMin, Math.min(p.effectiveMax, rawMapping(rideValue, p)));
}

export interface PayoutBand {
  min: number;
  max: number;
  /** Calibration bend of the level-to-payout map (0 = straight). */
  bend: number;
}

/** Share (0..1) of the profile ride range [minBoostPct, maxBoostPct] that V3 pins to the floor. */
export function floorPinnedShare(p: PayoutInputs): number {
  const lo = rawMapping(p.minBoostPct, p);
  const span = rawMapping(p.maxBoostPct, p) - lo;
  if (!(span > 0)) return 0;
  const share = (p.effectiveMin - lo) / span;
  return share <= 0 ? 0 : share >= 1 ? 1 : share;
}

export function payoutBend(p: PayoutInputs): number {
  const pinned = floorPinnedShare(p);
  if (pinned >= 1) return PAYOUT_CALIBRATION.MAX_BEND;
  const ratio = pinned / (1 - pinned);
  return Math.min(PAYOUT_CALIBRATION.MAX_BEND, PAYOUT_CALIBRATION.BEND_PER_PINNED_RATIO_SQ * ratio * ratio);
}

export function payoutBand(p: PayoutInputs): PayoutBand {
  return { min: wavesFinalMapping(p.minBoostPct, p), max: wavesFinalMapping(p.maxBoostPct, p), bend: payoutBend(p) };
}

/** Calibrated level: g(u) = u / (1 + bend * (1 - u)); g(0) = 0, g(1) = 1, identity for bend 0. */
export function bendLevel(u: number, bend: number): number {
  return u / (1 + bend * (1 - u));
}

/** Normalized level u in [0, 1] to an unrounded payout rate. */
export function levelToPayout(u: number, band: PayoutBand): number {
  return band.min + bendLevel(u, band.bend) * (band.max - band.min);
}

/** Half-up to 6 decimals for the non-negative rates used here. */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
