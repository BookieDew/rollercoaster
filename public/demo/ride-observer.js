/* Shared by the demo and focused node:test regressions; never calculates payouts. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RideObserver = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  function terminalDisplay(data, final) {
    const duration = finite(data.ride_end_at_offset_seconds);
    const crash = finite(data.ride_crash_at_offset_seconds);
    const path = data.ride_path;
    // API event offsets are rounded independently to milliseconds.
    const tolerance = 0.001;
    if (duration === null || duration <= 0 || crash === null || crash < 0 || crash > duration) return null;
    if (!Array.isArray(path) || path.length < 2 || path[0]?.timePct !== 0 || path.at(-1)?.timePct !== 1) return null;
    if (final.phase === 'locked' && final.seconds > Math.min(duration, crash) + tolerance) return null;
    if (final.phase === 'crashed' && final.seconds + tolerance < crash) return null;
    if (final.phase === 'ended' && (Math.abs(crash - duration) > tolerance || final.seconds + tolerance < duration)) return null;
    let previous = -1;
    const points = [];
    for (const point of path) {
      const fraction = finite(point?.timePct), boost = finite(point?.baseBoostValue);
      if (fraction === null || fraction < 0 || fraction > 1 || fraction <= previous || boost === null || boost < 0 || boost > 10) return null;
      const seconds = fraction * duration;
      if (!Number.isFinite(seconds) || (seconds > crash + tolerance && boost !== 0)) return null;
      // The terminal zero is not evidence for an interpolated decline before the event.
      const prior = points.at(-1);
      const gapBefore = !!prior && prior.seconds <= crash + tolerance && seconds >= crash - tolerance && boost === 0;
      points.push(Object.freeze({ seconds, boost, gapBefore }));
      previous = fraction;
    }
    if (points.at(-1).boost !== 0) return null;
    return Object.freeze({ duration, crash, points: Object.freeze(points) });
  }
  class ObservedRide {
    constructor() { this.generation = 0; this.reset(); }
    reset() {
      this.generation += 1;
      this.revision = 0;
      this.identity = null;
      this.phase = 'idle';
      this.samples = [];
      this.final = null;
      this.finalDisplay = null;
      this.lastAcceptedAt = null;
      this.gap = false;
    }
    start(identity) {
      this.reset();
      this.identity = Object.freeze({ ...identity });
      this.phase = 'running';
    }
    token() { return { generation: this.generation, revision: this.revision }; }
    matches(token) { return token.generation === this.generation && token.revision === this.revision; }
    beginLock() {
      if (!['running', 'uncertain'].includes(this.phase)) return null;
      this.revision += 1;
      this.phase = 'locking';
      return this.token();
    }
    lockFailed(token) { if (this.matches(token)) this.phase = 'uncertain'; }
    markGap() { this.gap = true; }
    direction({ paused = false, now = Date.now() } = {}) {
      const last = this.samples.at(-1), previous = this.samples.at(-2);
      if (this.phase !== 'running' || paused || this.gap || !previous || last.gapBefore || this.lastAcceptedAt === null || now - this.lastAcceptedAt > 800) return 'none';
      return last.boost > previous.boost ? 'up' : last.boost < previous.boost ? 'down' : 'flat';
    }
    accept(payload, token, kind = 'quote') {
      if (!this.matches(token) || this.final) return false;
      if (kind === 'quote' && this.phase !== 'running') return false;
      if (kind === 'lock' && this.phase !== 'locking') return false;
      const data = payload?.details || payload || {};
      for (const key of ['reward_id', 'bet_id', 'user_id']) {
        if (data[key] !== undefined && data[key] !== this.identity?.[key]) return false;
      }
      const code = data.reason_code || data.code || payload?.code;
      const locked = kind === 'lock' && typeof data.lock_id === 'string';
      const terminal = code === 'RIDE_CRASHED' || code === 'RIDE_ENDED';
      const seconds = finite(locked ? data.ride_stop_at_offset_seconds : data.ride_elapsed_seconds);
      const boost = finite(locked ? data.locked_boost_pct : data.current_boost_pct);
      if (seconds === null || seconds < 0 || boost === null || boost < 0) return false;
      if (!locked && !terminal && data.eligible !== true) return false;
      if (terminal && boost !== 0) return false;
      const previous = this.samples.at(-1);
      if (previous && (seconds < previous.seconds || (seconds === previous.seconds && !locked && !terminal))) return false;
      this.samples.push({ seconds, boost, gapBefore: !!previous && (this.gap || seconds - previous.seconds > 0.8) });
      this.lastAcceptedAt = Date.now();
      this.gap = false;
      if (locked || terminal) {
        this.phase = locked ? 'locked' : code === 'RIDE_CRASHED' ? 'crashed' : 'ended';
        this.final = Object.freeze({ phase: this.phase, seconds, boost, referenceMax: finite(data.theoretical_max_boost_pct), maximumModel: data.maximum_model || 'LEGACY_CHECKPOINT_MAX_V1' });
        this.finalDisplay = terminalDisplay(data, this.final);
        this.revision += 1;
      }
      return true;
    }
  }
  return { ObservedRide, finite };
});
