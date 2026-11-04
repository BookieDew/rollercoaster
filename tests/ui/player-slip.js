async (page) => {
  // Run via playwright-cli run-code --filename after a fresh snapshot (isolated server on 127.0.0.1:4318).
  // Covers the Player view slide-out: open/close/focus, legs, Place bet, live ride, lock, and a crashed ride.
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const shots = 'output/playwright/two-block/';
  const consoleErrors = [];
  const failedResponses = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.unroute('**/api/**');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => localStorage.removeItem('demoBrand'));
  await page.reload();
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('demo-ui-test-key');
  const slip = page.locator('#playerSlip');
  const text = (selector) => page.locator(`#playerSlip ${selector}`).first().innerText();
  const read = () => page.evaluate(() => {
    const q = (s) => document.querySelector(`#playerSlip ${s}`);
    const shown = (s) => { const n = q(s); return !!n && !n.hidden && n.getClientRects().length > 0; };
    return {
      state: q('[data-s="boost"]').dataset.state,
      title: q('[data-s="boostTitle"]').textContent,
      livePct: q('[data-s="livePct"]').textContent,
      lockedPct: q('[data-s="lockedPct"]').textContent,
      scaleMax: q('[data-s="scaleMax"]').textContent,
      oddsOld: shown('[data-s="oddsOld"]') ? q('[data-s="oddsOld"]').textContent : null,
      oddsNew: q('[data-s="oddsNew"]').textContent,
      retOld: shown('[data-s="retOld"]') ? q('[data-s="retOld"]').textContent : null,
      retNew: q('[data-s="retNew"]').textContent,
      stake: q('[data-s="stake"]').textContent,
      count: q('[data-s="count"]').textContent,
      placeText: q('[data-s="place"]').textContent,
      placeDisabled: q('[data-s="place"]').disabled,
      startShown: shown('[data-s="start"]'), stopShown: shown('[data-s="stop"]'),
      sparkShown: shown('.slip-spark'), spark: q('[data-s="spark"]').getAttribute('d'),
      note: shown('[data-s="note"]') ? q('[data-s="note"]').textContent : null,
      raw: JSON.parse(document.getElementById('responseBox').textContent),
      docWidth: document.documentElement.scrollWidth, innerWidth,
      panel: (() => { const r = document.getElementById('playerSlip').getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }; })(),
    };
  });
  const moneyNumber = (value) => Number(String(value).replace(/[^\d,]/g, '').replace(',', '.'));

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
  assert(view.state === 'draft' && /up to —/.test(view.scaleMax), 'Draft state / scale wrong');
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
  await page.screenshot({ path: `${shots}slip-2-placed-desktop.png`, fullPage: false });

  // 4. Start the boost ride from the slip: same ride state as the console.
  await page.locator('#playerSlip [data-s="start"]').click();
  await page.waitForFunction(() => ride.samples.length >= 3 && ride.phase === 'running', null, { timeout: 8000 });
  await page.waitForTimeout(300);
  view = await read();
  const live = await page.evaluate(() => ({ last: ride.samples.at(-1), console: document.getElementById('rideCurrentBoost').textContent }));
  assert(view.state === 'running' && view.stopShown && !view.startShown && view.sparkShown && view.spark.startsWith('M'), 'Riding state not shown');
  assert(view.livePct === `+${live.console}`, `Live % ${view.livePct} differs from the console ${live.console}`);
  assert(/^up to \d/.test(view.scaleMax), `Scale max should be the server effective cap: ${view.scaleMax}`);
  assert(view.raw.theoretical_max_boost_pct == null && !view.raw.ride_path, 'Live response must not reveal the ride maximum or path');
  assert(view.oddsOld !== null && Number(view.oddsNew) >= Number(view.oddsOld), 'Live boosted odds missing');
  assert(await page.locator('#startRide').isDisabled(), 'Console start must be disabled while the slip ride runs');
  assert(await page.locator('#rideSamples circle').count() >= 3, 'Console chart should show the same observations');
  await page.screenshot({ path: `${shots}slip-3-riding-desktop.png`, fullPage: false });

  // 5. Stop to lock: server values drive the struck-old -> new odds and return.
  await page.locator('#playerSlip [data-s="stop"]').click();
  await page.waitForFunction(() => ride.phase === 'locked' && document.querySelector('#playerSlip [data-s="boost"]').dataset.state === 'locked', null, { timeout: 8000 });
  await page.waitForTimeout(500);
  view = await read();
  const lockRaw = view.raw;
  assert(lockRaw.lock_id && typeof lockRaw.locked_boost_pct === 'number', 'Lock response missing');
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
  const lockedResult = { boost: lockRaw.locked_boost_pct, oddsOld: view.oddsOld, oddsNew: view.oddsNew, retOld: view.retOld, retNew: view.retNew };

  // 6. A new bet after a final ride starts clean; the ride then crashes (intercepted terminal quote fixture).
  await page.route('**/api/boost/quote', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    eligible: false, reason_code: 'RIDE_CRASHED', qualifying_selection_count: 5, total_selection_count: 7, combined_odds: 22.3, current_boost_pct: 0, ride_elapsed_seconds: 3.2,
  }) }));
  await page.locator('#playerSlip [data-s="place"]').click();
  await page.waitForFunction(() => document.querySelector('#playerSlip [data-s="boost"]').dataset.state === 'placed', null, { timeout: 12000 });
  assert((await read()).startShown, 'New bet did not reset to the placed state');
  await page.locator('#playerSlip [data-s="start"]').click();
  await page.waitForFunction(() => ride.phase === 'crashed', null, { timeout: 8000 });
  await page.waitForTimeout(300);
  view = await read();
  assert(view.state === 'crashed' && view.title === 'No boost this time' && view.oddsOld === null && view.retOld === null, 'Crashed state should show no boost and unchanged odds');
  assert(!view.stopShown && !view.startShown, 'Crashed state shows no ride buttons');
  await page.screenshot({ path: `${shots}slip-5-crashed-desktop.png`, fullPage: false });
  await page.unroute('**/api/boost/quote');

  // 7. Reduced motion: no running animations on the slip.
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
  await page.waitForFunction(() => ride.samples.length >= 3 && ride.phase === 'running', null, { timeout: 8000 });
  await mobileState('3-riding');
  await page.locator('#playerSlip [data-s="stop"]').click();
  await page.waitForFunction(() => ride.phase === 'locked', null, { timeout: 8000 });
  await page.waitForTimeout(500);
  await mobileState('4-locked');
  await page.evaluate(() => { document.getElementById('playerSlip').scrollTop = 0; });
  await page.screenshot({ path: `${shots}slip-1-top-390.png`, fullPage: false });
  await page.locator('#slipClose').click();
  await page.waitForFunction(() => !document.getElementById('playerSlip').dataset.open);
  await page.setViewportSize({ width: 1440, height: 1000 });

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

  return { lockedResult, mobile, brandRequests, consoleErrors };
}
