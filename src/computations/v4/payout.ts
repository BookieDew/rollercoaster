/**
 * Payout space. The WAVES final mapping of finalBoostCalculator.ts, unchanged:
 *   mid = (effMin + effMax) / 2
 *   adjusted = mid + (rideValue - mid) * (0.5 + 0.8 * ticketStrength)
 *   raw = adjusted * (0.4 + 0.6 * ticketStrength)
 *   final = clamp(raw, effMin, effMax)
 * V4 applies it to the two ends of the profile ride range only. The image [bandMin, bandMax] is the
 * exact payout range V3 could produce for this ticket. The curve is then built inside that band.
 * Where V3's clamp is inactive, V4 reproduces V3's affine map exactly; where V3 clamped (flat runs
 * at the floor or cap), V4 spreads the same levels over the band instead.
 */
export interface PayoutInputs {
  minBoostPct: number;
  maxBoostPct: number;
  effectiveMin: number;
  effectiveMax: number;
  ticketStrength: number;
}

export function wavesFinalMapping(rideValue: number, p: PayoutInputs): number {
  const mid = (p.effectiveMin + p.effectiveMax) / 2;
  const adjusted = mid + (rideValue - mid) * (0.5 + 0.8 * p.ticketStrength);
  const raw = adjusted * (0.4 + 0.6 * p.ticketStrength);
  return Math.max(p.effectiveMin, Math.min(p.effectiveMax, raw));
}

export interface PayoutBand {
  min: number;
  max: number;
}

export function payoutBand(p: PayoutInputs): PayoutBand {
  return { min: wavesFinalMapping(p.minBoostPct, p), max: wavesFinalMapping(p.maxBoostPct, p) };
}

/** Normalized level u in [0, 1] to an unrounded payout rate. */
export function levelToPayout(u: number, band: PayoutBand): number {
  return band.min + u * (band.max - band.min);
}

/** Half-up to 6 decimals for the non-negative rates used here. */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
