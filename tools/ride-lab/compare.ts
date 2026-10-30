import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { quantile, type Prop } from './metrics';
import { buildConfigs } from './configs';
import { seedAt } from './seeds';
import { linearCapReach } from './v4Adapter';
import { LINEAR_PACE_SECONDS } from '../../src/computations/v4';
import { POLICY_NAMES, type PolicyName } from './policies';
import type { ConfigResult } from './report';

/**
 * V3 -> V4 comparison for the owner. Reads only results.json files (V3 baseline + three V4 LINEAR
 * pace runs) and writes one plain-language markdown file. No clock, no randomness: same inputs give
 * the same bytes.
 *
 *   npm run ride-lab:compare -- [--v3 <results.json>] [--v4-dir <dir with v4-fast|v4-medium|v4-slow>] [--out <comparison.md>]
 */
export interface ResultsFile {
  engine: string;
  linearPace?: string;
  n: number;
  seedBase: string;
  stepMs: number;
  results: ConfigResult[];
}

export const PACES = ['FAST', 'MEDIUM', 'SLOW'] as const;
type Pace = (typeof PACES)[number];
/** Seconds for the climb to reach the top of the ticket's payout band (V4 `LINEAR_PACE_SECONDS`). */
const PACE_SECONDS: Record<Pace, number> = LINEAR_PACE_SECONDS;
const TICKETS = ['weak', 'medium', 'strong'] as const;

