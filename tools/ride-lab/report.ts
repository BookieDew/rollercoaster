import type { LabConfig } from './adapter';
import type { DistributionSummary, Mix, Prop } from './metrics';
import { POLICY_NAMES, type PolicyName, type PolicyStats } from './policies';

export interface ConfigResult {
  config: LabConfig;
  effectiveMin: { mean: number };
  effectiveMax: { mean: number };
  distribution: DistributionSummary;
  policies: Record<PolicyName, PolicyStats>;
  runtimeSeconds: number;
}

const pct = (p: Prop) => (Number.isNaN(p.p) ? 'n/a' : `${(p.p * 100).toFixed(1)}% [${(p.lo * 100).toFixed(1)}, ${(p.hi * 100).toFixed(1)}]`);
const rate = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(2)}%`);

function thirdRow(config: string, third: string, source: string, m: Mix): string {
  return `| ${config} | ${third} | ${source} | ${m.n} | ${PHASE_KEYS.map((k) => pct(m.shares[k])).join(' | ')} |`;
}

export function renderReport(opts: {
  engine: string; n: number; seedBase: string; stepMs: number; results: ConfigResult[]; generatedAt: string;
}): string {
  const L: string[] = [];
  L.push(`# Ride lab report: engine ${opts.engine}`, '');
  L.push(`Seeds per configuration: ${opts.n}. Seed base: \`${opts.seedBase}\`. Time grid: ${opts.stepMs} ms. Generated ${opts.generatedAt}.`);
  L.push('Intervals are 95% Wilson intervals shown as `share [low, high]`. Rates are payout rates (1.00 = 100%).', '');
  const modes = [...new Set(opts.results.map((r) => r.config.mode))];
  L.push('## Inputs', '');
  const c0 = opts.results[0].config.profile;
  L.push(`Profile: boost ${rate(c0.minBoostPct)} to ${rate(c0.maxBoostPct)}; ticket needs ${c0.minSelections} selections and combined odds ${c0.minCombinedOdds}; full cap at ${c0.maxBoostMinSelections} selections and odds ${c0.maxBoostMinCombinedOdds}; weights ${c0.maxEligibilitySelectionWeight}/${c0.maxEligibilityOddsWeight}; floor rate ${c0.effectiveMinFloorRate}.`, '');
  L.push('| config | selections | combined odds | ticket strength | mean effective min | mean effective max |', '|---|---|---|---|---|---|');
  for (const r of opts.results) {
    L.push(`| ${r.config.label} | ${r.config.ticket.qualifyingSelections} | ${r.config.ticket.combinedOdds} | ${r.config.ticket.ticketStrength} | ${rate(r.effectiveMin.mean)} | ${rate(r.effectiveMax.mean)} |`);
  }
  L.push('', 'Targets: no-crash 8%; crashed rides EARLY/MID/LATE 10/65/25 (edges at 25% and 80% of duration); phases UP/PEAK/DOWN 50/20/30; 2-4 peaks; no long plateaus or horns; F8 tell gap small.', '');

  L.push('## Definitions of the observed measures', '');
  L.push('- Observed phase: slope over the last 300 ms before the crash divided by (effective max - effective min). Above +3% = UP, below -3% = DOWN, otherwise PEAK. Degenerate range = PEAK.');
  L.push('- Peak: interior local maximum with prominence of at least 5% of (effective max - effective min), measured on the pre-crash path. A ride that crashes while at its top has no right side and is not counted.');
  L.push('- Plateau: longest stretch where max minus min stays within 0.1 percentage points; a ride counts as plateaued if that stretch lasts 1.0 s or more.');
  L.push('- Horn proxy: a peak with prominence of at least 15% of the range and width at half prominence of at most 0.3 s.');
  L.push('- F8 tell: among crashed rides, the share whose maximum is first reached within the last 800 ms before the crash. Baseline: the same curve with the crash time redrawn independently (crash fraction taken from another crashed ride, at least 2 s). Needs the engine to expose its crash-free curve.', '');

  for (const mode of modes) {
    const rs = opts.results.filter((r) => r.config.mode === mode);
    L.push(`## ${mode}`, '');
    L.push('### Outcome and crash timing (all ticket configs share the same seeds)', '');
    L.push('| config | no-crash | EARLY (of crashed) | MID | LATE |', '|---|---|---|---|---|');
    for (const r of rs) {
      const d = r.distribution;
      L.push(`| ${r.config.label} | ${pct(d.noCrash)} | ${BUCKET_KEYS.map((k) => pct(d.buckets.shares[k])).join(' | ')} |`);
    }
    L.push('', '### Crash phase', '', '| config | source | crashed rides | UP | PEAK | DOWN |', '|---|---|---|---|---|---|');
    for (const r of rs) {
      const d = r.distribution;
      L.push(`| ${r.config.label} | reported by engine | ${d.reportedPhase.n} (${pct(d.reportedPhase.reportedShareOfCrashed)} of crashed) | ${PHASE_KEYS.map((k) => pct(d.reportedPhase.shares[k])).join(' | ')} |`);
      L.push(`| ${r.config.label} | observed | ${d.observedPhase.n} | ${PHASE_KEYS.map((k) => pct(d.observedPhase.shares[k])).join(' | ')} |`);
    }
    L.push('', '### Shape', '', '| config | peaks 0/1/2/3/4/5+ | mean peaks | 2-4 peaks | plateau (>= 1 s) | mean longest flat (s) | horn proxy |', '|---|---|---|---|---|---|---|');
    for (const r of rs) {
      const d = r.distribution;
      const h = d.peaks.histogram;
      L.push(`| ${r.config.label} | ${['0', '1', '2', '3', '4', '5+'].map((k) => h[k]).join('/')} | ${d.peaks.mean.toFixed(2)} | ${pct(d.peaks.share2to4)} | ${pct(d.plateau.share)} | ${d.plateau.meanLongestSeconds.toFixed(2)} | ${pct(d.horn)} |`);
    }
    L.push('', '### F8: maximum first reached in the last 800 ms before the crash', '', '| config | crashed rides | tell share | baseline | gap (pp) | gap 95% CI (pp) |', '|---|---|---|---|---|---|');
    for (const r of rs) {
      const f = r.distribution.f8;
      L.push(`| ${r.config.label} | ${f.crashed} | ${pct(f.tell)} | ${f.baseline ? pct(f.baseline) : 'n/a'} | ${f.gapPp === null ? 'n/a' : f.gapPp.toFixed(1)} | ${f.gapCi95Pp ? `[${f.gapCi95Pp[0].toFixed(1)}, ${f.gapCi95Pp[1].toFixed(1)}]` : 'n/a'} |`);
    }
    L.push('', '### By duration third (F3: should all match the overall row)', '');
    for (const r of rs.slice(0, 1)) {
      L.push(`Outcome and bucket columns do not depend on the ticket, so shown once for ${r.config.label}.`, '');
      L.push('| third | rides | no-crash | EARLY | MID | LATE |', '|---|---|---|---|---|---|');
      for (const t of r.distribution.thirds) {
        L.push(`| ${t.label} | ${t.n} | ${pct(t.noCrash)} | ${BUCKET_KEYS.map((k) => pct(t.buckets.shares[k])).join(' | ')} |`);
      }
    }
    L.push('', '| config | third | source | crashed | UP | PEAK | DOWN |', '|---|---|---|---|---|---|---|');
    for (const r of rs) {
      for (const t of r.distribution.thirds) {
        L.push(thirdRow(r.config.label, t.label, 'observed', t.observedPhase));
        if (t.reportedPhase.n > 0) L.push(thirdRow(r.config.label, t.label, 'reported', t.reportedPhase));
      }
    }
    L.push('', '### Payout under lock policies (rate paid; zero share = never locked or crashed first)', '', '| config | policy | mean | P50 | P90 | P99 | zero share |', '|---|---|---|---|---|---|---|');
    for (const r of rs) {
      for (const name of POLICY_NAMES) {
        const s = r.policies[name];
        L.push(`| ${r.config.label} | ${name} | ${rate(s.mean)} | ${rate(s.p50)} | ${rate(s.p90)} | ${rate(s.p99)} | ${(s.zeroShare * 100).toFixed(1)}% |`);
      }
    }
    L.push('');
  }
  L.push('Policy notes: uniform-terminal locks at a uniform time before the ride ends or crashes; uniform-duration locks uniformly over the whole duration (zero when the ride already crashed); reach-X locks at the first moment the rate is at least X% of the effective maximum, i.e. the cap (zero if never reached; in WAVES the cap is rarely reachable); ceil-X is the same against the typical ceiling of the configuration (median per-ride maximum); hindsight is the best rate on the path.', '');
  return L.join('\n');
}

const BUCKET_KEYS = ['EARLY', 'MID', 'LATE'];
const PHASE_KEYS = ['UP', 'PEAK', 'DOWN'];
