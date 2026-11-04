/* Player bet slip for the demo: pure display helpers plus the slide-out view.
 * Every boost percentage and combined-odds value shown here comes from a server response; this file only
 * turns them into money and odds text. It never predicts or interpolates a boost and never sees a ride maximum.
 * Money is integer minor units (BigInt), half-up, no floats. Helpers are exported for node:test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlayerSlip = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  // ---------- exact decimal helpers (BigInt rationals) ----------
  const pow10 = (n) => 10n ** BigInt(n);

  /** Decimal number or string ("1.5", "1e-7", "123456789012345678901234.5") to {n, d} BigInts; null if not a non-negative decimal. */
  function toRational(value) {
    if (value && typeof value === 'object' && typeof value.n === 'bigint' && typeof value.d === 'bigint') return value;
    let text;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) return null;
      text = String(value);
    } else if (typeof value === 'string') text = value.trim();
    else return null;
    const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) return null;
    const fraction = match[2] || '';
    const exponent = (match[3] ? Number(match[3]) : 0) - fraction.length;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
    const numerator = BigInt(match[1] + fraction);
    return exponent >= 0 ? { n: numerator * pow10(exponent), d: 1n } : { n: numerator, d: pow10(-exponent) };
  }
  const multiply = (a, b) => ({ n: a.n * b.n, d: a.d * b.d });
  /** round(n / d), halves away from zero (inputs are never negative). */
  function roundHalfUp(ratio) { return (2n * ratio.n + ratio.d) / (2n * ratio.d); }
  function twoPlaces(hundredths) {
    return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
  }
  /** Odds text to two decimals, half-up ("9.96"). Null when the value is not a decimal. */
  function formatOdds(value) {
    const ratio = value && typeof value === 'object' && 'n' in value ? value : toRational(value);
    return ratio ? twoPlaces(roundHalfUp({ n: ratio.n * 100n, d: ratio.d })) : null;
  }
  function toMinor(value) {
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }

  const SYMBOLS = { EUR: '€', USD: '$', GBP: '£' };
  function groupThousands(whole) { return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  /** "€103,65"; unknown currencies lead with their code ("CHF 103,65"). */
  function formatMoney(minor, currency) {
    const value = toMinor(minor);
    if (value === null) return '—';
    const code = String(currency || '').toUpperCase();
    const prefix = SYMBOLS[code] ? SYMBOLS[code] : code ? `${code} ` : '';
    return `${prefix}${groupThousands(value / 100n)},${(value % 100n).toString().padStart(2, '0')}`;
  }
  /** Stake as in the bet box: "10 €", "12,50 €". */
  function formatStake(minor, currency) {
    const value = toMinor(minor);
    if (value === null) return '—';
    const code = String(currency || '').toUpperCase();
    const cents = value % 100n;
    return `${groupThousands(value / 100n)}${cents ? `,${cents.toString().padStart(2, '0')}` : ''}${code ? ` ${SYMBOLS[code] || code}` : ''}`;
  }

  /**
   * Potential return for a stake at the server's combined odds and a server boost (a fraction, 0.1 = 10%).
   * gross = stake x odds; bonus = min(stake x odds x boost, max bonus); boosted odds = (gross + bonus) / stake.
   * Gross and bonus are each rounded half-up (whole minor units); boosted odds are rounded half-up, 2 dp.
   */
  function computePotential({ stakeMinor, combinedOdds, boost, capMinor }) {
    const stake = toMinor(stakeMinor);
    const odds = toRational(combinedOdds);
    const rate = toRational(boost === undefined || boost === null ? 0 : boost);
    const cap = capMinor === undefined || capMinor === null ? null : toMinor(capMinor);
    if (stake === null || stake < 1n || !odds || odds.n === 0n || !rate || (capMinor != null && cap === null)) return null;
    const stakeRatio = { n: stake, d: 1n };
    const gross = roundHalfUp(multiply(stakeRatio, odds));
    const uncapped = roundHalfUp(multiply(multiply(stakeRatio, odds), rate));
    const capped = cap !== null && uncapped > cap;
    const bonus = capped ? cap : uncapped;
    const total = gross + bonus;
    return {
      grossMinor: gross,
      bonusMinor: bonus,
      totalMinor: total,
      capped,
      baseOdds: formatOdds(odds),
      boostedOdds: twoPlaces(roundHalfUp({ n: total * 100n, d: stake })),
    };
  }

  // ---------- mock fixtures derived from the setup rows ----------
  const FIXTURES = [
    ['Northgate FC', 'Riverside Rovers'], ['Harbor City', 'Alder Athletic'], ['Summit United', 'Coastline SC'],
    ['Kestrel Town', 'Marlow Wanderers'], ['Ironbridge FC', 'Lakeside Albion'], ['Granite Park', 'Eastfield Dynamo'],
    ['Westmoor Rangers', 'Bayview Celtic'], ['Silverlake FC', 'Oakridge Town'], ['Falcon Heights', 'Redcliff Athletic'],
    ['Stonebrook United', 'Meadow Vale'], ['Crown Valley', 'Thornbury Rovers'], ['Pinecrest SC', 'Foxhill Wanderers'],
  ];
  /** Same position always yields the same match and pick. */
  function fixtureFor(position) {
    const index = Math.max(0, position - 1);
    const pair = FIXTURES[index % FIXTURES.length];
    const flipped = Math.floor(index / FIXTURES.length) % 2 === 1;
    const home = flipped ? pair[1] : pair[0];
    const away = flipped ? pair[0] : pair[1];
    return { home, away, pick: position % 3 === 0 ? away : home };
  }

  /** Setup rows ({odds, type, legOdds, ...}) to one slip leg per priced row; SGP composites stay one leg. */
  function legsFromRows(rows, { minSelectionOdds = 0 } = {}) {
    const legs = [];
    (rows || []).forEach((row, index) => {
      const oddsNumber = Number(row.odds);
      if (row.odds === '' || !Number.isFinite(oddsNumber) || oddsNumber <= 0) return;
      const rational = toRational(String(oddsNumber));
      if (!rational) return;
      const type = row.type || 'STANDARD';
      const fixture = fixtureFor(index + 1);
      const kind = type === 'SGP_COMPOSITE' ? 'sgp' : type === 'EXCLUDED' ? 'excluded' : 'standard';
      const belowMinimum = Number.isFinite(minSelectionOdds) && oddsNumber < minSelectionOdds;
      const legCount = kind === 'sgp' ? (row.legOdds || []).filter((value) => Number(value) > 0).length : 0;
      legs.push({
        position: index + 1,
        home: fixture.home,
        away: fixture.away,
        pick: fixture.pick,
        kind,
        legCount,
        odds: formatOdds(rational),
        rational,
        counted: kind !== 'excluded' && !belowMinimum,
      });
    });
    return legs;
  }
  /** Product of the counted legs' odds (preview only; replaced by the server's combined odds once known). */
  function productOdds(legs) {
    const counted = legs.filter((leg) => leg.counted);
    if (!counted.length) return null;
    return counted.reduce((product, leg) => multiply(product, leg.rational), { n: 1n, d: 1n });
  }
  function percentText(fraction, digits = 2) {
    return `${+(Number(fraction) * 100).toFixed(digits)}%`;
  }

  // Y-domain of the live mini line from observed boosts only: [min, max] plus a 10% margin,
  // at least 1 percentage point (0.01) wide, never below 0. No prediction or extrapolation.
  function sparkDomain(boosts) {
    const values = boosts.filter((value) => Number.isFinite(value));
    if (!values.length) return { min: 0, max: 0.01 };
    const lo = Math.min(...values), hi = Math.max(...values);
    const margin = Math.max(hi - lo, 0) * 0.1;
    let min = lo - margin, max = hi + margin;
    if (max - min < 0.01) {
      const mid = (lo + hi) / 2;
      min = mid - 0.005; max = mid + 0.005;
    }
    if (min < 0) { max -= min; min = 0; }
    return { min, max };
  }

  // ---------- open boosts: readable reasons, match timing, player groups (pure) ----------
  const REASON_LABELS = {
    NO_OPEN_PROFILE: 'No open boost applies to this player right now.',
    PROFILE_NOT_OPEN: 'This profile is personal, not open to all players.',
    PROFILE_SEGMENT_MISMATCH: 'This profile is for a different player group.',
    PROFILE_IS_OPEN: 'Open profiles are not granted in advance; the player uses them on a placed bet.',
    SELECTION_ALREADY_STARTED: 'A match on this slip has already kicked off.',
    SELECTION_ALREADY_SETTLED: 'A match on this slip is already settled.',
    SELECTION_TIMING_REQUIRED: 'Every selection needs a kick-off time or a live flag.',
    NOT_ISSUED_OPEN_BOOST: 'No replacement token: a cancelled open-boost bet returns none.',
    MIN_SELECTIONS_NOT_MET: 'Not enough qualifying selections.',
    MIN_COMBINED_ODDS_NOT_MET: 'The combined odds are too low.',
    CURRENCY_NOT_SUPPORTED: 'This profile has no cap for the chosen currency.',
  };
  /** Readable text for a reason code; null for codes this demo has no label for (callers keep the raw text). */
  function reasonLabel(code) { return Object.prototype.hasOwnProperty.call(REASON_LABELS, code) ? REASON_LABELS[code] : null; }

  const TIMING_MODES = ['prematch', 'live', 'passed'];
  /** Slip timing fields for every selection: prematch = kick-off in 2 h, passed = 5 min ago, live = live flag. */
  function timingFields(mode, nowMs) {
    if (mode === 'live') return { live: true };
    const offset = mode === 'passed' ? -5 * 60 * 1000 : 2 * 60 * 60 * 1000;
    return { starts_at: new Date(nowMs + offset).toISOString() };
  }

  const GROUP_PATTERN = /^[A-Za-z0-9 _.:-]{1,64}$/;
  /** "VIP, high roller" to ["VIP", "high roller"]: trimmed, deduplicated, empty entries dropped. Throws on a bad label. */
  function parseGroups(text) {
    const groups = [];
    for (const part of String(text || '').split(',')) {
      const group = part.trim();
      if (!group) continue;
      if (!GROUP_PATTERN.test(group)) throw new Error('Player groups: 1-64 characters each (letters, digits, space and _ . : -), separated by commas.');
      if (!groups.includes(group)) groups.push(group);
    }
    if (groups.length > 50) throw new Error('Player groups: at most 50.');
    return groups;
  }

  /** Short slip line for an offers response: {state: 'yes' | 'no', text}. Never mentions a boost size. */
  function offerLine(offer) {
    if (offer && offer.qualifies === true) return { state: 'yes', text: 'This bet qualifies for a boost' };
    const reason = offer && offer.reason_code;
    return { state: 'no', text: `No boost on this bet: ${reasonLabel(reason) || reason || 'it does not qualify'}` };
  }

  // ---------- view ----------
  const ICONS = {
    close: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M6 12v7h12v-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10.52 4.55L10.92 2.06L13.08 2.06L13.48 4.55L16.22 5.68L18.27 4.21L19.79 5.73L18.32 7.78L19.45 10.52L21.94 10.92L21.94 13.08L19.45 13.48L18.32 16.22L19.79 18.27L18.27 19.79L16.22 18.32L13.48 19.45L13.08 21.94L10.92 21.94L10.52 19.45L7.78 18.32L5.73 19.79L4.21 18.27L5.68 16.22L4.55 13.48L2.06 13.08L2.06 10.92L4.55 10.52L5.68 7.78L4.21 5.73L5.73 4.21L7.78 5.68ZM12 8.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8Z"/></svg>',
    soundOn: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor"/><path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 19 1-4 9-9 3 3-9 9-4 1Zm9-12 3 3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  };
  const CHIPS = [5, 20, 50, 100];
  const BRAND_BASE = './brand/';
  const BURST_PARTICLES = 18;

  const TEMPLATE = `
    <div class="slip-sheet">
      <header class="slip-head">
        <span class="slip-live-tag" aria-hidden="true">Live <b>0</b></span>
        <img class="slip-logo" alt="" hidden />
        <h2 id="slipTitle">Bet slip <span class="slip-count" data-s="count">0</span></h2>
        <button type="button" class="slip-close" id="slipClose" aria-label="Close player view">${ICONS.close}</button>
      </header>
      <div class="slip-tabs" aria-label="Bet type">
        <button type="button" class="slip-tab" aria-disabled="true" tabindex="-1">Single</button>
        <button type="button" class="slip-tab is-active" aria-current="true">Multi</button>
        <button type="button" class="slip-tab" aria-disabled="true" tabindex="-1">System</button>
      </div>
      <div class="slip-legs" data-s="legs"></div>
      <section class="slip-boost" data-s="boost" data-state="draft" aria-label="Boost ride">
        <div class="slip-burst" data-s="burst" aria-hidden="true"></div>
        <div class="slip-boost-top"><h3 data-s="boostTitle">Boost ride</h3><span class="slip-info" aria-hidden="true">i</span></div>
        <p class="slip-boost-sub" data-s="boostSub"></p>
        <p class="slip-offer" data-s="offer" data-state="pending" role="status" hidden></p>
        <div class="slip-locked" data-show="locked"><span class="slip-locked-pct" data-s="lockedPct">+0.00% locked</span></div>
        <button type="button" class="slip-start" data-show="placed" data-s="start">Start boost ride</button>
        <p class="slip-note" data-s="note" role="status" hidden></p>
      </section>
      <div class="slip-tools">
        <button type="button" class="slip-pill" aria-disabled="true">${ICONS.trash}<span>Delete All</span></button>
        <button type="button" class="slip-pill" aria-disabled="true">${ICONS.share}<span>Share</span></button>
        <button type="button" class="slip-gear" aria-disabled="true" aria-label="Settings">${ICONS.gear}</button>
      </div>
      <div class="slip-money">
        <div class="slip-odds-box"><span class="slip-odds-label">Odds</span><span class="slip-odds-vals"><s data-s="oddsOld" hidden></s><b data-s="oddsNew">—</b></span></div>
        <div class="slip-bet-box"><span>Bet</span><b data-s="stake">—</b></div>
      </div>
      <div class="slip-chips" data-s="chips">
        <button type="button" class="slip-chip-btn slip-chip-edit" aria-disabled="true" aria-label="Edit stake">${ICONS.pencil}</button>
        ${CHIPS.map((amount) => `<button type="button" class="slip-chip-btn" data-stake="${amount}">€${amount}</button>`).join('')}
        <button type="button" class="slip-chip-btn" aria-disabled="true">MAX</button>
      </div>
      <button type="button" class="slip-place" data-s="place">Place bet</button>
      <div class="slip-return"><span>Potential max return:</span><span class="slip-return-vals"><s data-s="retOld" hidden></s><b data-s="retNew">—</b></span></div>
    </div>
    <section class="slip-stage" data-s="stage" data-view="ride" data-outcome="" aria-label="Boost ride stage" hidden>
      <canvas class="stage-canvas" data-s="canvas" aria-hidden="true"></canvas>
      <div class="stage-top">
        <span class="stage-tag"><i class="stage-dot" aria-hidden="true"></i><span data-s="stageTag">Boost ride live</span></span>
        <button type="button" class="stage-sound" data-s="sound" aria-pressed="false" aria-label="Sound off">${ICONS.soundOff}</button>
      </div>
      <div class="stage-main">
        <div class="stage-ride">
          <div class="stage-pct" data-s="livePct" aria-hidden="true">+0.00%</div>
          <div class="stage-dir" data-s="liveDir" data-direction="none"><span class="stage-dir-arrow" data-s="liveArrow" aria-hidden="true">—</span><span data-s="liveDirText">No recent trend</span></div>
        </div>
        <div class="stage-result">
          <div class="stage-result-title" data-s="resultTitle"></div>
          <p class="stage-result-sub" data-s="resultSub"></p>
        </div>
        <span class="stage-sr" data-s="stageSr" role="status" aria-live="polite" aria-atomic="true"></span>
      </div>
      <div class="stage-arena" data-s="arena" aria-hidden="true"></div>
      <div class="stage-foot">
        <div class="stage-numbers">
          <div class="stage-num"><span>Odds</span><span class="stage-num-vals"><s data-s="stageOddsOld" hidden></s><b data-s="stageOddsNew">—</b></span></div>
          <div class="stage-num"><span>Potential return</span><span class="stage-num-vals"><s data-s="stageRetOld" hidden></s><b data-s="stageRetNew">—</b></span></div>
        </div>
        <p class="stage-confirm" data-s="stageConfirm" hidden>Confirming…</p>
        <p class="stage-note" data-s="stageNote" hidden></p>
        <button type="button" class="stage-stop" data-s="stop">Stop and lock boost</button>
        <button type="button" class="stage-back" data-s="back" hidden>Back to slip</button>
      </div>
    </section>`;

  function mount(deps) {
    const { ride, state } = deps;
    const doc = document;
    const opener = doc.getElementById(deps.openerId || 'playerViewBtn');
    const panel = doc.createElement('aside');
    panel.className = 'player-slip';
    panel.id = 'playerSlip';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'slipTitle');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    panel.innerHTML = TEMPLATE;
    doc.body.appendChild(panel);
    const el = {};
    panel.querySelectorAll('[data-s]').forEach((node) => { el[node.dataset.s] = node; });
    const closeButton = panel.querySelector('#slipClose');
    const logo = panel.querySelector('.slip-logo');
    const reduced = () => !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (opener) { opener.setAttribute('aria-controls', 'playerSlip'); opener.setAttribute('aria-expanded', 'false'); }

    for (let i = 0; i < BURST_PARTICLES; i += 1) {
      const particle = doc.createElement('i');
      particle.style.setProperty('--angle', `${Math.round((360 / BURST_PARTICLES) * i)}deg`);
      particle.style.setProperty('--dist', `${52 + (i % 3) * 20}px`);
      particle.style.setProperty('--delay', `${(i % 4) * 25}ms`);
      el.burst.appendChild(particle);
    }

    const model = {
      open: false, placed: false, placedBetId: null, placing: false,
      precheck: null, offerKey: null, offerState: null, offerTimer: null, offerSeq: 0, server: null, identity: null, legsSignature: null, lastGroup: null, brandProbed: false, closeTimer: null,
      stageView: null, resultTimer: null, outcome: null, srAt: 0, srText: '',
    };
    const RS = globalThis.RideStage || null;
    const sound = RS ? RS.createSound() : null;
    const stageColors = () => {
      const style = globalThis.getComputedStyle(panel);
      const read = (name) => style.getPropertyValue(name).trim();
      return { accent: read('--stage-accent') || read('--slip-green'), cool: read('--stage-cool'), bgTop: read('--stage-bg-top'), bgBottom: read('--stage-bg-bottom'), hot: read('--stage-hot'), amber: read('--stage-amber'), star: read('--stage-star') };
    };
    // Observed samples only; after a crash the terminal zero is not drawn, the comet fizzles where it last was seen.
    const stageData = () => {
      const samples = ride.samples;
      const shown = ride.phase === 'crashed' && samples.length > 1 ? samples.slice(0, -1) : samples;
      return { samples: shown, outcome: model.outcome };
    };
    const comet = RS ? RS.createStage({
      canvas: el.canvas,
      getData: stageData,
      getColors: stageColors,
      getBand: () => {
        const canvasBox = el.canvas.getBoundingClientRect(), arena = el.arena.getBoundingClientRect();
        return { top: arena.top - canvasBox.top + arena.height * 0.14, bottom: arena.bottom - canvasBox.top - arena.height * 0.12 };
      },
      reduced: () => reduced(),
      onTick: (info) => sound && sound.setLevel(info.intensity),
    }) : null;

    const setupValue = (id) => doc.getElementById(id).value;
    const tryMinor = (text) => { try { return deps.parseMinorAmount(text, 'Amount'); } catch (error) { return null; } };
    const currentLegs = () => legsFromRows(deps.rows(), { minSelectionOdds: Number(setupValue('minSelectionOdds')) });
    const signatureOf = (legs) => legs.map((leg) => `${leg.position}:${leg.odds}:${leg.kind}:${leg.counted}`).join('|');
    const isActive = () => ['running', 'locking', 'uncertain'].includes(ride.phase);
    const isFinal = () => ['locked', 'crashed', 'ended'].includes(ride.phase);
    const isOpen = () => !!(deps.isOpen && deps.isOpen());
    /** Everything an offers answer depends on: a change of any of these asks the server again. */
    const offerKeyNow = () => JSON.stringify([
      setupValue('brandId'), setupValue('userId'), deps.profileKey ? deps.profileKey() : '', setupValue('playerGroups'),
      setupValue('matchTiming'), setupValue('stake'), setupValue('currency'), deps.rows(),
    ]);

    // ----- server values (only what responses carry) -----
    function syncIdentity() {
      if (model.identity !== ride.identity) { model.identity = ride.identity; model.server = ride.identity ? {} : null; }
    }
    /** Called with every payload the console shows in its raw JSON panel. */
    function observe(payload) {
      const data = payload && typeof payload === 'object' ? (payload.details && typeof payload.details === 'object' ? payload.details : payload) : null;
      if (!data) return;
      syncIdentity();
      const rowsSignature = signatureOf(currentLegs());
      const isRide = 'current_boost_pct' in data || 'lock_id' in data || 'ride_started' in data;
      const odds = data.combined_odds ?? data.qualifying_odds;
      if (!isRide && typeof data.qualifies === 'boolean') {
        // Open-boost offer (the console's own check): same role as a precheck for this ticket.
        model.precheck = { eligible: data.qualifies, reason: data.qualifies ? null : data.reason_code || null, combinedOdds: data.combined_odds ?? null, signature: rowsSignature, key: offerKeyNow() };
        return;
      }
      if (!isRide && typeof data.eligible === 'boolean' && odds !== undefined) {
        model.precheck = { eligible: data.eligible, reason: data.reason_code || null, combinedOdds: odds, signature: rowsSignature };
        return;
      }
      if (!model.server) return;
      if (odds !== undefined && toRational(odds)) model.server.combinedOdds = odds;
      if ('ride_started' in data) {
        model.server.stakeMinor = data.stake_minor ?? null;
        model.server.currency = data.currency ?? null;
        model.server.capMinor = data.bonus_cap_minor ?? null;
        model.server.optedIn = true;
      }
    }

    // ----- stage -----
    function stage() {
      syncIdentity();
      if (isActive()) { model.placed = true; model.placedBetId = ride.identity?.bet_id ?? model.placedBetId; return ride.phase; }
      if (isFinal() && (!model.placed || ride.identity?.bet_id === model.placedBetId)) return ride.phase;
      return model.placed ? 'placed' : 'draft';
    }
    const groupOf = (name) => ({ draft: 'draft', placed: 'placed', running: 'live', locking: 'live', uncertain: 'live', locked: 'locked', crashed: 'over', ended: 'over' })[name];

    function money(active) {
      const rideStage = active && model.server && ride.identity;
      const stakeMinor = rideStage && model.server.stakeMinor != null ? model.server.stakeMinor : tryMinor(setupValue('stake'));
      const currencyText = rideStage && model.server.currency ? model.server.currency : setupValue('currency').trim().toUpperCase();
      const currency = /^[A-Z]{3}$/.test(currencyText) ? currencyText : '';
      const capMinor = rideStage && 'capMinor' in model.server ? model.server.capMinor : tryMinor(setupValue('maxBonus'));
      return { stakeMinor, currency, capMinor };
    }
    function knownOdds(legs, active) {
      if (active && model.server?.combinedOdds !== undefined) return { value: model.server.combinedOdds, server: true };
      if (model.precheck && model.precheck.combinedOdds != null && model.precheck.signature === signatureOf(legs)) return { value: model.precheck.combinedOdds, server: true };
      const product = productOdds(legs);
      return { value: product, server: false };
    }

    // ----- rendering -----
    function renderLegs(legs) {
      const signature = signatureOf(legs);
      el.count.textContent = String(legs.length);
      if (signature === model.legsSignature) return;
      model.legsSignature = signature;
      el.legs.replaceChildren(...legs.map((leg) => {
        const card = doc.createElement('article');
        card.className = 'slip-leg';
        card.dataset.kind = leg.kind;
        const market = leg.kind === 'sgp'
          ? `<span class="slip-market">Same Game Parlay${leg.legCount ? ` · ${leg.legCount} legs` : ''}</span>`
          : `<span class="slip-market">Winner - <em>${leg.pick}</em></span>`;
        const tag = leg.counted ? '' : `<span class="slip-leg-tag">${leg.kind === 'excluded' ? 'No boost' : 'Below minimum odds'}</span>`;
        card.innerHTML = `<div class="slip-leg-row"><span class="slip-team">${leg.home}</span><b class="slip-leg-odds">${leg.odds}</b></div>
          <div class="slip-leg-row"><span class="slip-team"><span class="slip-x" aria-hidden="true">${ICONS.close}</span>${leg.away}</span></div>
          <div class="slip-leg-row slip-leg-pick">${market}${tag}</div>`;
        return card;
      }));
    }

    function burst() {
      if (reduced()) return;
      el.burst.classList.remove('is-bursting');
      void el.burst.offsetWidth;
      el.burst.classList.add('is-bursting');
    }

    function setPair(oldNode, newNode, oldText, newText) {
      oldNode.hidden = !oldText;
      oldNode.textContent = oldText || '';
      newNode.textContent = newText;
    }

    function render() {
      if (!model.open && !model.closeTimer) return;
      const legs = currentLegs();
      renderLegs(legs);
      const name = stage();
      const group = groupOf(name);
      const active = group !== 'draft' && group !== 'placed';
      const m = money(active);
      const odds = knownOdds(legs, active);
      const lastSample = ride.samples.at(-1);
      const boost = group === 'locked' ? ride.final.boost : group === 'live' ? (lastSample ? lastSample.boost : 0) : null;
      const base = odds.value ? computePotential({ stakeMinor: m.stakeMinor, combinedOdds: odds.value, boost: 0, capMinor: m.capMinor }) : null;
      const boosted = boost !== null && odds.value ? computePotential({ stakeMinor: m.stakeMinor, combinedOdds: odds.value, boost, capMinor: m.capMinor }) : null;
      const showBoosted = boosted && (group === 'locked' || group === 'live');

      el.boost.dataset.state = name;
      el.boost.querySelectorAll('[data-show]').forEach((node) => { node.hidden = !node.dataset.show.split(' ').includes(group); });

      // Boost card. The player is never shown a maximum or ceiling; the stage carries the live numbers.
      const precheckBlocks = model.precheck && model.precheck.eligible === false && model.precheck.signature === signatureOf(legs);
      el.boostTitle.textContent = { draft: 'Boost ride', placed: 'Boost ride', live: 'Boost ride live', locked: 'Boost locked', over: 'No boost this time' }[group];
      const open = isOpen();
      el.boostSub.textContent = {
        draft: open ? 'Place your bet, then tap Use boost to start the boost ride and tap Stop to lock your boost.' : 'Place your bet, then start the boost ride and tap Stop to lock your boost.',
        placed: open ? 'Bet placed. Tap Use boost to start the ride, then tap Stop to lock the boost.' : 'Bet placed. Start the ride, then tap Stop to lock the boost.',
        live: 'Tap Stop to lock this boost. If the ride crashes first, there is no boost.',
        locked: 'Your boost is locked on this bet.',
        over: ride.phase === 'crashed' ? 'The ride crashed before you stopped. Your odds are unchanged.' : 'The ride ended before you stopped. Your odds are unchanged.',
      }[group];
      if (group === 'locked') el.lockedPct.textContent = `+${(ride.final.boost * 100).toFixed(2)}% locked`;
      el.start.textContent = open ? 'Use boost' : 'Start boost ride';
      el.start.disabled = !!state.pendingAction || !(state.startable ?? state.readyToStart) || !!precheckBlocks;
      const summary = deps.summary();
      const blockText = open ? `This bet does not qualify for a boost: ${reasonLabel(model.precheck?.reason) || model.precheck?.reason || 'see console'}` : `This ticket is not eligible for a boost (${model.precheck?.reason || 'see console'}).`;
      const warning = summary.warning && summary.text ? summary.text : precheckBlocks && group === 'placed' ? blockText : '';

      // Open boosts: the draft slip says whether this bet qualifies (server answer, debounced; a failure claims nothing).
      el.offer.hidden = !(open && group === 'draft');
      if (open && group === 'draft') {
        const key = offerKeyNow();
        refreshOffer(key);
        const hit = model.precheck && model.precheck.key === key ? model.precheck : null;
        if (hit) {
          const line = offerLine({ qualifies: hit.eligible, reason_code: hit.reason });
          el.offer.dataset.state = line.state;
          el.offer.textContent = line.text;
        } else if (model.offerKey === key && model.offerState === 'pending') {
          el.offer.dataset.state = 'pending';
          el.offer.textContent = 'Checking whether this bet qualifies…';
        } else el.offer.hidden = true;
      }
      el.note.hidden = !warning;
      el.note.textContent = warning;

      // Odds, bet and return
      setPair(el.oddsOld, el.oddsNew, showBoosted && boosted.boostedOdds !== boosted.baseOdds ? boosted.baseOdds : '', showBoosted ? boosted.boostedOdds : base ? base.baseOdds : odds.value && formatOdds(odds.value) ? formatOdds(odds.value) : '—');
      el.stake.textContent = m.stakeMinor == null ? '—' : formatStake(m.stakeMinor, m.currency);
      setPair(el.retOld, el.retNew, showBoosted && boosted.totalMinor !== boosted.grossMinor ? formatMoney(boosted.grossMinor, m.currency) : '', showBoosted ? formatMoney(boosted.totalMinor, m.currency) : base ? formatMoney(base.grossMinor, m.currency) : '—');
      el.oddsNew.closest('.slip-odds-box').dataset.boosted = String(!!showBoosted);

      // Stake chips and Place bet
      const locked = group !== 'draft' || model.placing;
      const stakeNow = m.stakeMinor == null ? null : String(m.stakeMinor);
      el.chips.querySelectorAll('[data-stake]').forEach((chip) => {
        chip.disabled = locked;
        chip.classList.toggle('is-active', stakeNow === String(Number(chip.dataset.stake) * 100));
      });
      el.place.disabled = model.placing || !!state.pendingAction || isActive() || group === 'placed';
      el.place.textContent = model.placing ? 'Placing bet…' : group === 'draft' ? 'Place bet' : group === 'placed' || isActive() ? 'Bet placed' : 'Place new bet';

      syncStage(group, boost, warning);
      model.lastGroup = group;
    }

    // ----- ride stage (whole-slip comet view while the ride runs, then a short result moment) -----
    const RESULT_MS = 3000;
    const SR_EVERY_MS = 3000;
    const stageActive = () => model.open && model.stageView !== null;
    const focusIsLoose = () => !doc.activeElement || doc.activeElement === doc.body || panel.contains(doc.activeElement);
    function updateSoundButton() {
      if (!sound) { el.sound.hidden = true; return; }
      const on = sound.isEnabled();
      el.sound.setAttribute('aria-pressed', String(on));
      el.sound.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
      el.sound.innerHTML = on ? ICONS.soundOn : ICONS.soundOff;
    }
    function showStage(view) {
      model.stageView = view;
      el.stage.hidden = false;
      el.stage.dataset.view = view;
      panel.dataset.stage = view;
      panel.scrollTop = 0;
      updateSoundButton();
    }
    function enterRide() {
      clearTimeout(model.resultTimer);
      model.outcome = null;
      model.srAt = 0;
      const loose = focusIsLoose();
      showStage('ride');
      el.stage.dataset.outcome = '';
      comet?.reset();
      comet?.start();
      sound?.startRide();
      if (loose) el.stop.focus({ preventScroll: true });
    }
    function enterResult(group) {
      const kind = group === 'locked' ? 'locked' : 'crashed';
      const wasRide = model.stageView === 'ride';
      const loose = focusIsLoose();
      showStage('result');
      model.outcome = kind;
      el.stage.dataset.outcome = kind;
      if (!wasRide) { comet?.reset(); comet?.start(); }
      comet?.setOutcome(kind);
      if (kind === 'locked') sound?.lock(); else sound?.crash();
      clearTimeout(model.resultTimer);
      model.resultTimer = setTimeout(() => leaveStage(true), RESULT_MS);
      model.srAt = 0;
      if (loose) el.back.focus({ preventScroll: true });
    }
    function leaveStage(rerender) {
      clearTimeout(model.resultTimer);
      model.resultTimer = null;
      const wasStage = model.stageView !== null;
      const loose = focusIsLoose();
      model.stageView = null;
      model.outcome = null;
      comet?.stop();
      sound?.stop();
      el.stage.hidden = true;
      delete panel.dataset.stage;
      if (!wasStage) return;
      if (loose && model.open) closeButton.focus({ preventScroll: true });
      if (rerender) {
        render();
        if (model.lastGroup === 'locked') burst();
      }
    }
    /* The stage numbers are sized from the stage width (container units in CSS); this shrinks one line further
     * when a long value (+1000.00% locked) would still overflow, on any font. */
    function fitStageText(node, minPx) {
      node.style.fontSize = '';
      if (!node.isConnected || !node.clientWidth) return;
      const natural = node.scrollWidth, available = node.clientWidth;
      if (natural <= available) return;
      const current = parseFloat(globalThis.getComputedStyle(node).fontSize) || 40;
      node.style.fontSize = `${Math.max(minPx, Math.floor((current * available * 0.98) / natural))}px`;
    }
    const fitStage = () => { fitStageText(el.livePct, 24); if (el.stage.dataset.outcome === 'locked') fitStageText(el.resultTitle, 18); else el.resultTitle.style.fontSize = ''; };
    if (globalThis.MutationObserver) new MutationObserver(fitStage).observe(el.stage, { childList: true, characterData: true, subtree: true });
    function srAnnounce(text, force) {
      const now = Date.now();
      if (!force && now - model.srAt < SR_EVERY_MS) return;
      model.srAt = now;
      if (text !== model.srText) { model.srText = text; el.stageSr.textContent = text; }
    }
    function syncStage(group, boost, warning) {
      const final = group === 'locked' || group === 'over';
      const was = model.stageView;
      if (group === 'live') { if (was !== 'ride') enterRide(); }
      else if (final && was !== 'result' && (was === 'ride' || (was === null && ['live', 'placed'].includes(model.lastGroup)))) enterResult(group);
      else if (!final && was !== null) leaveStage(false);
      if (!model.stageView) {
        if (group === 'locked' && model.lastGroup !== 'locked') burst();
        return;
      }
      const view = model.stageView;
      const level = RS ? RS.intensity(boost ?? 0) : 0;
      el.stage.style.setProperty('--i', level.toFixed(3));
      const confirming = ride.phase === 'locking' || ride.phase === 'uncertain';
      el.stageTag.textContent = view === 'result' ? (group === 'locked' ? 'Boost locked' : 'Ride over') : confirming ? 'Confirming…' : 'Boost ride live';
      if (view === 'ride') {
        const text = `+${((boost ?? 0) * 100).toFixed(2)}%`;
        el.livePct.textContent = text;
        el.liveDir.dataset.direction = doc.getElementById('rideDirection').dataset.direction;
        el.liveArrow.textContent = doc.getElementById('rideDirectionArrow').textContent;
        el.liveDirText.textContent = doc.getElementById('rideDirectionText').textContent;
        srAnnounce(confirming ? 'Confirming the boost' : `Boost ${text}`, false);
      } else if (group === 'locked') {
        const text = `+${(ride.final.boost * 100).toFixed(2)}% locked`;
        el.resultTitle.textContent = text;
        el.resultSub.textContent = 'Your boost is locked on this bet.';
        srAnnounce(`Boost ${text}`, true);
      } else {
        el.resultTitle.textContent = 'No boost this time';
        el.resultSub.textContent = ride.phase === 'crashed' ? 'The ride crashed before you stopped. Your odds are unchanged.' : 'The ride ended before you stopped. Your odds are unchanged.';
        srAnnounce('No boost this time', true);
      }
      fitStage();
      el.stageConfirm.hidden = !(view === 'ride' && confirming);
      el.stageNote.hidden = !(view === 'ride' && warning);
      el.stageNote.textContent = view === 'ride' ? warning : '';
      el.stop.hidden = view !== 'ride';
      el.back.hidden = view !== 'result';
      el.stop.disabled = !!state.pendingAction || ride.phase === 'locking';
      el.stop.textContent = ride.phase === 'locking' ? 'Locking…' : ride.phase === 'uncertain' ? 'Retry stop' : 'Stop and lock boost';
      setPair(el.stageOddsOld, el.stageOddsNew, el.oddsOld.hidden ? '' : el.oddsOld.textContent, el.oddsNew.textContent);
      setPair(el.stageRetOld, el.stageRetNew, el.retOld.hidden ? '' : el.retOld.textContent, el.retNew.textContent);
      if (comet && model.open) {
        if (!comet.isRunning() && !reduced()) comet.start();
        else comet.redraw();
      }
    }

    // ----- open boosts: background offers check (latest answer wins) -----
    const OFFER_DEBOUNCE_MS = 350;
    function refreshOffer(key) {
      if (key === model.offerKey) return;
      model.offerKey = key;
      model.offerState = 'pending';
      clearTimeout(model.offerTimer);
      const seq = ++model.offerSeq;
      model.offerTimer = setTimeout(async () => {
        try {
          const data = await deps.offer();
          if (seq !== model.offerSeq) return;
          model.precheck = { eligible: data.qualifies === true, reason: data.qualifies === true ? null : data.reason_code || null, combinedOdds: data.combined_odds ?? null, signature: signatureOf(currentLegs()), key };
          model.offerState = 'done';
        } catch (error) {
          if (seq !== model.offerSeq) return;
          model.offerState = 'failed';
          if (model.precheck && model.precheck.key === key) model.precheck = null;
        }
        render();
      }, OFFER_DEBOUNCE_MS);
    }

    // ----- driving the console's own code paths -----
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function until(check, timeout = 9000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (check()) return true; await wait(40); }
      return check();
    }
    async function consoleClick(id, done) {
      await until(() => !state.pendingAction);
      const button = doc.getElementById(id);
      if (button.disabled) return false;
      button.click();
      return until(() => !state.pendingAction && done());
    }
    async function placeBet() {
      if (model.placing || isActive()) return;
      model.placing = true;
      render();
      try {
        // A fresh bet ID first, so a new bet never reuses the previous ride's identity.
        doc.getElementById('betId').value = deps.generateBetId();
        doc.getElementById('betId').dispatchEvent(new Event('input', { bubbles: true })); // the console re-checks what it can start
        if (doc.getElementById('profileId').textContent.trim() === 'n/a') {
          if (!await consoleClick('createProfile', () => doc.getElementById('profileId').textContent.trim() !== 'n/a')) return;
        }
        // Open boosts have no grant step: the reward is created when the player uses the boost on the placed bet,
        // and the draft slip already carries the server's answer for this ticket.
        if (!isOpen()) {
          model.precheck = null;
          if (!state.readyToStart) {
            if (!await consoleClick('grantReward', () => state.readyToStart)) return;
          }
          // The server's combined odds for this ticket, through the console's own eligibility check.
          await consoleClick('precheckEligibility', () => true);
        }
        model.placed = true;
        model.placedBetId = doc.getElementById('betId').value;
      } finally {
        model.placing = false;
        render();
      }
    }

    // ----- open / close -----
    /* Local brand assets load only when asked for (?brand=1, remembered in localStorage; ?brand=0 forgets it):
     * a browser always prints a console error for a missing file, so probing blindly would make every plain
     * demo visit noisy. Without the flag, or without the files, the plain dark/green slip is used. */
    function brandRequested() {
      try {
        const flag = new URLSearchParams(globalThis.location.search).get('brand');
        if (flag === '1') globalThis.localStorage.setItem('demoBrand', '1');
        if (flag === '0') globalThis.localStorage.removeItem('demoBrand');
        return globalThis.localStorage.getItem('demoBrand') === '1';
      } catch (error) { return false; }
    }
    function probeBrand() {
      if (model.brandProbed || !brandRequested()) return;
      model.brandProbed = true;
      const exists = async (file, kind) => {
        try {
          const response = await fetch(`${BRAND_BASE}${file}`, { method: 'HEAD', cache: 'no-cache' });
          return response.ok && (response.headers.get('content-type') || '').includes(kind);
        } catch (error) { return false; }
      };
      (async () => {
        if (await exists('brand.css', 'css')) {
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.href = `${BRAND_BASE}brand.css`;
          doc.head.appendChild(link);
        }
        for (const [file, kind] of [['logo.svg', 'svg'], ['logo.png', 'png']]) {
          if (await exists(file, kind)) { logo.src = `${BRAND_BASE}${file}`; logo.hidden = false; panel.classList.add('has-logo'); break; }
        }
      })();
    }
    function openSlip() {
      if (model.open) return;
      clearTimeout(model.closeTimer);
      model.closeTimer = null;
      model.open = true;
      panel.inert = false;
      panel.removeAttribute('aria-hidden');
      panel.dataset.open = 'true';
      doc.body.classList.add('slip-open');
      if (opener) opener.setAttribute('aria-expanded', 'true');
      render();
      closeButton.focus();
      if (model.stageView) {
        comet?.start();
        if (model.stageView === 'ride') sound?.startRide();
        (model.stageView === 'ride' ? el.stop : el.back).focus({ preventScroll: true });
      }
      probeBrand();
    }
    function finishClose() {
      clearTimeout(model.closeTimer);
      model.closeTimer = null;
      delete panel.dataset.open;
      panel.inert = true;
      panel.setAttribute('aria-hidden', 'true');
    }
    function closeSlip() {
      if (!model.open) return;
      const hadFocus = panel.contains(doc.activeElement);
      model.open = false;
      comet?.stop();
      sound?.stop();
      doc.body.classList.remove('slip-open');
      if (opener) opener.setAttribute('aria-expanded', 'false');
      panel.inert = true;
      if (hadFocus && opener) opener.focus();
      if (reduced()) { finishClose(); return; }
      panel.dataset.open = 'closing';
      model.closeTimer = setTimeout(finishClose, 260);
    }

    brandRequested(); // applies ?brand=1 / ?brand=0 right away; files are fetched on first open
    opener?.addEventListener('click', () => (model.open ? closeSlip() : openSlip()));
    closeButton.addEventListener('click', closeSlip);
    // Audio may only start after the user has tapped or pressed something inside the slip.
    panel.addEventListener('pointerdown', () => sound?.unlock(), true);
    panel.addEventListener('keydown', () => sound?.unlock(), true);
    globalThis.addEventListener('resize', () => { if (stageActive()) { fitStage(); if (comet) { comet.resize(); comet.redraw(); } } });
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape' && model.open && !event.defaultPrevented) { event.preventDefault(); closeSlip(); } });
    panel.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target || target.getAttribute('aria-disabled') === 'true') return;
      if (target === el.sound) { sound?.unlock(); sound?.toggle(); updateSoundButton(); }
      else if (target === el.back) leaveStage(true);
      else if (target === el.place) void placeBet();
      else if (target === el.start) doc.getElementById('startRide').click();
      else if (target === el.stop) doc.getElementById('lockBoost').click();
      else if (target.dataset.stake && !target.disabled) {
        const stake = doc.getElementById('stake');
        stake.value = `${target.dataset.stake}.00`;
        stake.dispatchEvent(new Event('input', { bubbles: true }));
        render();
      }
    });
    // Setup edits (odds, types, stake, currency, row count) keep the slip in step with the console.
    let scheduled = false;
    const schedule = () => { if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; render(); }, 0); };
    doc.addEventListener('input', (event) => { if (event.target.closest && event.target.closest('#ticketSetup, #profileSetup')) schedule(); });
    doc.addEventListener('change', (event) => { if (event.target.closest && event.target.closest('#ticketSetup, #profileSetup')) schedule(); });
    doc.getElementById('applySelectionCount')?.addEventListener('click', schedule);

    return { render, observe, open: openSlip, close: closeSlip, panel, model };
  }

  return {
    toRational, roundHalfUp, formatOdds, formatMoney, formatStake, computePotential,
    fixtureFor, legsFromRows, productOdds, percentText, sparkDomain, mount,
    reasonLabel, timingFields, parseGroups, offerLine, TIMING_MODES,
  };
});