// ---------- formatting ----------
const pct1 = (p: Prop) => (Number.isNaN(p.p) ? 'n/a' : `${(p.p * 100).toFixed(1)}%`);
const rate1 = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const rate2 = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(2)}%`);
const share1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => {
  const shown = Math.abs(x).toFixed(1);
  return shown === '0.0' ? '0.0 pp' : `${x > 0 ? '+' : '-'}${shown} pp`;
};
const ppDelta = (from: number, to: number) => pp((to - from) * 100);
const triple = (m: { shares: Record<string, Prop> }, keys: string[]) =>
  keys.map((k) => (Number.isNaN(m.shares[k].p) ? 'n/a' : (m.shares[k].p * 100).toFixed(1))).join(' / ');

const BUCKETS = ['EARLY', 'MID', 'LATE'];
const PHASES = ['UP', 'PEAK', 'DOWN'];

function load(path: string): ResultsFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ResultsFile;
}

function byLabel(file: ResultsFile, label: string): ConfigResult {
  const found = file.results.find((r) => r.config.label === label);
  if (!found) throw new Error(`results for ${label} missing in ${file.engine}${file.linearPace ?? ''}`);
  return found;
}

const strip = (r: ConfigResult) => JSON.stringify({ ...r, runtimeSeconds: 0 });
const sameOutcome = (a: ConfigResult, b: ConfigResult) =>
  JSON.stringify([a.distribution.noCrash, a.distribution.buckets, a.distribution.thirds.map((t) => [t.noCrash, t.buckets])]) ===
  JSON.stringify([b.distribution.noCrash, b.distribution.buckets, b.distribution.thirds.map((t) => [t.noCrash, t.buckets])]);

/** Measured per pace and ticket: when this ride's climb reaches its own cap (median, P90) and how many rides live that long. */
export interface CapTime { median: number; p90: number; reachedShare: number }
export type CapTimes = Record<Pace, Record<(typeof TICKETS)[number], CapTime>>;

export function computeCapTimes(n: number, seedBase: string): CapTimes {
  const out = {} as CapTimes;
  const configs = buildConfigs(['LINEAR']);
  for (const pace of PACES) {
    out[pace] = {} as CapTimes[Pace];
    for (const cfg of configs) {
      const reach = Array.from({ length: n }, (_, i) => linearCapReach(seedAt(seedBase, 'ride', i), cfg, pace));
      const times = reach.map((r) => r.capSeconds).sort((a, b) => a - b);
      out[pace][cfg.ticketLabel] = {
        median: quantile(times, 0.5),
        p90: quantile(times, 0.9),
        // The cap is reached (and can be locked) only if the ride has not ended or crashed by then.
        reachedShare: reach.filter((r) => r.terminalSeconds > r.capSeconds).length / n,
      };
    }
  }
  return out;
}

interface Col { name: string; get: (label: string) => ConfigResult }

function table(head: string[], rows: string[][]): string[] {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), ''];
}

export function renderComparison(opts: {
  v3: ResultsFile;
  v4: Record<Pace, ResultsFile>;
  links: { v3: string; v4: Record<Pace, string> };
  capTimes: CapTimes;
}): string {
  const { v3, v4, links, capTimes } = opts;

  // ---- sanity: the runs are comparable ----
  for (const f of [v4.FAST, v4.MEDIUM, v4.SLOW]) {
    if (f.n !== v3.n || f.seedBase !== v3.seedBase || f.stepMs !== v3.stepMs) {
      throw new Error('V3 and V4 runs differ in n, seed base or step; re-run with identical arguments');
    }
  }
  for (const label of ['WAVES/weak', 'WAVES/medium', 'WAVES/strong']) {
    const ref = strip(byLabel(v4.MEDIUM, label));
    if (strip(byLabel(v4.FAST, label)) !== ref || strip(byLabel(v4.SLOW, label)) !== ref) {
      throw new Error(`WAVES results differ across LINEAR paces for ${label}: the pace must not affect WAVES`);
    }
  }
  for (const t of TICKETS) {
    const l = `LINEAR/${t}`;
    if (!sameOutcome(byLabel(v4.FAST, l), byLabel(v4.MEDIUM, l)) || !sameOutcome(byLabel(v4.SLOW, l), byLabel(v4.MEDIUM, l))) {
      throw new Error(`crash/no-crash outcomes differ across LINEAR paces for ${l}: the pace must not affect outcomes`);
    }
  }

  const waves3 = (t: string) => byLabel(v3, `WAVES/${t}`);
  const waves4 = (t: string) => byLabel(v4.MEDIUM, `WAVES/${t}`);
  const lin3 = (t: string) => byLabel(v3, `LINEAR/${t}`);
  const lin4 = (p: Pace, t: string) => byLabel(v4[p], `LINEAR/${t}`);
  const pol = (r: ConfigResult, p: PolicyName) => r.policies[p];

  const L: string[] = [];
  L.push('# Ride engine: V3 today vs the proposed V4', '');
  L.push(
    `Plain-language comparison. Every number comes from ${v3.n.toLocaleString('en-US')} simulated rides per ticket type and mode ` +
      `(seed base \`${v3.seedBase}\`, ${v3.stepMs} ms time grid), the same seeds for V3 and V4, so differences are the engines, not luck. ` +
      'Rates are what a player would be paid as a share of the stake-based boost (15% means a 15% boost). ' +
      '"pp" = percentage points. Each linked report.md carries the 95% intervals (typically about 0.4 pp for a share near 8%, 0.7 pp near 50%).',
    ''
  );
  L.push('Ticket types: **weak** = the minimum ticket (3 selections, odds 3.5), **medium** = 5 selections at odds 10, **strong** = 8 selections at odds 60. ' +
    'Lock policies: **random lock** = the player locks at a random moment before the ride ends or crashes; **random over whole ride** = random moment over the full planned length (pays zero if it had already crashed); ' +
    '**reach X%** = locks the first time the boost is at least X% of the ride\'s cap (zero if never reached); **ceil X%** = the same against the typical ceiling of that ticket type; **hindsight** = the best moment on the path, an upper bound no player can reliably hit.', '');

  L.push('Galleries (sample rides, weak/medium/strong, both modes):', '');
  L.push(`- [V3 today](${links.v3})`);
  for (const p of PACES) L.push(`- [V4, LINEAR pace ${p}](${links.v4[p]})`);
  L.push('');

  // ---- the short version ----
  const wUt = TICKETS.map((t) => `${t} ${rate1(pol(waves3(t), 'uniform-terminal').mean)} to ${rate1(pol(waves4(t), 'uniform-terminal').mean)}`).join(', ');
  const wHs = TICKETS.map((t) => `${t} ${rate1(pol(waves3(t), 'hindsight').mean)} to ${rate1(pol(waves4(t), 'hindsight').mean)}`).join(', ');
  const wPlat = TICKETS.map((t) => `${share1(waves3(t).distribution.plateau.share.p)} to ${share1(waves4(t).distribution.plateau.share.p)}`).join(' / ');
  const w3 = waves3('medium').distribution;
  const w4 = waves4('medium').distribution;
  L.push('## The short version', '');
  L.push(`- **Crashes.** Rides that never crash: V3 ${pct1(w3.noCrash)}, V4 ${pct1(w4.noCrash)} (target 8%). In the shortest third of ride lengths the share is V3 ${pct1(w3.thirds[0].noCrash)}, V4 ${pct1(w4.thirds[0].noCrash)}.`);
  L.push(`- **Wave rides, average payout** (random lock, V3 to V4): ${wUt}. Best possible lock: ${wHs}. See "What changes" below.`);
  L.push(`- **Flat stretches** of 1 s or longer (weak / medium / strong): ${wPlat}.`);
  L.push(`- **Crash giveaway** (the highest point arrives in the last 0.8 s before the crash, compared with a crash drawn independently): V3 ${waves3('medium').distribution.f8.gapPp === null ? 'n/a' : pp(waves3('medium').distribution.f8.gapPp as number)}, V4 ${waves4('medium').distribution.f8.gapPp === null ? 'n/a' : pp(waves4('medium').distribution.f8.gapPp as number)} on medium tickets; closer to 0 is better.`);
  const linMean = (p: Pace) => TICKETS.map((t) => rate1(pol(lin4(p, t), 'uniform-terminal').mean)).join(' / ');
  L.push(`- **Linear rides, average payout** (random lock, weak / medium / strong): V3 ${TICKETS.map((t) => rate1(pol(lin3(t), 'uniform-terminal').mean)).join(' / ')}; V4 FAST ${linMean('FAST')}; MEDIUM ${linMean('MEDIUM')}; SLOW ${linMean('SLOW')}.`);
  L.push('');

  L.push('## Things to know before sign-off', '');
  const e3 = w3.buckets, e4 = w4.buckets;
  L.push(`- **Crash timing basis (owner decision pending).** The lab measures EARLY/MID/LATE against the ride's full duration (edges at 25% and 80%). V3 gives ${triple(e3, BUCKETS)} (target 10 / 65 / 25); V4 gives ${triple(e4, BUCKETS)}. ` +
    'V4 places crashes inside the allowed crash window (from the 2 s minimum to the end of the ride), so its mix is identical for every ride length, but by the lab\'s duration-based ruler it shows fewer early crashes. ' +
    'No engine can give 10% early crashes in rides shorter than 8 s with a 2 s minimum crash time (details in the V4 engine handback).');
  L.push(`- **Wave payout moves.** Random-lock average V3 to V4: ${TICKETS.map((t) => `${t} ${ppDelta(pol(waves3(t), 'uniform-terminal').mean, pol(waves4(t), 'uniform-terminal').mean)}`).join(', ')}. Where V3 sat pinned at the ticket floor for long flat stretches (${wPlat} held flat, weak / medium / strong), V4 climbs off the floor instead, so those tickets are paid more. V4 has a calibration knob for payout parity if you want it (see the V4 engine handback).`);
  L.push(`- **Linear caps differ.** V3 climbs in a straight line to the cap exactly at the crash moment; V4 climbs on a fixed clock (the same speed for every ride of a ticket) and stops at that ride\'s own cap, which it reaches at ${PACES.map((p) => `${capTimes[p].medium.median.toFixed(1)} s`).join(' / ')} (FAST / MEDIUM / SLOW, medium ticket, median). "Reach X%" policies use each engine\'s own cap, so compare those rows with that in mind.`);
  L.push('- **"Observed" crash phase** is the lab\'s own 0.3 s slope reading, not what the engine intended; it disagrees with the engine\'s phase on slow waves. The engine-reported phase is the reference where available.');
  L.push('');

  // ---- per mode tables ----
  const outcomeBlock = (mode: 'WAVES' | 'LINEAR') => {
    const get3 = (t: string) => byLabel(v3, `${mode}/${t}`);
    const get4 = (t: string) => byLabel(v4.MEDIUM, `${mode}/${t}`);
    const identical = TICKETS.every((t) => sameOutcome(get3('weak'), get3(t)) && sameOutcome(get4('weak'), get4(t)));
    const tickets = identical ? (['weak'] as const) : TICKETS;
    const out: string[] = [];
    out.push('### Crashes: how often, and when', '');
    out.push(identical
      ? 'Crash and no-crash outcomes do not depend on the ticket, so one table covers weak, medium and strong. Buckets show EARLY / MID / LATE as % of crashed rides.'
      : 'Buckets show EARLY / MID / LATE as % of crashed rides.', '');
    const rows: string[][] = [];
    for (const t of tickets) {
      const a = get3(t).distribution, b = get4(t).distribution;
      const tag = identical ? '' : `${t}: `;
      rows.push([`${tag}rides that never crash (target 8%)`, pct1(a.noCrash), pct1(b.noCrash)]);
      rows.push([`${tag}crash timing, all rides (target 10 / 65 / 25)`, triple(a.buckets, BUCKETS), triple(b.buckets, BUCKETS)]);
      a.thirds.forEach((th, i) => {
        const bt = b.thirds[i];
        rows.push([`${tag}never crash, ${i === 0 ? 'shortest' : i === 1 ? 'middle' : 'longest'} third of ride lengths (${th.label})`, pct1(th.noCrash), pct1(bt.noCrash)]);
        rows.push([`${tag}crash timing, same third`, triple(th.buckets, BUCKETS), triple(bt.buckets, BUCKETS)]);
      });
    }
    out.push(...table(['measure', 'V3', 'V4'], rows));

    out.push('### Crash phase (what the curve is doing when it crashes)', '');
    out.push(mode === 'WAVES'
      ? 'Targets: UP / PEAK / DOWN = 50 / 20 / 30. "Engine-reported" is what the engine says it built (V3 only knows this for part of its rides; V4 for all). "Observed" is the lab\'s own reading of the last 0.3 s.'
      : 'LINEAR has no engine phase. "Observed" is the lab\'s reading of the last 0.3 s; a linear climb is mostly UP until the cap, then flat.', '');
    const prow: string[][] = [];
    for (const t of TICKETS) {
      const a = get3(t).distribution, b = get4(t).distribution;
      if (mode === 'WAVES') {
        prow.push([`${t}, engine-reported`, `${triple(a.reportedPhase, PHASES)} (${pct1(a.reportedPhase.reportedShareOfCrashed)} of crashes covered)`, `${triple(b.reportedPhase, PHASES)} (${pct1(b.reportedPhase.reportedShareOfCrashed)} covered)`]);
      }
      prow.push([`${t}, observed`, triple(a.observedPhase, PHASES), triple(b.observedPhase, PHASES)]);
    }
    out.push(...table(['config', 'V3', 'V4'], prow));
    return out;
  };

  const shapeTable = (mode: 'WAVES' | 'LINEAR', cols: Col[]) => {
    const out: string[] = [];
    out.push('### Shape and the crash giveaway', '');
    out.push(mode === 'WAVES'
      ? 'Peaks are counted on the visible path before the crash (or end), so a ride that crashes early shows fewer. Targets: 2 to 4 peaks, no flat stretch of 1 s or more, no needle-thin spikes, giveaway gap near 0.'
      : 'A linear ride has no peaks by design. "Held flat" is a stretch of 1 s or more within 0.1 pp: V4 holds the cap once reached, so it is expected there. The giveaway gap is less meaningful here because a climb always has its maximum at the end.', '');
    const head = ['config', 'measure', ...cols.map((c) => c.name)];
    const rows: string[][] = [];
    for (const t of TICKETS) {
      const label = `${mode}/${t}`;
      const at = (f: (r: ConfigResult) => string) => cols.map((c) => f(c.get(label)));
      if (mode === 'WAVES') {
        rows.push([t, 'peaks 0/1/2/3/4/5+ (share of rides)', ...at((r) => ['0', '1', '2', '3', '4', '5+'].map((k) => ((r.distribution.peaks.histogram[k] / r.distribution.n) * 100).toFixed(0)).join('/'))]);
        rows.push([t, 'rides with 2 to 4 visible peaks', ...at((r) => pct1(r.distribution.peaks.share2to4))]);
        rows.push([t, 'needle-thin spikes', ...at((r) => pct1(r.distribution.horn))]);
      }
      rows.push([t, 'held flat for 1 s or more', ...at((r) => pct1(r.distribution.plateau.share))]);
      rows.push([t, 'longest flat stretch, average (s)', ...at((r) => r.distribution.plateau.meanLongestSeconds.toFixed(2))]);
      rows.push([t, 'highest point in last 0.8 s before crash', ...at((r) => pct1(r.distribution.f8.tell))]);
      rows.push([t, 'same, crash drawn independently', ...at((r) => (r.distribution.f8.baseline ? pct1(r.distribution.f8.baseline) : 'n/a'))]);
      rows.push([t, 'giveaway gap', ...at((r) => (r.distribution.f8.gapPp === null ? 'n/a' : pp(r.distribution.f8.gapPp)))]);
    }
    out.push(...table(head, rows));
    return out;
  };

  const payoutBlock = (mode: 'WAVES' | 'LINEAR', cols: Col[]) => {
    const out: string[] = [];
    out.push('### Payout impact', '');
    out.push('Average payout by lock policy, then the full spread. Zero share = rides that pay nothing under that policy.', '');
    const meanRows: string[][] = [];
    for (const t of TICKETS) {
      for (const p of POLICY_NAMES) {
        const label = `${mode}/${t}`;
        const vals = cols.map((c) => c.get(label).policies[p].mean);
        meanRows.push([t, p, ...vals.map(rate2), ...vals.slice(1).map((v) => ppDelta(vals[0], v))]);
      }
    }
    out.push(...table(['ticket', 'policy', ...cols.map((c) => `${c.name} mean`), ...cols.slice(1).map((c) => `${c.name} vs V3`)], meanRows));
    out.push('Full spread (mean, P50 / P90 / P99 of the locked boost, share paying zero):', '');
    const rows: string[][] = [];
    for (const t of TICKETS) {
      for (const p of POLICY_NAMES) {
        for (const c of cols) {
          const s = c.get(`${mode}/${t}`).policies[p];
          rows.push([t, p, c.name, rate2(s.mean), rate2(s.p50), rate2(s.p90), rate2(s.p99), share1(s.zeroShare)]);
        }
      }
    }
    out.push(...table(['ticket', 'policy', 'engine', 'mean', 'P50', 'P90', 'P99', 'zero share'], rows));
    return out;
  };

  const v3Col: Col = { name: 'V3', get: (l) => byLabel(v3, l) };
  const v4Col: Col = { name: 'V4', get: (l) => byLabel(v4.MEDIUM, l) };

  // WAVES
  L.push('## WAVES (the wavy ride)', '');
  L.push('V4 uses one wave design for every pace choice; the LINEAR pace does not affect WAVES.', '');
  L.push(...outcomeBlock('WAVES'));
  L.push(...shapeTable('WAVES', [v3Col, v4Col]));
  L.push(...payoutBlock('WAVES', [v3Col, v4Col]));
  const hold = (p: PolicyName, t: string) => `${rate1(pol(waves3(t), p).mean)} to ${rate1(pol(waves4(t), p).mean)}`;
  L.push('### What changes for WAVES', '');
  L.push('**For players**', '');
  L.push(`- Average random-lock payout (V3 to V4: weak ${hold('uniform-terminal', 'weak')}, medium ${hold('uniform-terminal', 'medium')}, strong ${hold('uniform-terminal', 'strong')}).`);
  L.push(`- Held-flat share (1 s or more) ${wPlat} (weak / medium / strong). The best moment on the path (${wHs}).`);
  L.push(`- Rides that run to the end without crashing: ${pct1(waves3('weak').distribution.noCrash)} to ${pct1(waves4('weak').distribution.noCrash)}.`);
  L.push('', '**For the house**', '');
  L.push(`- Average cost of a random lock changes by ${TICKETS.map((t) => `${t} ${ppDelta(pol(waves3(t), 'uniform-terminal').mean, pol(waves4(t), 'uniform-terminal').mean)}`).join(', ')}.`);
  L.push(`- Locking uniformly over the whole planned ride (so late locks after a crash pay zero): ${TICKETS.map((t) => `${t} ${hold('uniform-duration', t)}`).join(', ')}; share paying zero ${TICKETS.map((t) => `${share1(pol(waves3(t), 'uniform-duration').zeroShare)} to ${share1(pol(waves4(t), 'uniform-duration').zeroShare)}`).join(' / ')}.`);
  L.push(`- Giveaway: how much the curve reveals about the crash (gap ${TICKETS.map((t) => `${waves3(t).distribution.f8.gapPp === null ? 'n/a' : pp(waves3(t).distribution.f8.gapPp as number)} to ${waves4(t).distribution.f8.gapPp === null ? 'n/a' : pp(waves4(t).distribution.f8.gapPp as number)}`).join(' / ')}).`);
  L.push('');

  // LINEAR
  const linCols: Col[] = [v3Col, ...PACES.map((p): Col => ({ name: `V4 ${p}`, get: (l) => byLabel(v4[p], l) }))];
  L.push('## LINEAR (the straight climb)', '');
  L.push('V4 LINEAR climbs on a fixed clock: the climb speed is the same for every ride of a ticket, and it stops at that ride\'s own cap. Until it stops, the quote does not depend on the ride\'s cap or on when the crash happens. The pace option sets the time T the climb would need to reach the top of the ticket\'s payout band (6 / 9 / 12 s); each ride\'s cap is lower than that top, so rides stop earlier (measured below). Crash and no-crash outcomes are the same for all three paces.', '');
  L.push(...outcomeBlock('LINEAR'));
  L.push(...shapeTable('LINEAR', linCols));
  L.push(...payoutBlock('LINEAR', linCols));

  L.push('### LINEAR: comparing the three paces', '');
  L.push('Time to cap is measured per ride from the climb itself (median and 90th percentile over all rides, whether or not they crash); T is the pace\'s time to the top of the payout band. ' +
    'V3: the cap is reached exactly when the ride crashes or ends, never earlier. ' +
    '"Ride still running at its cap" is the share of rides that live long enough to reach their cap; "reaches 90% of cap" is the share where a reach-90% player gets paid.', '');
  const paceRows: string[][] = [];
  for (const t of TICKETS) {
    const r3 = lin3(t);
    paceRows.push([t, 'V3 today', 'when the ride ends or crashes', '100.0%', rate1(r3.effectiveMax.mean), rate1(pol(r3, 'uniform-terminal').mean), rate1(pol(r3, 'hindsight').mean), share1(1 - pol(r3, 'reach-90').zeroShare), share1(pol(r3, 'uniform-duration').zeroShare)]);
    for (const p of PACES) {
      const r = lin4(p, t);
      paceRows.push([t, `V4 ${p}`, `median ${capTimes[p][t].median.toFixed(1)} s, P90 ${capTimes[p][t].p90.toFixed(1)} s (T = ${PACE_SECONDS[p]} s)`, share1(capTimes[p][t].reachedShare), rate1(r.effectiveMax.mean), rate1(pol(r, 'uniform-terminal').mean), rate1(pol(r, 'hindsight').mean), share1(1 - pol(r, 'reach-90').zeroShare), share1(pol(r, 'uniform-duration').zeroShare)]);
    }
  }
  L.push(...table(['ticket', 'engine', 'time to reach the ride\'s cap', 'ride still running at its cap', 'mean cap', 'random lock, mean', 'hindsight, mean', 'reaches 90% of cap', 'random over whole ride: pays zero'], paceRows));

  L.push('### What changes for LINEAR', '');
  L.push('**For players**', '');
  L.push(`- The climb speed is the same for every ride of a ticket: it does not stretch to meet the crash, and before it stops the quote does not reveal the ride\'s cap. It stops at that ride\'s cap, which takes ${PACES.map((p) => `${p} ${[...new Set(TICKETS.map((t) => `${capTimes[p][t].median.toFixed(1)} s`))].join(' / ')}`).join('; ')} (median; weak / medium / strong when they differ).`);
  for (const p of PACES) {
    L.push(`- ${p}: average random-lock payout ${TICKETS.map((t) => `${t} ${rate1(pol(lin3(t), 'uniform-terminal').mean)} to ${rate1(pol(lin4(p, t), 'uniform-terminal').mean)}`).join(', ')}; ${TICKETS.map((t) => `${t} ${share1(1 - pol(lin4(p, t), 'reach-90').zeroShare)}`).join(', ')} of rides reach 90% of the cap (V3: ${TICKETS.map((t) => `${t} ${share1(1 - pol(lin3(t), 'reach-90').zeroShare)}`).join(', ')}).`);
  }
  L.push('', '**For the house**', '');
  for (const p of PACES) {
    L.push(`- ${p}: best-moment payout ${TICKETS.map((t) => `${t} ${rate1(pol(lin3(t), 'hindsight').mean)} to ${rate1(pol(lin4(p, t), 'hindsight').mean)}`).join(', ')}; random lock changes ${TICKETS.map((t) => `${t} ${ppDelta(pol(lin3(t), 'uniform-terminal').mean, pol(lin4(p, t), 'uniform-terminal').mean)}`).join(', ')}.`);
  }
  L.push('- The cap itself differs (mean cap V3 to V4, weak / medium / strong): ' + TICKETS.map((t) => `${rate1(lin3(t).effectiveMax.mean)} to ${rate1(lin4('MEDIUM', t).effectiveMax.mean)}`).join(' / ') + '. V4\'s cap is the same-seed WAVES ride maximum.');
  L.push('');

  L.push('## Where to look next', '');
  L.push(`- Full V3 report: \`${links.v3.replace('gallery.html', 'report.md')}\`; V4: ${PACES.map((p) => `\`${links.v4[p].replace('gallery.html', 'report.md')}\``).join(', ')}.`);
  L.push('- Measure definitions (observed phase, peaks, plateau, horn, giveaway) are in each report.md.');
  L.push('');
  return L.join('\n');
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const v4Dir = resolve(args['v4-dir'] ?? 'docs/ai/audits/2026-10-30-v4-evidence');
  const v3Path = resolve(args.v3 ?? 'docs/ai/audits/2026-10-29-v3-baseline/results.json');
  const out = resolve(args.out ?? join(v4Dir, 'comparison.md'));
  const v3 = load(v3Path);
  const v4 = {} as Record<Pace, ResultsFile>;
  const v4Links = {} as Record<Pace, string>;
  for (const p of PACES) {
    const dir = join(v4Dir, `v4-${p.toLowerCase()}`);
    v4[p] = load(join(dir, 'results.json'));
    if (v4[p].linearPace !== p) throw new Error(`${dir} was not run with --linear-pace ${p.toLowerCase()}`);
    v4Links[p] = relative(dirname(out), join(dir, 'gallery.html'));
  }
  const links = { v3: relative(dirname(out), join(dirname(v3Path), 'gallery.html')), v4: v4Links };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderComparison({ v3, v4, links, capTimes: computeCapTimes(v3.n, v3.seedBase) }));
  console.log(`wrote ${out}`);
}

if (require.main === module) main();
