import type { RidePathPoint } from '../types/ride';

export function calculateLinearBoostPctAtElapsed(
  elapsedPct: number,
  crashPct: number,
  effectiveMinBoost: number,
  effectiveMaxBoost: number
): number {
  if (crashPct <= 0) {
    return roundToDecimals(effectiveMaxBoost, 6);
  }

  const progress = clampValue(elapsedPct / crashPct, 0, 1);
  const boost = effectiveMinBoost + ((effectiveMaxBoost - effectiveMinBoost) * progress);
  return roundToDecimals(clampValue(boost, effectiveMinBoost, effectiveMaxBoost), 6);
}

export function buildLinearEffectiveRidePath(
  sampleCount: number,
  crashPct: number,
  effectiveMinBoost: number,
  effectiveMaxBoost: number
): RidePathPoint[] {
  if (sampleCount < 2) {
    return [];
  }

  const points: RidePathPoint[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const timePct = i / (sampleCount - 1);
    const value = timePct >= crashPct
      ? 0
      : calculateLinearBoostPctAtElapsed(
          timePct,
          crashPct,
          effectiveMinBoost,
          effectiveMaxBoost
        );
    points.push({
      timePct: roundToDecimals(timePct, 6),
      baseBoostValue: value,
    });
  }

  return points;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
