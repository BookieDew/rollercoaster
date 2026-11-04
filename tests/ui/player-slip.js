async (page) => {
  // Run via playwright-cli run-code --filename after a fresh snapshot (isolated server on 127.0.0.1:4318).
  // Covers the Player view slide-out: open/close/focus, legs, Place bet, the full-slip comet ride stage (live, locked,
  // crashed, reduced motion, sound toggle), the return to the normal slip, and mobile geometry.
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const shots = 'output/playwright/two-block/';
  const consoleErrors = [];
  const failedResponses = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.unroute('**/api/**');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { localStorage.removeItem('demoBrand'); localStorage.removeItem('demoRideSound'); });
  await page.reload();
  // Count animation frames and AudioContext creations to prove the loop is scoped and audio waits for a tap.
  await page.evaluate(() => {
    window.__raf = 0; window.__ac = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (fn) => { window.__raf += 1; return raf(fn); };
    const Orig = window.AudioContext;
    if (Orig) window.AudioContext = class extends Orig { constructor(...args) { super(...args); window.__ac += 1; } };
  });
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('demo-ui-test-key');
  const slip = page.locator('#playerSlip');
  const text = (selector) => page.locator(`#playerSlip ${selector}`).first().innerText();
  const read = () => page.evaluate(() => {
    const q = (s) => document.querySelector(`#playerSlip ${s}`);
    const shown = (s) => { const n = q(s); return !!n && !n.hidden && n.getClientRects().length > 0; };
    return {
      state: q('[data-s="boost"]').dataset.state,
      title: q('[data-s="boostTitle"]').textContent,
      lockedPct: q('[data-s="lockedPct"]').textContent,
      oddsOld: shown('[data-s="oddsOld"]') ? q('[data-s="oddsOld"]').textContent : null,
      oddsNew: q('[data-s="oddsNew"]').textContent,
      retOld: shown('[data-s="retOld"]') ? q('[data-s="retOld"]').textContent : null,
      retNew: q('[data-s="retNew"]').textContent,
      stake: q('[data-s="stake"]').textContent,
      count: q('[data-s="count"]').textContent,
      placeText: q('[data-s="place"]').textContent,
      placeDisabled: q('[data-s="place"]').disabled,
      startShown: shown('[data-s="start"]'), stopShown: shown('[data-s="stop"]'),
      stageShown: shown('[data-s="stage"]'), stageView: q('[data-s="stage"]').dataset.view, panelStage: document.getElementById('playerSlip').dataset.stage || null,
      sheetShown: shown('.slip-sheet'), stageTag: q('[data-s="stageTag"]').textContent,
      stagePct: q('[data-s="livePct"]').textContent,
      stageOddsOld: shown('[data-s="stageOddsOld"]') ? q('[data-s="stageOddsOld"]').textContent : null, stageOddsNew: q('[data-s="stageOddsNew"]').textContent,
      stageRetOld: shown('[data-s="stageRetOld"]') ? q('[data-s="stageRetOld"]').textContent : null, stageRetNew: q('[data-s="stageRetNew"]').textContent,
      resultTitle: q('[data-s="resultTitle"]').textContent, backShown: shown('[data-s="back"]'), confirmShown: shown('[data-s="stageConfirm"]'),
      srText: q('[data-s="stageSr"]').textContent, srLive: q('[data-s="stageSr"]').getAttribute('aria-live'),
      soundPressed: q('[data-s="sound"]').getAttribute('aria-pressed'),
      note: shown('[data-s="note"]') ? q('[data-s="note"]').textContent : null,
      raw: JSON.parse(document.getElementById('responseBox').textContent),
      docWidth: document.documentElement.scrollWidth, innerWidth,
      panel: (() => { const r = document.getElementById('playerSlip').getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }; })(),
    };
  });
  const moneyNumber = (value) => Number(String(value).replace(/[^\d,]/g, '').replace(',', '.'));
  // Canvas sanity: sized with the device pixel ratio and actually painted (not blank / not a flat colour).
  const canvasInfo = () => page.evaluate(() => {
    const c = document.querySelector('#playerSlip [data-s="canvas"]');
    const rect = c.getBoundingClientRect();
    const g = c.getContext('2d');
    const data = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    let bright = 0;
    for (let i = 0; i < data.length; i += 4 * 3) {
      if (data[i] + data[i + 1] + data[i + 2] > 330) bright += 1;
      seen.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
    }
    return { cssW: rect.width, cssH: rect.height, w: c.width, h: c.height, dpr: window.devicePixelRatio, colours: seen.size, bright };
  });
  // Long values must stay on one line inside the stage with >=12px side space (DOM text only; no server values are faked).
  // Runs in one synchronous page task so a live render cannot rewrite the text between the edit and the measurement.
  const checkStageText = (label) => page.evaluate(async (where) => {
    const stage = document.querySelector('#playerSlip [data-s="stage"]');
    const pct = stage.querySelector('[data-s="livePct"]'), title = stage.querySelector('[data-s="resultTitle"]');
    const saved = { view: stage.dataset.view, outcome: stage.dataset.outcome, pct: pct.textContent, title: title.textContent };
    const problems = [];
    const measure = (node, text, name) => {
      const box = node.getBoundingClientRect(), frame = stage.getBoundingClientRect();
      const fontSize = parseFloat(getComputedStyle(node).fontSize);
      const info = { name, text, font: fontSize, scrollW: node.scrollWidth, clientW: node.clientWidth, left: box.left - frame.left, right: frame.right - box.right, height: box.height };
      if (node.scrollWidth > node.clientWidth) problems.push(`${where} ${name} overflows: ${JSON.stringify(info)}`);
      if (info.left < 12 - 0.5 || info.right < 12 - 0.5) problems.push(`${where} ${name} closer than 12px to the edge: ${JSON.stringify(info)}`);
      if (box.height > fontSize * 1.4) problems.push(`${where} ${name} wraps: ${JSON.stringify(info)}`);
      return info;
    };
    const results = [];
    stage.dataset.view = 'ride';
    for (const text of ['+0.00%', '+17.66%', '+153.25%', '+1000.00%']) {
      pct.textContent = text;
      await Promise.resolve();
      results.push(measure(pct, text, 'pct'));
    }
    stage.dataset.view = 'result'; stage.dataset.outcome = 'locked';
    for (const text of ['+19.03% locked', '+1000.00% locked']) {
      title.textContent = text;
      await Promise.resolve();
      results.push(measure(title, text, 'title'));
    }
    stage.dataset.view = saved.view; stage.dataset.outcome = saved.outcome;
    pct.textContent = saved.pct; title.textContent = saved.title;
    return { problems, results };
  }, label);
  const assertStageText = async (label) => {
    const out = await checkStageText(label);
    assert(out.problems.length === 0, out.problems.join(' | '));
    return out.results.map((r) => `${r.text}@${r.font}px`);
  };
  // The player must never learn the maximum possible boost: no "up to", no scale/bar, and not the effective max the console shows.
  let knownMaxPct = null;
  const assertNoMax = async (where) => {
    const seen = await page.evaluate(() => {
      const panel = document.getElementById('playerSlip');
      const attributes = [...panel.querySelectorAll('*')].flatMap((n) => [n.getAttribute('aria-label'), n.getAttribute('title'), n.getAttribute('aria-valuemax')]).filter(Boolean);
      return {
        text: `${panel.textContent} ${attributes.join(' ')}`,
        consoleMax: document.getElementById('modelEffectiveMax').textContent,
        scale: panel.querySelectorAll('.slip-scale, .slip-track, .slip-fill, .slip-chip, progress, [role="progressbar"], [role="meter"]').length,
      };
    });
    const parsed = parseFloat(seen.consoleMax);
    if (Number.isFinite(parsed)) knownMaxPct = parsed;
    assert(!/up to/i.test(seen.text), `${where}: the slip must not say "up to": ${seen.text.match(/.{0,30}up to.{0,30}/i)}`);
    assert(seen.scale === 0, `${where}: the slip must not carry a progress scale or chip`);
    if (knownMaxPct !== null) {
      for (const form of [knownMaxPct.toFixed(2), String(+knownMaxPct.toFixed(2)), String(knownMaxPct / 100)]) assert(!seen.text.includes(form), `${where}: the slip text contains the effective max (${form})`);
    }
  };
  const rafDelta = async (ms) => { const a = await page.evaluate(() => window.__raf); await page.waitForTimeout(ms); return (await page.evaluate(() => window.__raf)) - a; };

  // 1. Closed by default; opens as a left slide-out without a backdrop.
  assert(await slip.evaluate((node) => getComputedStyle(node).display === 'none' && node.inert), 'Slip must be closed and inert at load');
  await page.getByRole('button', { name: 'Player view', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('playerSlip').dataset.open === 'true');
  await page.waitForTimeout(350);
  let view = await read();
  assert(Math.abs(view.panel.width - 400) <= 1 && view.panel.left === 0, `Desktop slip should be 400px from the left: ${JSON.stringify(view.panel)}`);
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'slipClose'), 'Focus did not move into the slip');
  assert(await page.evaluate(() => ![...document.querySelectorAll('body *')].some((n) => /backdrop|overlay|scrim/i.test(n.className && n.className.baseVal === undefined ? n.className : '') && getComputedStyle(n).position === 'fixed')), 'Slip must not dim the page');
  assert(await page.locator('#startRide').isVisible() && await page.locator('#createProfile').isEnabled(), 'Console must stay usable beside the slip');
  assert(await page.getByRole('button', { name: 'Player view', exact: true }).getAttribute('aria-expanded') === 'true', 'Opener aria-expanded not set');
  // Esc closes and returns focus.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.open);
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'playerViewBtn'), 'Focus did not return to the opener');
  assert(await slip.evaluate((node) => node.inert), 'Closed slip must be inert');
  await page.getByRole('button', { name: 'Player view', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('playerSlip').dataset.open === 'true');
  await page.waitForTimeout(350);
  await page.locator('#slipClose').click();
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.open);
  await page.getByRole('button', { name: 'Player view', exact: true }).click();
  await page.waitForTimeout(350);

  // 2. Legs mirror the setup (7 rows, one without a price is skipped by the console too).
  view = await read();
  const setupRows = await page.evaluate(() => parseSelectionsFromRows().filter((s) => s.selection_type !== 'SGP_LEG').length);
  assert(Number(view.count) === setupRows && await page.locator('#playerSlip .slip-leg').count() === setupRows, `Leg count ${view.count} != setup ${setupRows}`);
  assert(await text('.slip-leg .slip-market') .then((t) => /^Winner - /.test(t)), 'Leg missing "Winner - team" line');
  assert(await page.locator('#playerSlip .slip-leg-tag', { hasText: 'No boost' }).count() === 1, 'Excluded starter row should carry the No boost tag');
  assert(await page.locator('#playerSlip .slip-tab.is-active').innerText() === 'Multi', 'Multi must be the active tab');
  assert(view.state === 'draft', 'Draft state wrong');
  await assertNoMax('draft');
  // Chips set the setup stake before the bet only.
  await page.locator('#playerSlip [data-stake="50"]').click();
  assert(await page.locator('#stake').inputValue() === '50.00', 'Stake chip did not set the setup stake');
  assert((await read()).stake === '50 €', 'Bet box not mirroring the stake');
  await page.locator('#playerSlip [data-stake="20"]').click();
  assert(await page.locator('#stake').inputValue() === '20.00', 'Stake chip did not set 20');
  // Inert controls do nothing.
  for (const label of ['Delete All', 'Share', 'Single', 'System']) await page.locator('#playerSlip button', { hasText: label }).first().click({ force: true });
  assert((await read()).count === String(setupRows), 'Inert controls changed the slip');
  await page.screenshot({ path: `${shots}slip-1-draft-desktop.png`, fullPage: false });

  // 3. Place bet creates a profile + reward (existing console paths), writes a fresh bet ID, stays pre-ride.
  const previousBet = await page.locator('#betId').inputValue();
  await page.locator('#playerSlip [data-s="place"]').click();
  await page.waitForFunction(() => document.querySelector('#playerSlip [data-s="boost"]').dataset.state === 'placed', null, { timeout: 12000 });
  view = await read();
  assert(await page.locator('#betId').inputValue() !== previousBet, 'Place bet did not write a fresh bet ID');
  assert(await page.locator('#profileId').innerText() !== 'n/a' && await page.locator('#rewardId').innerText() !== 'n/a', 'Place bet did not create profile/reward');
  assert(view.startShown && !view.stopShown && view.placeDisabled && view.placeText === 'Bet placed', 'Placed state controls wrong');
  assert(await page.locator('#playerSlip [data-stake]').first().isDisabled(), 'Chips must lock after the bet');
  assert(view.raw.eligible === true && view.raw.combined_odds, 'Server eligibility result missing');
  assert(Number(view.oddsNew) === Math.round(Number(view.raw.combined_odds) * 100) / 100, `Odds box ${view.oddsNew} is not the server combined odds ${view.raw.combined_odds}`);
  await assertNoMax('placed');
  await page.screenshot({ path: `${shots}slip-2-placed-desktop.png`, fullPage: false });

  // 4. Start the boost ride from the slip: the slip becomes the full-slip comet stage, same ride state as the console.
  await page.locator('#playerSlip [data-s="start"]').click();
  await page.waitForFunction(() => ride.samples.length >= 3 && ride.phase === 'running', null, { timeout: 8000 });
  await page.waitForTimeout(300);
  view = await read();
  const live = await page.evaluate(() => ({ last: ride.samples.at(-1), console: document.getElementById('rideCurrentBoost').textContent }));
  assert(view.state === 'running' && view.stageShown && view.stageView === 'ride' && view.panelStage === 'ride' && !view.sheetShown, `Stage not shown while riding: ${JSON.stringify({ s: view.stageShown, v: view.stageView, p: view.panelStage, sheet: view.sheetShown })}`);
  assert(view.stopShown && !view.startShown && !view.backShown, 'Stage shows Stop only');
  assert(await page.evaluate(() => document.activeElement && document.activeElement.dataset.s === 'stop'), 'Focus did not move to the stage Stop button');
  assert(view.stagePct === `+${live.console}`, `Stage % ${view.stagePct} differs from the console ${live.console}`);
  await assertNoMax('stage early');
  assert(view.raw.theoretical_max_boost_pct == null && !view.raw.ride_path, 'Live response must not reveal the ride maximum or path');
  assert(view.stageOddsOld !== null && Number(view.stageOddsNew) >= Number(view.stageOddsOld), 'Stage live boosted odds missing');
  assert(/\d/.test(view.stageRetNew) && view.stageRetOld !== null, `Stage potential return missing: ${view.stageRetOld} -> ${view.stageRetNew}`);
  assert(view.srLive === 'polite' && /^Boost \+\d/.test(view.srText), `Live % must be announced in an aria-live region: ${view.srText}`);
  assert(await page.locator('#startRide').isDisabled(), 'Console start must be disabled while the slip ride runs');
  assert(await page.locator('#rideSamples circle').count() >= 3, 'Console chart should show the same observations');
  const pxEarly = await canvasInfo();
  assert(pxEarly.w === Math.round(pxEarly.cssW * pxEarly.dpr) && pxEarly.cssW > 300 && pxEarly.cssH > 500, `Canvas size ${JSON.stringify(pxEarly)}`);
  assert(pxEarly.bright >= 30, `Canvas looks blank: ${JSON.stringify(pxEarly)}`);
  assert(await rafDelta(500) >= 10, 'The comet loop should run while the stage is visible');
  assert(view.soundPressed === 'false' && await page.evaluate(() => localStorage.getItem('demoRideSound')) === null && await page.evaluate(() => window.__ac) === 0, 'Sound must be muted and silent before any tap');
  await page.screenshot({ path: `${shots}slip-3-stage-early-desktop.png`, fullPage: false });
  const stageText = { desktop: await assertStageText('desktop 400px panel') };
  await page.waitForTimeout(1200);
  const mid = await page.evaluate(() => ({ n: ride.samples.length, phase: ride.phase }));
  assert(mid.phase === 'running' && mid.n > 3, `Ride should still be running mid-way: ${JSON.stringify(mid)}`);
  await assertNoMax('stage mid');
  assert(knownMaxPct !== null, 'The console effective max was not available to compare against');
  await page.screenshot({ path: `${shots}slip-3-stage-mid-desktop.png`, fullPage: false });
  // Sound toggle: remembered, and the first AudioContext appears only after the tap.
  await page.locator('#playerSlip [data-s="sound"]').click();
  assert((await read()).soundPressed === 'true' && await page.evaluate(() => localStorage.getItem('demoRideSound')) === '1', 'Sound toggle did not turn on / persist');
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => window.__ac) === 1, 'Audio should start only after the tap');
  await page.locator('#playerSlip [data-s="sound"]').click();
  assert((await read()).soundPressed === 'false' && await page.evaluate(() => localStorage.getItem('demoRideSound')) === '0', 'Sound toggle did not turn off');

  // 5. Stop to lock: result moment on the stage (server values, old -> new), then the normal slip with the locked card.
  const lockClickedAt = Date.now();
  await page.locator('#playerSlip [data-s="stop"]').click();
  await page.waitForFunction(() => ride.phase === 'locked' && document.getElementById('playerSlip').dataset.stage === 'result', null, { timeout: 8000 });
  await page.waitForTimeout(550);
  view = await read();
  const lockRaw = view.raw;
  assert(lockRaw.lock_id && typeof lockRaw.locked_boost_pct === 'number', 'Lock response missing');
  assert(view.stageView === 'result' && view.backShown && !view.stopShown && !view.sheetShown, 'Result moment controls wrong');
  assert(view.resultTitle === `+${(lockRaw.locked_boost_pct * 100).toFixed(2)}% locked`, `Result title ${view.resultTitle}`);
  assert(view.stageOddsOld !== null && Number(view.stageOddsNew) > Number(view.stageOddsOld), `Result odds ${view.stageOddsOld} -> ${view.stageOddsNew}`);
  assert(/locked/.test(view.srText), `Result not announced: ${view.srText}`);
  await assertNoMax('stage locked');
  await page.screenshot({ path: `${shots}slip-4-stage-locked-desktop.png`, fullPage: false });
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.stage, null, { timeout: 6000 });
  const resultMs = Date.now() - lockClickedAt;
  assert(resultMs >= 2500, `Result moment lasted only ${resultMs} ms`);
  assert(await rafDelta(500) === 0, 'The comet loop must stop once the stage is gone');
  await page.waitForTimeout(500);
  view = await read();
  assert(view.state === 'locked' && !view.stageShown && view.sheetShown, 'Normal slip did not return with the locked card');
  assert(view.lockedPct === `+${(lockRaw.locked_boost_pct * 100).toFixed(2)}% locked`, `Locked text ${view.lockedPct}`);
  const stake = 20; const odds = Number(lockRaw.qualifying_odds);
  const cap = 500; const bonus = Math.min(stake * odds * lockRaw.locked_boost_pct, cap);
  const expectedOdds = (stake * odds + bonus) / stake;
  assert(Math.abs(Number(view.oddsNew) - expectedOdds) <= 0.011, `Boosted odds ${view.oddsNew} vs ${expectedOdds}`);
  assert(Number(view.oddsOld) === Math.round(odds * 100) / 100 || Math.abs(Number(view.oddsOld) - odds) <= 0.011, `Old odds ${view.oddsOld} vs ${odds}`);
  assert(Math.abs(moneyNumber(view.retNew) - (stake * odds + bonus)) <= 0.011 && Math.abs(moneyNumber(view.retOld) - stake * odds) <= 0.011, `Return ${view.retOld} -> ${view.retNew}`);
  assert(await page.locator('#rideFinalBoost').innerText() === `${(lockRaw.locked_boost_pct * 100).toFixed(2)}%`, 'Console final differs from slip');
  assert(!view.stopShown && !view.placeDisabled && view.placeText === 'Place new bet', 'Locked state controls wrong');
  await page.screenshot({ path: `${shots}slip-4-locked-desktop.png`, fullPage: false });
  const lockedResult = { boost: lockRaw.locked_boost_pct, oddsOld: view.oddsOld, oddsNew: view.oddsNew, retOld: view.retOld, retNew: view.retNew, resultMs };

  // 6. A new bet after a final ride starts clean; the ride then crashes (intercepted terminal quote fixture).
  await page.route('**/api/boost/quote', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    eligible: false, reason_code: 'RIDE_CRASHED', qualifying_selection_count: 5, total_selection_count: 7, combined_odds: 22.3, current_boost_pct: 0, ride_elapsed_seconds: 3.2,
  }) }));
  await page.locator('#playerSlip [data-s="place"]').click();
  await page.waitForFunction(() => document.querySelector('#playerSlip [data-s="boost"]').dataset.state === 'placed', null, { timeout: 12000 });
  assert((await read()).startShown, 'New bet did not reset to the placed state');
  await page.locator('#playerSlip [data-s="start"]').click();
  await page.waitForFunction(() => ride.phase === 'crashed', null, { timeout: 8000 });
  await page.waitForTimeout(450);
  view = await read();
  assert(view.stageView === 'result' && view.stageShown && view.resultTitle === 'No boost this time' && view.stageOddsOld === null && view.stageRetOld === null, `Crash moment should show no boost and unchanged odds: ${JSON.stringify({ v: view.stageView, t: view.resultTitle, o: view.stageOddsOld })}`);
  assert(view.backShown && !view.stopShown, 'Crash moment: Back to slip only');
  await page.screenshot({ path: `${shots}slip-5-stage-crashed-desktop.png`, fullPage: false });
  await page.locator('#playerSlip [data-s="back"]').click();
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.stage);
  view = await read();
  assert(view.state === 'crashed' && view.title === 'No boost this time' && view.oddsOld === null && view.retOld === null && view.sheetShown, 'Crashed card should show no boost and unchanged odds');
  assert(!view.stopShown && !view.startShown, 'Crashed state shows no ride buttons');
  await page.screenshot({ path: `${shots}slip-5-crashed-desktop.png`, fullPage: false });
  await page.unroute('**/api/boost/quote');

  // 7. Reduced motion: no running CSS animations on the slip (the stage is checked with a real ride below).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert(await page.evaluate(() => [...document.querySelectorAll('#playerSlip *')].every((n) => getComputedStyle(n).animationName === 'none')), 'Animations still run with reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // 8. Mobile 390 / 375: full width from the top, nothing clipped; replay each state shot at 390.
  const mobile = {};
  for (const width of [390, 375]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(450); // the slide-in restarts when the breakpoint switches direction
    const m = await read();
    assert(m.panel.width === width && m.panel.top === 0 && m.docWidth <= width, `Mobile slip geometry at ${width}: ${JSON.stringify(m.panel)} doc ${m.docWidth}`);
    const clipped = await page.evaluate(() => [...document.querySelectorAll('#playerSlip *')].filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > innerWidth + 0.5).map((n) => n.className || n.tagName));
    assert(clipped.length === 0, `Clipped at ${width}: ${clipped.join(',')}`);
    mobile[width] = 'ok';
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  const mobileState = async (name) => {
    await page.evaluate(() => { document.getElementById('playerSlip').scrollTop = 0; });
    const boostBox = await page.locator('#playerSlip .slip-boost').boundingBox();
    await page.evaluate((top) => { document.getElementById('playerSlip').scrollTop = Math.max(0, top - 120); }, boostBox.y + await page.evaluate(() => document.getElementById('playerSlip').scrollTop));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${shots}slip-${name}-390.png`, fullPage: false });
  };
  await mobileState('5-crashed');
  // Re-run quick lock and live on mobile through the real server.
  await page.unroute('**/api/boost/quote').catch(() => {});
  await page.locator('#playerSlip [data-s="place"]').click();
  await page.waitForFunction(() => document.querySelector('#playerSlip [data-s="boost"]').dataset.state === 'placed', null, { timeout: 12000 });
  await mobileState('2-placed');
  await page.locator('#playerSlip [data-s="start"]').click();
  await page.waitForFunction(() => ride.samples.length >= 3 && ride.phase === 'running' && document.getElementById('playerSlip').dataset.stage === 'ride', null, { timeout: 8000 });
  const stageGeometry = () => page.evaluate(() => {
    const panel = document.getElementById('playerSlip');
    const stop = panel.querySelector('[data-s="stop"]').getBoundingClientRect();
    const arena = panel.querySelector('[data-s="arena"]').getBoundingClientRect();
    const pct = panel.querySelector('[data-s="livePct"]').getBoundingClientRect();
    const clipped = [...panel.querySelectorAll('.slip-stage *')].filter((n) => n.getClientRects().length && n.tagName !== 'CANVAS' && (n.getBoundingClientRect().right > innerWidth + 0.5 || n.getBoundingClientRect().left < -0.5)).map((n) => n.className || n.tagName);
    return { stopBottom: stop.bottom, stopTop: stop.top, arenaH: arena.height, pctTop: pct.top, pctBottom: pct.bottom, scrollH: panel.scrollHeight, clientH: panel.clientHeight, innerHeight, clipped, panelW: panel.getBoundingClientRect().width };
  });
  await page.waitForTimeout(300);
  let geo = await stageGeometry();
  assert(geo.panelW === 390 && geo.stopBottom <= geo.innerHeight && geo.arenaH >= 150 && geo.scrollH <= geo.clientH + 1 && geo.clipped.length === 0 && geo.pctBottom < geo.stopTop, `Mobile stage geometry: ${JSON.stringify(geo)}`);
  const mobileCanvas = await canvasInfo();
  assert(mobileCanvas.cssW === 390 && mobileCanvas.bright >= 30, `Mobile canvas: ${JSON.stringify(mobileCanvas)}`);
  stageText[390] = await assertStageText('390');
  await page.setViewportSize({ width: 375, height: 844 });
  await page.waitForTimeout(120);
  stageText[375] = await assertStageText('375');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${shots}slip-3-stage-early-390.png`, fullPage: false });
  await page.waitForTimeout(600);
  await assertNoMax('mobile stage');
  assert(await page.evaluate(() => ride.phase) === 'running', 'Mobile ride ended before the mid shot');
  await page.screenshot({ path: `${shots}slip-3-stage-mid-390.png`, fullPage: false });
  await page.locator('#playerSlip [data-s="stop"]').click();
  await page.waitForFunction(() => ride.phase === 'locked' && document.getElementById('playerSlip').dataset.stage === 'result', null, { timeout: 8000 });
  await page.waitForTimeout(550);
  geo = await stageGeometry();
  assert(geo.clipped.length === 0 && geo.scrollH <= geo.clientH + 1, `Mobile result geometry: ${JSON.stringify(geo)}`);
  await page.screenshot({ path: `${shots}slip-4-stage-locked-390.png`, fullPage: false });
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.stage, null, { timeout: 6000 });
  await page.waitForTimeout(500);
  await mobileState('4-locked');
  await page.evaluate(() => { document.getElementById('playerSlip').scrollTop = 0; });
  await page.screenshot({ path: `${shots}slip-1-top-390.png`, fullPage: false });

  // Reduced motion with a real ride: static comet and numbers, no animation frames, no flashing, still usable.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#playerSlip [data-s="place"]').click();
  await page.waitForFunction(() => document.querySelector('#playerSlip [data-s="boost"]').dataset.state === 'placed', null, { timeout: 12000 });
  await page.locator('#playerSlip [data-s="start"]').click();
  await page.waitForFunction(() => ride.samples.length >= 4 && ride.phase === 'running' && document.getElementById('playerSlip').dataset.stage === 'ride', null, { timeout: 8000 });
  await page.waitForTimeout(400);
  assert(await rafDelta(700) === 0, 'Reduced motion: the comet must not run an animation loop');
  const reducedCanvas = await canvasInfo();
  assert(reducedCanvas.bright >= 30, `Reduced-motion canvas should still show a static comet: ${JSON.stringify(reducedCanvas)}`);
  assert(await page.evaluate(() => [...document.querySelectorAll('#playerSlip *')].every((n) => getComputedStyle(n).animationName === 'none')), 'Animations run on the reduced-motion stage');
  view = await read();
  assert(view.stageShown && /^\+\d/.test(view.stagePct) && view.stopShown, 'Reduced-motion stage must still show the numbers and Stop');
  await page.screenshot({ path: `${shots}slip-6-stage-reduced-390.png`, fullPage: false });
  await page.locator('#playerSlip [data-s="stop"]').click();
  await page.waitForFunction(() => ride.phase === 'locked' && document.getElementById('playerSlip').dataset.stage === 'result', null, { timeout: 8000 });
  await page.waitForTimeout(450);
  assert(await rafDelta(500) === 0, 'Reduced motion: no animation frames in the result moment');
  await page.screenshot({ path: `${shots}slip-6-stage-reduced-locked-390.png`, fullPage: false });
  await page.locator('#playerSlip [data-s="back"]').click();
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.stage);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.locator('#slipClose').click();
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.open);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => localStorage.removeItem('demoRideSound'));

  // 9. Without brand assets nothing is requested from brand/ (no console error); with ?brand=1 the files load.
  assert(!failedResponses.some((entry) => entry.includes('/brand/')), `Brand probe produced errors: ${failedResponses.join(' | ')}`);
  const unexpected = consoleErrors.filter((entry) => !/^Failed to load resource/.test(entry));
  assert(unexpected.length === 0, `Console errors: ${unexpected.join(' | ')}`);
  const brandRequests = [];
  await page.route('**/demo/brand/*', (route) => {
    const url = route.request().url();
    brandRequests.push(url);
    if (url.endsWith('brand.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: '.player-slip { --slip-green: #ff00aa; }' });
    if (url.endsWith('logo.svg')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><rect width="80" height="20" fill="#ff00aa"/></svg>' });
    return route.fulfill({ status: 404, body: 'missing' });
  });
  await page.goto('http://127.0.0.1:4318/demo/?brand=1');
  await page.getByRole('button', { name: 'Player view', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#playerSlip .slip-logo').hidden, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const brand = await page.evaluate(() => ({ green: getComputedStyle(document.getElementById('playerSlip')).getPropertyValue('--slip-green').trim(), logoWidth: document.querySelector('#playerSlip .slip-logo').getBoundingClientRect().width }));
  assert(brand.green === '#ff00aa' && brand.logoWidth > 0, `Brand assets did not apply: ${JSON.stringify(brand)}`);
  await page.screenshot({ path: `${shots}slip-6-branded-fixture-desktop.png`, fullPage: false });
  await page.unroute('**/demo/brand/*');
  await page.goto('http://127.0.0.1:4318/demo/?brand=0');
  assert(await page.evaluate(() => localStorage.getItem('demoBrand')) === null, 'brand=0 did not forget the flag');

  return { lockedResult, stageText, mobile, brandRequests, consoleErrors };
}
