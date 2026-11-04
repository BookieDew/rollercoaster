/* Ride stage for the player betslip: an original "neon comet" canvas plus optional synthesized sound.
 * Display only. Every value drawn here comes from observed server samples ({seconds, boost, gapBefore}); the head
 * can lag behind the latest sample but never runs past it, nothing is predicted or extrapolated, and the ride
 * maximum, the future path and the crash timing are never an input. Pure helpers are exported for node:test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RideStage = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - (1 - clamp(t, 0, 1)) ** 3;
  const TAU = Math.PI * 2;

  // ---------- colours ----------
  /** "#rgb", "#rrggbb" or "rgb()/rgba()" text to [r, g, b] (0-255), else null. */
  function parseColor(text) {
    if (typeof text !== 'string') return null;
    const value = text.trim().toLowerCase();
    let match = /^#([0-9a-f]{3})$/.exec(value);
    if (match) return [...match[1]].map((digit) => parseInt(digit + digit, 16));
    match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(value);
    if (match) return [0, 2, 4].map((index) => parseInt(match[1].slice(index, index + 2), 16));
    match = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(value);
    if (match) return [1, 2, 3].map((index) => clamp(Math.round(Number(match[index])), 0, 255));
    return null;
  }
  const mixColor = (a, b, t) => [0, 1, 2].map((index) => Math.round(lerp(a[index], b[index], clamp(t, 0, 1))));
  const rgba = (color, alpha) => `rgba(${color[0]},${color[1]},${color[2]},${clamp(alpha, 0, 1).toFixed(3)})`;

  // ---------- pure helpers ----------
  /**
   * 0..1 from the absolute observed boost along a smooth saturating curve (1 - exp(-boost / scale)). It is not
   * normalised to any maximum, so the look never reveals one: there is no visible end stop, only ever-slower growth.
   */
  function intensity(boost, scale = 0.25) {
    if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 0) return 0;
    return clamp(1 - Math.exp(-boost / scale), 0, 1);
  }
  /** Look of the comet for an intensity: glow radius (css px), core radius, particles per second, pulse depth/speed. */
  function intensityStyle(level) {
    const i = clamp(Number.isFinite(level) ? level : 0, 0, 1);
    return { glow: 26 + 58 * i, core: 3.5 + 3.5 * i, particleRate: 12 + 78 * i, pulse: 0.03 + 0.1 * i, pulseHz: 0.9 + 1.1 * i, white: i * i * 0.75, warm: clamp(i * 1.6, 0, 1) };
  }
  /** Same idea as the slip's mini line: observed values plus 10% margin, at least minSpan wide, floored at 0. */
  function fitDomain(values, { minSpan = 0.01 } = {}) {
    const finite = (values || []).filter((value) => Number.isFinite(value));
    if (!finite.length) return { min: 0, max: minSpan };
    const lo = Math.min(...finite), hi = Math.max(...finite);
    const margin = (hi - lo) * 0.1;
    let min = lo - margin, max = hi + margin;
    if (max - min < minSpan) {
      const mid = (lo + hi) / 2;
      min = mid - minSpan / 2; max = mid + minSpan / 2;
    }
    if (min < 0) { max -= min; min = 0; }
    return { min, max };
  }
  /** Exponential approach of the drawn domain to the fitted one (cosmetic scale only, no value is invented). */
  function smoothDomain(current, target, dt, tau = 0.35) {
    if (!current) return { ...target };
    const k = 1 - Math.exp(-Math.max(0, dt) / tau);
    return { min: lerp(current.min, target.min, k), max: lerp(current.max, target.max, k) };
  }
  /** Widens a (smoothed) domain just enough to hold every observed value, so the comet never leaves its lane. */
  function containDomain(domain, values) {
    const finite = (values || []).filter((value) => Number.isFinite(value));
    if (!finite.length) return domain;
    return { min: Math.min(domain.min, ...finite), max: Math.max(domain.max, ...finite) };
  }
  /**
   * Eases a shown value toward the latest observed one and never passes it: the result lies between the shown
   * value and the latest value, so a rise cannot overshoot and a fall cannot undershoot.
   */
  function easeToward(shown, latest, dt, tau = 0.18) {
    if (!Number.isFinite(latest)) return Number.isFinite(shown) ? shown : 0;
    if (!Number.isFinite(shown)) return latest;
    const next = lerp(shown, latest, 1 - Math.exp(-Math.max(0, dt) / tau));
    return latest >= shown ? Math.min(latest, Math.max(shown, next)) : Math.max(latest, Math.min(shown, next));
  }
  /** Interpolation between observed samples at time t (inside a gap the earlier observation is held). */
  function valueAt(samples, t) {
    if (!samples.length) return 0;
    if (t <= samples[0].seconds) return samples[0].boost;
    for (let i = 1; i < samples.length; i += 1) {
      const next = samples[i];
      if (t > next.seconds) continue;
      const prev = samples[i - 1];
      if (next.gapBefore && t < next.seconds) return prev.boost;
      const span = next.seconds - prev.seconds;
      return span > 0 ? lerp(prev.boost, next.boost, (t - prev.seconds) / span) : next.boost;
    }
    return samples.at(-1).boost;
  }
  /**
   * Moves the head's time cursor forward at real speed (faster when it lags), trailing the latest observed sample
   * by a small buffer so the motion stays continuous between polls. Never returns a time past the latest sample,
   * never moves backwards, and jumps over a gap instead of drawing through it.
   */
  function advanceView(samples, view, dt, { buffer = 0.3, catchUp = 4 } = {}) {
    if (!samples.length) return 0;
    const first = samples[0].seconds, latest = samples.at(-1).seconds;
    if (!Number.isFinite(view)) return first;
    const current = clamp(view, first, latest);
    const target = Math.max(first, latest - buffer);
    if (current >= target) return current;
    let next = Math.min(target, current + Math.max(0, dt) * (1 + catchUp * (target - current)));
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i].gapBefore && next > samples[i - 1].seconds && next < samples[i].seconds) { next = samples[i].seconds; break; }
    }
    return Math.min(next, latest);
  }
  /** Soft rising tone: 196 Hz at no boost about 900 Hz at the strongest look. */
  function toneFrequency(level) {
    return Math.round(196 * 2 ** (2.2 * clamp(Number.isFinite(level) ? level : 0, 0, 1)));
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- sound (WebAudio only, no files; muted by default, nothing plays before a user tap) ----------
  const SOUND_KEY = 'demoRideSound';
  function createSound({ storage, AudioContextClass } = {}) {
    const store = (() => { try { return storage || globalThis.localStorage || null; } catch (error) { return null; } })();
    const contextClass = () => AudioContextClass || (typeof globalThis !== 'undefined' ? (globalThis.AudioContext || globalThis.webkitAudioContext) : null);
    let enabled = false;
    try { enabled = !!store && store.getItem(SOUND_KEY) === '1'; } catch (error) { enabled = false; }
    let gestured = false, ctx = null, master = null, tone = null, riding = false, level = 0;

    function ensure() {
      const Ctx = contextClass();
      if (!enabled || !gestured || !Ctx) return null;
      try {
        if (!ctx) {
          ctx = new Ctx();
          master = ctx.createGain();
          master.gain.value = 0.9;
          master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch (error) { return null; }
    }
    function stopTone() {
      if (!tone || !ctx) { tone = null; return; }
      try {
        const now = ctx.currentTime;
        tone.gain.gain.cancelScheduledValues(now);
        tone.gain.gain.setTargetAtTime(0, now, 0.05);
        tone.oscillators.forEach((osc) => osc.stop(now + 0.4));
      } catch (error) { /* audio is optional */ }
      tone = null;
    }
    function startTone() {
      const audio = ensure();
      if (!audio || tone) return;
      try {
        const gain = audio.createGain();
        gain.gain.value = 0;
        const filter = audio.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1900;
        const main = audio.createOscillator(), shimmer = audio.createOscillator();
        main.type = 'sine'; shimmer.type = 'triangle';
        const shimmerGain = audio.createGain();
        shimmerGain.gain.value = 0.35;
        main.connect(gain); shimmer.connect(shimmerGain); shimmerGain.connect(gain);
        gain.connect(filter); filter.connect(master);
        main.frequency.value = toneFrequency(level);
        shimmer.frequency.value = toneFrequency(level) * 2;
        main.start(); shimmer.start();
        gain.gain.setTargetAtTime(0.045, audio.currentTime, 0.2);
        tone = { gain, oscillators: [main, shimmer] };
      } catch (error) { tone = null; }
    }
    function note(audio, freq, at, length, peak) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      osc.connect(gain); gain.connect(master);
      osc.start(at); osc.stop(at + length + 0.05);
    }
    return {
      isEnabled: () => enabled,
      /** Remember that the user has tapped something; audio may start from now on. */
      unlock() { gestured = true; if (enabled && riding) startTone(); },
      setEnabled(value) {
        enabled = !!value;
        try { if (store) store.setItem(SOUND_KEY, enabled ? '1' : '0'); } catch (error) { /* private mode */ }
        if (!enabled) stopTone();
        else if (riding) startTone();
        return enabled;
      },
      toggle() { return this.setEnabled(!enabled); },
      startRide() { riding = true; startTone(); },
      setLevel(value) {
        level = clamp(Number.isFinite(value) ? value : 0, 0, 1);
        if (!tone || !ctx) return;
        try {
          const now = ctx.currentTime;
          tone.oscillators[0].frequency.setTargetAtTime(toneFrequency(level), now, 0.08);
          tone.oscillators[1].frequency.setTargetAtTime(toneFrequency(level) * 2, now, 0.08);
        } catch (error) { /* audio is optional */ }
      },
      stop() { riding = false; stopTone(); },
      lock() {
        riding = false; stopTone();
        const audio = ensure();
        if (!audio) return;
        try { [659.25, 987.77, 1318.51].forEach((freq, index) => note(audio, freq, audio.currentTime + 0.03 + index * 0.09, 1.0 - index * 0.1, 0.16)); } catch (error) { /* optional */ }
      },
      crash() {
        riding = false; stopTone();
        const audio = ensure();
        if (!audio) return;
        try {
          const now = audio.currentTime;
          const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.7), audio.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
          const noise = audio.createBufferSource(), filter = audio.createBiquadFilter(), noiseGain = audio.createGain();
          noise.buffer = buffer;
          filter.type = 'lowpass';
          filter.frequency.setValueAtTime(1600, now);
          filter.frequency.exponentialRampToValueAtTime(110, now + 0.6);
          noiseGain.gain.setValueAtTime(0.28, now);
          noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
          noise.connect(filter); filter.connect(noiseGain); noiseGain.connect(master);
          noise.start(now);
          const drop = audio.createOscillator(), dropGain = audio.createGain();
          drop.type = 'sawtooth';
          drop.frequency.setValueAtTime(260, now);
          drop.frequency.exponentialRampToValueAtTime(48, now + 0.55);
          dropGain.gain.setValueAtTime(0.09, now);
          dropGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
          drop.connect(dropGain); dropGain.connect(master);
          drop.start(now); drop.stop(now + 0.6);
        } catch (error) { /* optional */ }
      },
    };
  }

  // ---------- canvas comet ----------
  const WINDOW_SECONDS = 7;      // width of the visible time window
  const HEAD_X = 0.68;           // the head sits near the right third
  const DEFAULT_COLORS = { accent: '#1cae66', cool: '#31c6d8', bgTop: '#06121c', bgBottom: '#020609', hot: '#ff4d5a', amber: '#ffb347', star: '#d6ecff' };

  /**
   * deps: { canvas, getData() -> {samples, outcome}, getColors() -> css colour strings,
   *         getBand() -> {top, bottom} in css px (where the comet may travel), reduced() -> boolean, onTick(info) }
   * The loop only runs between start() and stop(); with reduced motion nothing animates, redraw() paints one still frame.
   */
  function createStage(deps) {
    const canvas = deps.canvas;
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    const raf = (fn) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : setTimeout(() => fn(Date.now()), 16));
    const caf = (id) => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id));
    const stars = (() => {
      const random = mulberry32(20261104);
      return [[44, 0.35, 0.06], [30, 0.6, 0.12], [16, 0.95, 0.24]].map(([count, size, parallax]) => ({
        parallax, size, items: Array.from({ length: count }, () => ({ x: random(), y: random(), r: size * (0.6 + random() * 0.8), phase: random() * TAU })),
      }));
    })();
    let width = 0, height = 0, dpr = 1, running = false, frameId = null, last = null, clock = 0;
    let view = null, domain = null, shownIntensity = 0, particles = [], emit = 0;
    let outcome = null, colors = null;

    function readColors() {
      const raw = (deps.getColors && deps.getColors()) || {};
      const out = {};
      for (const key of Object.keys(DEFAULT_COLORS)) out[key] = parseColor(raw[key]) || parseColor(DEFAULT_COLORS[key]);
      colors = out;
    }
    function resize() {
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      dpr = clamp(globalThis.devicePixelRatio || 1, 1, 2.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
    }
    function band() {
      const given = deps.getBand && deps.getBand();
      if (given && Number.isFinite(given.top) && Number.isFinite(given.bottom) && given.bottom - given.top > 30) return given;
      return { top: height * 0.3, bottom: height * 0.62 };
    }

    function sparksFor(seed, count) {
      const random = mulberry32(seed);
      return Array.from({ length: count }, (_, index) => ({ angle: (index / count) * TAU + (random() - 0.5) * 0.25, speed: 90 + random() * 190, size: 1.2 + random() * 2.2, mix: random(), spin: (random() - 0.5) * 14, len: 4 + random() * 8 }));
    }
    function setOutcome(kind) {
      if (kind !== 'locked' && kind !== 'crashed') { outcome = null; return; }
      if (outcome && outcome.kind === kind) return;
      outcome = { kind, t0: clock, sparks: sparksFor(kind === 'locked' ? 7 : 11, kind === 'locked' ? 44 : 26) };
      particles = [];
    }
    function reset() {
      view = null; domain = null; shownIntensity = 0; particles = []; emit = 0; outcome = null; clock = 0; last = null;
    }

    function drawBackground(style, headY, pulse) {
      const g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, rgba(colors.bgTop, 1));
      g.addColorStop(1, rgba(colors.bgBottom, 1));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      const neb = ctx.createRadialGradient(width * HEAD_X, headY, 0, width * HEAD_X, headY, Math.max(width, height) * 0.75);
      neb.addColorStop(0, rgba(colors.accent, 0.1 + 0.16 * style.white + 0.06 * pulse));
      neb.addColorStop(0.5, rgba(colors.cool, 0.04));
      neb.addColorStop(1, rgba(colors.accent, 0));
      ctx.fillStyle = neb;
      ctx.fillRect(0, 0, width, height);
    }
    function drawStars(pps, animated) {
      stars.forEach((layer) => {
        layer.items.forEach((star) => {
          const shift = ((view || 0) * pps * layer.parallax);
          const x = (((star.x * width - shift) % width) + width) % width;
          const twinkle = animated ? 0.65 + 0.35 * Math.sin(clock * 2.1 + star.phase) : 0.85;
          ctx.fillStyle = rgba(colors.star, (0.42 + layer.parallax * 1.8) * twinkle);
          ctx.beginPath();
          ctx.arc(x, star.y * height, star.r, 0, TAU);
          ctx.fill();
        });
      });
    }
    function drawVignette(style, pulse) {
      const v = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.45, width / 2, height / 2, Math.max(width, height) * 0.8);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, `rgba(0,0,0,${(0.55 - 0.18 * pulse).toFixed(3)})`);
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, width, height);
      if (pulse > 0) {
        const edge = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.4, width / 2, height / 2, Math.max(width, height) * 0.75);
        edge.addColorStop(0, rgba(colors.accent, 0));
        edge.addColorStop(1, rgba(colors.accent, 0.1 * pulse * (0.3 + style.white)));
        ctx.fillStyle = edge;
        ctx.fillRect(0, 0, width, height);
      }
    }

    function draw(dt, animated) {
      if (!ctx) return;
      if (!colors) readColors();
      const data = (deps.getData && deps.getData()) || {};
      const samples = Array.isArray(data.samples) ? data.samples : [];
      const latest = samples.at(-1) || null;
      if (outcome && latest) view = latest.seconds;
      else if (!animated && latest) view = latest.seconds;
      else view = advanceView(samples, view, dt);
      const headBoost = latest ? valueAt(samples, view) : 0;
      const target = intensity(headBoost);
      shownIntensity = animated ? easeToward(shownIntensity, target, dt, 0.25) : target;
      const style = intensityStyle(shownIntensity);
      const lane = band();
      const headX = width * HEAD_X;
      const pps = (headX - 12) / WINDOW_SECONDS;

      // Fit the scale to what is on screen; the target never contains anything but observed values.
      const visible = samples.filter((sample) => sample.seconds >= view - WINDOW_SECONDS - 1 && sample.seconds <= view).map((sample) => sample.boost);
      const priorIndex = samples.findIndex((sample) => sample.seconds > view - WINDOW_SECONDS);
      if (priorIndex > 0) visible.push(samples[priorIndex - 1].boost);
      visible.push(headBoost);
      const targetDomain = fitDomain(visible, { minSpan: 0.02 });
      domain = containDomain(animated ? smoothDomain(domain, targetDomain, dt) : targetDomain, visible);
      const span = Math.max(1e-9, domain.max - domain.min);
      const yOf = (boost) => lane.bottom - ((boost - domain.min) / span) * (lane.bottom - lane.top);
      const xOf = (seconds) => headX - (view - seconds) * pps;
      const headY = yOf(headBoost);

      const pulse = animated ? (outcome ? 0 : 0.5 + 0.5 * Math.sin(clock * TAU * style.pulseHz)) : 0.35;
      const te = outcome ? (animated ? clock - outcome.t0 : (outcome.kind === 'locked' ? 0.75 : 0.9)) : 0;
      const crashed = outcome && outcome.kind === 'crashed';
      const locked = outcome && outcome.kind === 'locked';

      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, width, height);
      drawBackground(style, headY, pulse);
      drawStars(pps, animated);

      // Trail: observed samples left of the head, fading with age; gaps stay broken.
      const hot = colors.hot;
      const base = mixColor(mixColor(colors.cool, colors.accent, style.warm), [255, 255, 255], style.white);
      const trailColor = crashed ? mixColor(base, hot, clamp(te * 1.4, 0, 1)) : base;
      const fade = crashed ? Math.max(0.18, 1 - te * 0.7) : 1;
      const points = [];
      samples.forEach((sample) => { if (sample.seconds <= view) points.push({ t: sample.seconds, x: xOf(sample.seconds), y: yOf(sample.boost), gap: !!sample.gapBefore }); });
      if (latest && (!points.length || points.at(-1).t < view)) points.push({ t: view, x: headX, y: headY, gap: false });
      const headWidth = 5 + 5 * shownIntensity;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const passes = [{ widthScale: 3.2, alpha: 0.16 }, { widthScale: 1.5, alpha: 0.42 }, { widthScale: 0.55, alpha: 0.95 }];
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1], b = points[i];
        if (b.gap || b.x < -20) continue;
        const age = clamp((view - (a.t + b.t) / 2) / WINDOW_SECONDS, 0, 1);
        const body = (1 - age) ** 1.5 * fade;
        if (body < 0.01) continue;
        const thick = lerp(headWidth, 1, age ** 0.6);
        passes.forEach((pass) => {
          ctx.strokeStyle = rgba(mixColor(trailColor, [255, 255, 255], pass.widthScale < 1 ? 0.55 : 0), pass.alpha * body);
          ctx.lineWidth = Math.max(0.6, thick * pass.widthScale);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        });
      }
      // A single observation is a dot, never a slope; gaps leave an isolated glint where the line resumes.
      points.forEach((point, index) => {
        if (index > 0 && !point.gap) return;
        if (point.x < 0 || point.x > width) return;
        ctx.fillStyle = rgba(trailColor, 0.5 * fade);
        ctx.beginPath(); ctx.arc(point.x, point.y, 2.2, 0, TAU); ctx.fill();
      });

      // Particles shed by the head (animated mode only), scaled by intensity.
      if (animated && !outcome && latest) {
        emit += style.particleRate * dt;
        while (emit >= 1 && particles.length < 220) {
          emit -= 1;
          const life = 0.5 + Math.random() * 0.7;
          particles.push({ x: headX - 2, y: headY + (Math.random() - 0.5) * 6, vx: -pps * (0.7 + Math.random() * 0.6), vy: (Math.random() - 0.5) * 38, life, max: life, size: 0.8 + Math.random() * 1.9 * (0.6 + shownIntensity), mix: Math.random() });
        }
        emit = Math.min(emit, 3);
      }
      particles = particles.filter((p) => p.life > 0);
      particles.forEach((p) => {
        if (animated) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
        const alpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = rgba(mixColor(trailColor, [255, 255, 255], p.mix * 0.6), alpha * 0.85 * fade);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
      });

      // Head.
      if (latest || outcome) {
        let scale = 1;
        if (crashed) scale = animated ? Math.max(0, 1 - te / 0.5) * (Math.sin(te * 70) > -0.3 ? 1 : 0.35) : 0.12;
        const glow = style.glow * (1 + (animated ? style.pulse * Math.sin(clock * TAU * style.pulseHz) : 0)) * scale;
        const headColor = crashed ? mixColor(base, hot, clamp(te * 2, 0, 1)) : base;
        if (glow > 1) {
          const halo = ctx.createRadialGradient(headX, headY, 0, headX, headY, glow);
          halo.addColorStop(0, rgba(mixColor(headColor, [255, 255, 255], 0.5), 0.85));
          halo.addColorStop(0.25, rgba(headColor, 0.5));
          halo.addColorStop(1, rgba(headColor, 0));
          ctx.fillStyle = halo;
          ctx.beginPath(); ctx.arc(headX, headY, glow, 0, TAU); ctx.fill();
          // A slim four-ray flare gives the head its own silhouette.
          const spin = animated ? clock * 0.5 : 0.4;
          ctx.strokeStyle = rgba(mixColor(headColor, [255, 255, 255], 0.7), 0.5 * scale);
          ctx.lineWidth = 1.2;
          for (let ray = 0; ray < 4; ray += 1) {
            const angle = spin + (ray * Math.PI) / 2;
            const reach = glow * (ray % 2 ? 0.7 : 1);
            ctx.beginPath();
            ctx.moveTo(headX - Math.cos(angle) * reach, headY - Math.sin(angle) * reach);
            ctx.lineTo(headX + Math.cos(angle) * reach, headY + Math.sin(angle) * reach);
            ctx.stroke();
          }
        }
        const core = style.core * Math.max(scale, crashed ? 0.25 : 1);
        ctx.fillStyle = rgba(crashed ? mixColor([255, 255, 255], hot, 0.6) : [255, 255, 255], 0.98);
        ctx.beginPath(); ctx.arc(headX, headY, core, 0, TAU); ctx.fill();
      }

      // Lock: flash, two rings and a spray of sparks. Crash: shards. Both are pure functions of time since the outcome.
      if (locked) {
        const bright = mixColor(colors.accent, [255, 255, 255], 0.6);
        if (te < 0.35) {
          const flash = ctx.createRadialGradient(headX, headY, 0, headX, headY, 40 + 200 * (te / 0.35));
          flash.addColorStop(0, rgba([255, 255, 255], 0.9 * (1 - te / 0.35)));
          flash.addColorStop(1, rgba(bright, 0));
          ctx.fillStyle = flash;
          ctx.beginPath(); ctx.arc(headX, headY, 240, 0, TAU); ctx.fill();
        }
        for (let ring = 0; ring < 2; ring += 1) {
          const local = te - ring * 0.14;
          if (local <= 0 || local >= 1.2) continue;
          const p = local / 1.2;
          ctx.strokeStyle = rgba(ring ? bright : [255, 255, 255], (1 - p) * 0.95);
          ctx.lineWidth = 1 + 6 * (1 - p);
          ctx.beginPath(); ctx.arc(headX, headY, 10 + 170 * easeOut(p), 0, TAU); ctx.stroke();
        }
        outcome.sparks.forEach((spark) => {
          const travel = spark.speed * (1 - Math.exp(-3 * te)) / 3;
          const alpha = (1 - clamp(te / 1.4, 0, 1)) ** 1.5;
          if (alpha <= 0.01) return;
          const x = headX + Math.cos(spark.angle) * travel, y = headY + Math.sin(spark.angle) * travel;
          ctx.strokeStyle = rgba(mixColor(bright, spark.mix > 0.7 ? colors.amber : [255, 255, 255], spark.mix * 0.7), alpha);
          ctx.lineWidth = spark.size;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - Math.cos(spark.angle) * spark.len * alpha, y - Math.sin(spark.angle) * spark.len * alpha);
          ctx.stroke();
        });
      }
      ctx.globalCompositeOperation = 'source-over';
      if (crashed) {
        outcome.sparks.forEach((shard) => {
          const alpha = 1 - clamp(te / 1.6, 0, 1);
          if (alpha <= 0.02) return;
          const x = headX + Math.cos(shard.angle) * shard.speed * 0.8 * te;
          const y = headY + Math.sin(shard.angle) * shard.speed * 0.8 * te + 0.5 * 380 * te * te;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(shard.spin * te + shard.angle);
          ctx.fillStyle = rgba(mixColor(hot, shard.mix > 0.6 ? colors.amber : [120, 130, 140], shard.mix * 0.8), alpha * 0.9);
          const size = 2 + shard.size * 1.6;
          ctx.beginPath(); ctx.moveTo(-size, -size * 0.6); ctx.lineTo(size, 0); ctx.lineTo(-size * 0.4, size); ctx.closePath(); ctx.fill();
          ctx.restore();
        });
      }
      drawVignette(style, animated && !outcome ? pulse : 0);
      if (crashed && animated && te < 0.5) {
        ctx.fillStyle = rgba(hot, 0.38 * (1 - te / 0.5));
        ctx.fillRect(0, 0, width, height);
      }
      if (deps.onTick) deps.onTick({ intensity: shownIntensity, boost: headBoost });
    }

    function frame(timestamp) {
      frameId = null;
      if (!running) return;
      const dt = last === null ? 0.016 : clamp((timestamp - last) / 1000, 0, 0.05);
      last = timestamp;
      clock += dt;
      draw(dt, true);
      frameId = raf(frame);
    }
    function start() {
      resize();
      if (running) return;
      if (deps.reduced && deps.reduced()) { running = false; draw(0, false); return; }
      running = true; last = null;
      frameId = raf(frame);
    }
    function stop() {
      running = false;
      if (frameId !== null) caf(frameId);
      frameId = null;
    }
    /** One still frame for reduced motion (or after a resize); the animated loop paints by itself. */
    function redraw() {
      if (!ctx || running) return;
      if (deps.reduced && deps.reduced()) draw(0, false);
    }
    return { start, stop, resize, redraw, reset, setOutcome, isRunning: () => running };
  }

  return {
    parseColor, mixColor, intensity, intensityStyle, fitDomain, smoothDomain, containDomain, easeToward, valueAt, advanceView,
    toneFrequency, mulberry32, createSound, createStage, SOUND_KEY, WINDOW_SECONDS,
  };
});
