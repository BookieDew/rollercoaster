import type { LabConfig, SampledRide } from './adapter';
import { gridValues } from './metrics';

export interface GalleryRide { seed: string; config: LabConfig; ride: SampledRide }

const W = 240, H = 110, PAD = 6;

function svg(g: GalleryRide, axisSeconds: number): string {
  const { ride, config } = g;
  const step = 0.05;
  const v = gridValues(ride.boostAt, ride.terminalAtSeconds, step);
  const top = Math.max(config.profile.maxBoostPct, ride.effectiveMax, ...v) || 1;
  const x = (t: number) => PAD + (t / axisSeconds) * (W - 2 * PAD);
  const y = (val: number) => H - PAD - (val / top) * (H - 2 * PAD);
  const pts = v.map((val, k) => `${x(k * step).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
  const capY = y(ride.effectiveMax).toFixed(1);
  const endX = x(ride.terminalAtSeconds).toFixed(1);
  const crash = ride.outcome === 'CRASHED';
  return `<figure><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ride">
<rect width="${W}" height="${H}" fill="#fff" stroke="#ddd"/>
<line x1="${PAD}" x2="${W - PAD}" y1="${capY}" y2="${capY}" stroke="#bbb" stroke-dasharray="3 3"/>
<polyline fill="none" stroke="#1f6feb" stroke-width="1.6" points="${pts}"/>
<line x1="${endX}" x2="${endX}" y1="${PAD}" y2="${H - PAD}" stroke="${crash ? '#d1242f' : '#2da44e'}" stroke-width="1.5"/>
</svg><figcaption>${config.label} ${ride.durationSeconds.toFixed(1)}s ${crash ? 'crash ' + ride.terminalAtSeconds.toFixed(2) + 's' : 'ended'}${ride.reportedCrashPhase ? ' ' + ride.reportedCrashPhase : ''}<br><small>${g.seed.slice(0, 10)}</small></figcaption></figure>`;
}

export function renderGallery(engine: string, rides: GalleryRide[]): string {
  const modes = [...new Set(rides.map((r) => r.config.mode))];
  const body = modes.map((mode) => `<h2>${mode}</h2><div class="grid">${rides.filter((r) => r.config.mode === mode).map((r) => svg(r, 15)).join('\n')}</div>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ride lab gallery: ${engine}</title>
<style>body{font:14px system-ui,sans-serif;margin:20px;color:#222}.grid{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0}figcaption{font-size:11px;color:#555}</style></head><body>
<h1>Sample rides: engine ${engine}</h1>
<p>Time axis 0 to 15 s; vertical axis 0 to the profile maximum (dashed = this ticket's effective maximum). Blue = payout rate before the end; red line = crash, green line = ride ended without a crash. Rows mix weak, medium and strong tickets.</p>
${body}</body></html>`;
}
