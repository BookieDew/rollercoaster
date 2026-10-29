import { quantile, type RideRecord } from './metrics';

/**
 * Lock policies. A player locks the boost rate shown at the lock time; a ride that is never locked
 * (policy trigger not reached before the terminal time) pays 0.
 *  - uniform-terminal : lock at a uniform random time in [0, terminal)  (never zero by construction)
 *  - uniform-duration : lock at a uniform random time in [0, duration); after the terminal pays 0
 *  - reach-50/75/90   : lock at the first grid time the rate is >= X % of effectiveMax (the cap)
 *  - ceil-50/75/90    : same, but X % of the typical ceiling = median per-ride maximum of this configuration
 *                       (the cap is rarely reachable in WAVES, so reach-X can be all zeros)
 *  - hindsight        : the best rate on the path (upper bound)
 * Rates are read from the 50 ms grid (value at the grid time).
 */
export interface PolicyStats { mean: number; p50: number; p90: number; p99: number; zeroShare: number; n: number }
export type PolicyName =
  | 'uniform-terminal' | 'uniform-duration'
  | 'reach-50' | 'reach-75' | 'reach-90'
  | 'ceil-50' | 'ceil-75' | 'ceil-90'
  | 'hindsight';
export const POLICY_NAMES: PolicyName[] = [
  'uniform-terminal', 'uniform-duration', 'reach-50', 'reach-75', 'reach-90', 'ceil-50', 'ceil-75', 'ceil-90', 'hindsight',
];

export function lockValue(
  policy: PolicyName,
  rec: RideRecord,
  u: number,
  typicalCeiling = rec.effectiveMax
): number {
  const v = rec.values;
  switch (policy) {
    case 'uniform-terminal': {
      if (v.length === 0) return 0;
      return v[Math.min(v.length - 1, Math.floor(u * rec.terminalAtSeconds / rec.stepSeconds))];
    }
    case 'uniform-duration': {
      const k = Math.floor((u * rec.durationSeconds) / rec.stepSeconds);
      return k < v.length ? v[k] : 0;
    }
    case 'hindsight':
      return v.length ? Math.max(...v) : 0;
    default: {
      const base = policy.startsWith('ceil') ? typicalCeiling : rec.effectiveMax;
      const target = (Number(policy.slice(policy.indexOf('-') + 1)) / 100) * base;
      const k = v.findIndex((x) => x >= target - 1e-12);
      return k >= 0 ? v[k] : 0;
    }
  }
}

export function policyStats(values: number[]): PolicyStats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  return {
    n,
    mean: n ? values.reduce((a, b) => a + b, 0) / n : NaN,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    zeroShare: n ? values.filter((x) => x <= 0).length / n : NaN,
  };
}

export function evaluatePolicies(recs: RideRecord[], draws: number[]): Record<PolicyName, PolicyStats> {
  const out = {} as Record<PolicyName, PolicyStats>;
  const maxima = recs.map((r) => lockValue('hindsight', r, 0)).sort((a, b) => a - b);
  const ceiling = quantile(maxima, 0.5);
  for (const name of POLICY_NAMES) {
    out[name] = policyStats(recs.map((r, i) => lockValue(name, r, draws[i], ceiling)));
  }
  return out;
}

