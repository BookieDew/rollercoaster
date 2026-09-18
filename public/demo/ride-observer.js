/* Shared by the demo and focused node:test regressions; never calculates payouts. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RideObserver = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
    accept(payload, token, kind = 'quote') {
      if (!this.matches(token) || this.final) return false;
      if (kind === 'quote' && this.phase !== 'running') return false;
      if (kind === 'lock' && this.phase !== 'locking') return false;
      const data = payload?.details || payload || {};
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
      this.gap = false;
      if (locked || terminal) {
        this.phase = locked ? 'locked' : code === 'RIDE_CRASHED' ? 'crashed' : 'ended';
        this.final = { phase: this.phase, seconds, boost, referenceMax: finite(data.theoretical_max_boost_pct), maximumModel: data.maximum_model || 'LEGACY_CHECKPOINT_MAX_V1' };
        this.revision += 1;
      }
      return true;
    }
  }
  return { ObservedRide, finite };
});
