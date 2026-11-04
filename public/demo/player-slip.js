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
   * Gross and bonus are each rounded half-up to whole minor units; boosted odds are rounded half-up to 2 dp.
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

  // ---------- view ----------
  const ICONS = {
    close: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M6 12v7h12v-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10.52 4.55L10.92 2.06L13.08 2.06L13.48 4.55L16.22 5.68L18.27 4.21L19.79 5.73L18.32 7.78L19.45 10.52L21.94 10.92L21.94 13.08L19.45 13.48L18.32 16.22L19.79 18.27L18.27 19.79L16.22 18.32L13.48 19.45L13.08 21.94L10.92 21.94L10.52 19.45L7.78 18.32L5.73 19.79L4.21 18.27L5.68 16.22L4.55 13.48L2.06 13.08L2.06 10.92L4.55 10.52L5.68 7.78L4.21 5.73L5.73 4.21L7.78 5.68ZM12 8.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8Z"/></svg>',
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
        <div class="slip-live" data-show="live">
          <div class="slip-live-main">
            <span class="slip-live-pct" data-s="livePct">+0.00%</span>
            <span class="slip-dir" data-s="liveDir" data-direction="none"><span class="slip-dir-arrow" data-s="liveArrow" aria-hidden="true">—</span><span data-s="liveDirText">No recent trend</span></span>
          </div>
          <svg class="slip-spark" viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true"><path data-s="spark" d=""></path></svg>
        </div>
        <div class="slip-locked" data-show="locked"><span class="slip-locked-pct" data-s="lockedPct">+0.00% locked</span></div>
        <div class="slip-scale" data-show="draft placed live">
          <span class="slip-scale-min">0%</span>
          <div class="slip-track"><div class="slip-fill" data-s="fill"></div><span class="slip-chip" data-s="chip" hidden></span></div>
          <span class="slip-scale-max" data-s="scaleMax">up to —</span>
        </div>
        <button type="button" class="slip-start" data-show="placed" data-s="start">Start boost ride</button>
        <button type="button" class="slip-stop" data-show="live" data-s="stop">Stop and lock boost</button>
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
    </div>`;

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
      precheck: null, server: null, identity: null, legsSignature: null, lastGroup: null, brandProbed: false, closeTimer: null,
    };

    const setupValue = (id) => doc.getElementById(id).value;
    const tryMinor = (text) => { try { return deps.parseMinorAmount(text, 'Amount'); } catch (error) { return null; } };
    const currentLegs = () => legsFromRows(deps.rows(), { minSelectionOdds: Number(setupValue('minSelectionOdds')) });
    const signatureOf = (legs) => legs.map((leg) => `${leg.position}:${leg.odds}:${leg.kind}:${leg.counted}`).join('|');
    const isActive = () => ['running', 'locking', 'uncertain'].includes(ride.phase);
    const isFinal = () => ['locked', 'crashed', 'ended'].includes(ride.phase);

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
      if (!isRide && typeof data.eligible === 'boolean' && odds !== undefined) {
        model.precheck = { eligible: data.eligible, reason: data.reason_code || null, combinedOdds: odds, signature: rowsSignature };
        return;
      }
      if (!model.server) return;
      if (odds !== undefined && toRational(odds)) model.server.combinedOdds = odds;
      if (typeof data.effective_max_boost_pct === 'number' && Number.isFinite(data.effective_max_boost_pct)) model.server.effectiveMax = data.effective_max_boost_pct;
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
      if (model.precheck && model.precheck.signature === signatureOf(legs)) return { value: model.precheck.combinedOdds, server: true };
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

    function renderSpark() {
      const samples = ride.samples;
      if (!samples.length) { el.spark.setAttribute('d', ''); return; }
      const width = 240, height = 48, pad = 4;
      const lastSeconds = samples.at(-1).seconds;
      const domain = sparkDomain(samples.map((sample) => sample.boost));
      const x = (seconds) => (lastSeconds > 0 ? pad + (seconds / lastSeconds) * (width - 2 * pad) : width / 2);
      const y = (boost) => height - pad - ((boost - domain.min) / (domain.max - domain.min)) * (height - 2 * pad);
      const path = samples.map((sample, index) => `${index === 0 || sample.gapBefore ? 'M' : 'L'} ${x(sample.seconds).toFixed(1)} ${y(sample.boost).toFixed(1)}`).join(' ');
      // One sample is a dot (zero-length round-capped segment), never a slope.
      el.spark.setAttribute('d', samples.length === 1 ? `${path} h0.01` : path);
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
      if (group === 'locked' && model.lastGroup !== 'locked') burst();
      model.lastGroup = group;

      // Boost card
      const effectiveMax = model.server?.effectiveMax;
      const knownMax = active && typeof effectiveMax === 'number' && effectiveMax > 0;
      el.scaleMax.textContent = knownMax ? `up to ${percentText(effectiveMax)}` : 'up to —';
      const share = knownMax && boost !== null ? Math.max(0, Math.min(1, boost / effectiveMax)) : 0;
      el.fill.style.width = `${(share * 100).toFixed(2)}%`;
      el.chip.hidden = group !== 'live';
      el.chip.style.setProperty('--p', `${(share * 100).toFixed(2)}%`);
      el.chip.textContent = lastSample ? percentText(lastSample.boost) : '0%';
      const precheckBlocks = model.precheck && model.precheck.eligible === false && model.precheck.signature === signatureOf(legs);
      el.boostTitle.textContent = { draft: 'Boost ride', placed: 'Boost ride', live: 'Boost ride live', locked: 'Boost locked', over: 'No boost this time' }[group];
      el.boostSub.textContent = {
        draft: 'Place your bet, then start the boost ride and tap Stop to lock your boost.',
        placed: 'Bet placed. Start the ride, then tap Stop to lock the boost.',
        live: 'Tap Stop to lock this boost. If the ride crashes first, there is no boost.',
        locked: 'Your boost is locked on this bet.',
        over: ride.phase === 'crashed' ? 'The ride crashed before you stopped. Your odds are unchanged.' : 'The ride ended before you stopped. Your odds are unchanged.',
      }[group];
      if (group === 'live') {
        el.livePct.textContent = `+${(boost * 100).toFixed(2)}%`;
        el.liveDir.dataset.direction = doc.getElementById('rideDirection').dataset.direction;
        el.liveArrow.textContent = doc.getElementById('rideDirectionArrow').textContent;
        el.liveDirText.textContent = doc.getElementById('rideDirectionText').textContent;
        renderSpark();
      }
      if (group === 'locked') el.lockedPct.textContent = `+${(ride.final.boost * 100).toFixed(2)}% locked`;
      el.start.disabled = !!state.pendingAction || !state.readyToStart || !!precheckBlocks;
      el.stop.disabled = !!state.pendingAction || ride.phase === 'locking';
      el.stop.textContent = ride.phase === 'locking' ? 'Locking…' : ride.phase === 'uncertain' ? 'Retry stop' : 'Stop and lock boost';
      const summary = deps.summary();
      const warning = summary.warning && summary.text ? summary.text : precheckBlocks && group === 'placed' ? `This ticket is not eligible for a boost (${model.precheck.reason || 'see console'}).` : '';
      el.note.hidden = !warning;
      el.note.textContent = warning;

      // Odds, bet and return
      setPair(el.oddsOld, el.oddsNew, showBoosted && boosted.boostedOdds !== boosted.baseOdds ? boosted.baseOdds : '', showBoosted ? boosted.boostedOdds : base ? base.baseOdds : odds.value && formatOdds(odds.value) ? formatOdds(odds.value) : '—');
      el.stake.textContent = m.stakeMinor == null ? '—' : formatStake(m.stakeMinor, m.currency);
      setPair(el.retOld, el.retNew, showBoosted && boosted.totalMinor !== boosted.grossMinor ? formatMoney(boosted.grossMinor, m.currency) : '', showBoosted ? formatMoney(boosted.totalMinor, m.currency) : base ? formatMoney(base.grossMinor, m.currency) : '—');
      el.retNew.title = showBoosted && boosted.capped ? 'Bonus reached the maximum bonus for this reward' : '';
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
      model.precheck = null;
      render();
      try {
        // A fresh bet ID first, so a new bet never reuses the previous ride's identity.
        doc.getElementById('betId').value = deps.generateBetId();
        if (doc.getElementById('profileId').textContent.trim() === 'n/a') {
          if (!await consoleClick('createProfile', () => doc.getElementById('profileId').textContent.trim() !== 'n/a')) return;
        }
        if (!state.readyToStart) {
          if (!await consoleClick('grantReward', () => state.readyToStart)) return;
        }
        // The server's combined odds for this ticket, through the console's own eligibility check.
        await consoleClick('precheckEligibility', () => true);
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
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape' && model.open && !event.defaultPrevented) { event.preventDefault(); closeSlip(); } });
    panel.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target || target.getAttribute('aria-disabled') === 'true') return;
      if (target === el.place) void placeBet();
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
  };
});
