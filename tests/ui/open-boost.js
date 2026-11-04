async (page) => {
  // Run via playwright-cli run-code --filename after a fresh snapshot (isolated server on 127.0.0.1:4318).
  // UI-6 open boosts: an "Open to all players" profile, player groups and match timing in the console, the slip's
  // "qualifies" line from POST /api/boost/offers, Place bet without a grant, "Use boost" (open-opt-in, with a lost
  // response recovered by the 409), the ride and the lock, plus the "Kick-off passed" refusal and mobile geometry.
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const shots = 'output/playwright/two-block/';
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Refusals (422), the repeat click (409), the injected 500 and the aborted response log browser network lines on purpose.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => {
    if (r.url().includes('/api/')) {
      let body = null;
      try { body = r.postData() ? JSON.parse(r.postData()) : null; } catch (e) { body = null; }
      requests.push({ method: r.method(), path: new URL(r.url()).pathname, body });
    }
  });
  const optInStatuses = [];
  page.on('response', (r) => { if (r.url().endsWith('/api/boost/open-opt-in')) optInStatuses.push(r.status()); });
  const calls = (path, method = 'POST') => requests.filter((r) => r.method === method && r.path === path);
  await page.unroute('**/api/**');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { localStorage.removeItem('demoBrand'); });
  await page.reload();
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('demo-ui-test-key');
  await page.locator('#brandId').fill('openbrand');
  await page.locator('#brandId').dispatchEvent('change');
  const slipText = () => page.locator('#playerSlip [data-s="boost"]').innerText();
  const offerLine = () => page.evaluate(() => {
    const n = document.querySelector('#playerSlip [data-s="offer"]');
    return n && !n.hidden && n.getClientRects().length ? { text: n.textContent, state: n.dataset.state } : null;
  });
  const waitOffer = (pattern, timeout = 6000) => page.waitForFunction((source) => {
    const n = document.querySelector('#playerSlip [data-s="offer"]');
    return n && !n.hidden && n.getClientRects().length > 0 && new RegExp(source).test(n.textContent);
  }, pattern, { timeout });
  const noSizeClaim = async (label) => {
    const text = await slipText();
    assert(!/max|cap|ceiling|up to/i.test(text), `${label}: the slip must not show a maximum or cap: ${text}`);
  };
  const noOverflow = async (label) => {
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById('playerSlip').getBoundingClientRect();
      const wide = [...document.querySelectorAll('#playerSlip [data-s="boost"] *')].filter((n) => !n.closest('.slip-burst') && n.getClientRects().length && n.scrollWidth > n.clientWidth + 1).map((n) => n.className || n.tagName);
      return { docWidth: document.documentElement.scrollWidth, innerWidth, left: panel.left, right: panel.right, wide };
    });
    assert(geometry.docWidth <= geometry.innerWidth + 1, `${label}: horizontal overflow ${JSON.stringify(geometry)}`);
    assert(geometry.left >= -1 && geometry.right <= geometry.innerWidth + 1, `${label}: slip outside the viewport ${JSON.stringify(geometry)}`);
    assert(geometry.wide.length === 0, `${label}: clipped boost text ${JSON.stringify(geometry)}`);
  };

  // 1. Profile form: Availability select (Personal default), sent on create, shown in the picker and when picked again.
  const availability = await page.evaluate(() => ({
    value: document.getElementById('availability').value,
    options: [...document.querySelectorAll('#availability option')].map((o) => `${o.value}|${o.textContent}`),
  }));
  assert(availability.value === 'PERSONAL' && availability.options.join(';') === 'PERSONAL|Personal (granted in advance);OPEN|Open to all players', `Availability select wrong: ${JSON.stringify(availability)}`);
  await page.locator('#profileName').fill('Open Demo');
  await page.locator('#minSelections').fill('3');
  await page.locator('#minCombinedOdds').fill('3');
  await page.locator('#minSelectionOdds').fill('1.2');
  await page.locator('#availability').selectOption('OPEN');
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('profileId').textContent !== 'n/a');
  const profileId = await page.locator('#profileId').textContent();
  assert(calls('/api/profiles').at(-1).body.availability === 'OPEN', 'Create did not send availability OPEN');
  await page.waitForFunction((n) => document.getElementById('savedProfile').selectedOptions[0]?.textContent.startsWith(n), 'Open Demo');
  const label = await page.evaluate(() => document.getElementById('savedProfile').selectedOptions[0].textContent);
  assert(label.includes('open to all'), `Picker label does not show availability: ${label}`);
  await page.locator('#availability').selectOption('PERSONAL');
  await page.locator('#savedProfile').selectOption('');
  await page.locator('#savedProfile').selectOption(profileId);
  assert(await page.locator('#availability').inputValue() === 'OPEN', 'Picking the open profile did not fill Availability');
  await page.locator('#profileSetup').screenshot({ path: `${shots}open-boost-profile-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const form390 = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const cell = (id) => { const r = document.getElementById(id).closest('.field').getBoundingClientRect(); return { left: r.left, right: r.right }; };
    return { docWidth: document.documentElement.scrollWidth, innerWidth, availability: box('availability'), groups: box('playerGroups'), timing: box('matchTiming'), cell: cell('availability') };
  });
  assert(form390.docWidth <= form390.innerWidth + 1, `Overflow at 390: ${JSON.stringify(form390)}`);
  for (const key of ['availability', 'groups', 'timing']) assert(form390[key].left >= 0 && form390[key].right <= form390.innerWidth, `${key} outside the viewport at 390`);
  assert(form390.availability.width >= 200, `Availability select too narrow at 390: ${form390.availability.width}`);
  await page.locator('#profileSetup').screenshot({ path: `${shots}open-boost-profile-390.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => { const n = document.getElementById('availability'); return n.getBoundingClientRect().width; });
  assert(wide >= 200, `Availability select too narrow on desktop: ${wide}`);

  // 2. Open profile active: note, Grant Reward disabled, the other buttons ready.
  assert(await page.locator('#openBoostNote').isVisible() && (await page.locator('#openBoostNote').textContent()) === 'Open boost: granted when the player uses it', 'Open boost note missing');
  assert(await page.locator('#grantReward').isDisabled(), 'Grant Reward must be disabled for an open profile');
  assert(await page.locator('#precheckEligibility').isEnabled() && await page.locator('#startRide').isEnabled(), 'Check eligibility and Start ride must be ready for an open profile');

  // 3. Player groups and match timing reach the offers call; every selection is timed.
  assert(await page.locator('#playerGroups').inputValue() === '', 'Player groups should be empty for a profile without a group');
  assert(await page.locator('#matchTiming').inputValue() === 'prematch', 'Match timing should default to prematch');
  await page.locator('#playerGroups').fill('VIP, Gold');
  await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideSummary').textContent.startsWith('Qualifies for a boost'));
  let offer = calls('/api/boost/offers').at(-1).body;
  assert(offer.brand_id === 'openbrand' && offer.user_id === 'user-123' && offer.stake_minor === 1000 && offer.currency === 'EUR', `Offers body wrong: ${JSON.stringify(offer)}`);
  assert(JSON.stringify(offer.segments) === '["VIP","Gold"]', `segments wrong: ${JSON.stringify(offer.segments)}`);
  assert(offer.ticket.selections.length >= 3 && offer.ticket.selections.every((s) => /^\d{4}-\d\d-\d\dT.*(Z|[+-]\d\d:\d\d)$/.test(s.starts_at) && s.live === undefined), 'Prematch selections must all carry starts_at with a zone');
  const kickoff = Date.parse(offer.ticket.selections[0].starts_at) - Date.now();
  assert(kickoff > 100 * 60 * 1000 && kickoff < 121 * 60 * 1000, `Prematch kick-off should be about 2 h away: ${kickoff}`);
  await page.locator('#matchTiming').selectOption('live');
  const offersSoFar = calls('/api/boost/offers').length;
  await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
  for (let i = 0; i < 50 && calls('/api/boost/offers').length === offersSoFar; i += 1) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  offer = calls('/api/boost/offers').at(-1).body;
  assert(offer.ticket.selections.every((s) => s.live === true && s.starts_at === undefined), 'Live selections must carry live: true only');
  await page.locator('#matchTiming').selectOption('prematch');
  await page.locator('#playerGroups').fill('');

  // 4. "Kick-off passed": the console check and Start ride show readable refusals; nothing is created.
  await page.locator('#matchTiming').selectOption('passed');
  await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideSummary').textContent.startsWith('Does not qualify'));
  const refusal = await page.locator('#rideSummary').textContent();
  assert(/kicked off/.test(refusal) && !/SELECTION_ALREADY_STARTED/.test(refusal), `Refusal not readable: ${refusal}`);
  const passed = calls('/api/boost/offers').at(-1).body;
  assert(passed.ticket.selections.every((s) => Date.parse(s.starts_at) < Date.now()), 'Kick-off passed must send past starts_at');
  await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
  await page.waitForFunction(() => /kicked off/.test(document.getElementById('rideSummary').textContent) && document.getElementById('rideSummary').dataset.warning === 'true');
  assert((await page.evaluate(() => ride.phase)) === 'idle', 'A refused open opt-in must not start a ride');
  assert(calls('/api/boost/open-opt-in').at(-1).body.profile_version_id === profileId, 'open-opt-in must name the active profile');
  await page.waitForFunction(() => !document.getElementById('startRide').disabled, null, { timeout: 3000 }).catch(() => { throw new Error('Start ride stays available after a refusal'); });
  await page.getByRole('button', { name: 'Player view', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('playerSlip').dataset.open === 'true');
  await page.waitForTimeout(350);
  await waitOffer('kicked off');
  assert((await offerLine()).state === 'no', 'Refusal line should be in the "no" state');
  await noSizeClaim('refusal');
  await page.locator('#matchTiming').selectOption('prematch');

  // 5. Draft slip: "This bet qualifies for a boost" from the offers endpoint; never a maximum or cap.
  await waitOffer('This bet qualifies for a boost');
  assert((await offerLine()).state === 'yes', 'Qualifies line should be in the "yes" state');
  assert(/Use boost/.test(await slipText()), 'Draft copy should point at Use boost');
  await noSizeClaim('draft');
  await page.locator('#playerSlip [data-s="boost"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}open-boost-slip-draft-desktop.png`, fullPage: false });
  // latest response wins: a slow answer for an older slip never overwrites the newer one
  const offersBefore = calls('/api/boost/offers').length;
  await page.locator('#matchTiming').selectOption('passed');
  await page.locator('#matchTiming').selectOption('prematch');
  await page.waitForTimeout(900);
  assert(calls('/api/boost/offers').length - offersBefore <= 1, 'Quick edits should be debounced into at most one offers call');
  assert((await offerLine())?.text === 'This bet qualifies for a boost', 'The newest slip state must win');
  // a failed offers call claims nothing
  await page.route('**/api/boost/offers', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"INTERNAL_ERROR","message":"x"}' }));
  await page.locator('#stake').fill('12.00');
  await page.waitForFunction(() => { const n = document.querySelector('#playerSlip [data-s="offer"]'); return n.hidden; }, null, { timeout: 4000 });
  await page.unroute('**/api/boost/offers');
  await page.locator('#stake').fill('10.00');
  await waitOffer('This bet qualifies for a boost');

  // mobile draft
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  await noOverflow('draft 390');
  await page.locator('#playerSlip [data-s="boost"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}open-boost-slip-draft-390.png`, fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(450);

  // 6. Place bet: no grant call, a fresh bet ID, the placed state with a Use boost button.
  const rewardCallsBefore = calls('/api/rewards').length;
  const bet = await page.locator('#betId').inputValue();
  await page.locator('#playerSlip [data-s="place"]').click();
  await page.waitForFunction(() => document.querySelector('#playerSlip [data-s="boost"]').dataset.state === 'placed', null, { timeout: 8000 });
  assert(calls('/api/rewards').length === rewardCallsBefore && calls('/api/rewards/bulk').length === 0, 'Placing an open bet must not grant a reward');
  const placedBet = await page.locator('#betId').inputValue();
  assert(placedBet !== bet, 'Place bet should write a fresh bet ID');
  const start = page.locator('#playerSlip [data-s="start"]');
  assert(await start.isVisible() && (await start.textContent()) === 'Use boost' && await start.isEnabled(), 'Use boost button missing in the placed state');
  await noSizeClaim('placed');
  await page.locator('#playerSlip [data-s="boost"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}open-boost-slip-placed-desktop.png`, fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  await noOverflow('placed 390');
  await page.locator('#playerSlip [data-s="boost"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}open-boost-slip-placed-390.png`, fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(450);

  // 7. Use boost with a lost response: the server created the ride, the click fails, the repeat recovers via the 409.
  await page.route('**/api/boost/open-opt-in', async (route) => { await route.fetch(); await route.abort(); });
  await start.click();
  await page.waitForFunction(() => document.getElementById('rideSummary').dataset.warning === 'true' && !document.getElementById('startRide').disabled);
  assert((await page.evaluate(() => ride.phase)) === 'idle', 'A lost response must not look like a running ride');
  await page.unroute('**/api/boost/open-opt-in');
  await start.click();
  await page.waitForFunction(() => ride.phase === 'running' && ride.samples.length >= 2, null, { timeout: 9000 });
  const optIns = calls('/api/boost/open-opt-in');
  assert(optIns.length >= 2 && optIns.at(-1).body.bet_id === placedBet && optIns.at(-1).body.profile_version_id === profileId, 'Repeat click must name the same bet and profile');
  assert(optInStatuses.includes(409), `The repeat click should be answered 409 ALREADY_OPTED_IN: ${optInStatuses}`);
  assert(await page.evaluate(() => ride.identity.reward_id === document.getElementById('rewardId').textContent), 'Recovered ride must use the reward named by the 409');
  assert(calls('/api/rewards').length === rewardCallsBefore, 'No reward grant call may happen in the open flow');
  assert(await page.locator('#rewardId').textContent() !== 'n/a', 'Reward ID should show the reward created at the click');

  // 8. The ride runs on the stage and locks (server value), same path as the personal flow.
  await page.waitForFunction(() => document.getElementById('playerSlip').dataset.stage === 'ride', null, { timeout: 4000 });
  await page.locator('#playerSlip [data-s="stop"]').click();
  await page.waitForFunction(() => ride.phase === 'locked', null, { timeout: 8000 });
  assert(await page.locator('#rideFinalLabel').textContent() === 'Locked boost', 'Open-boost ride did not lock');
  await page.waitForTimeout(600);
  assert(/locked/i.test(await page.evaluate(() => document.querySelector('#playerSlip [data-s="resultTitle"]').textContent)), 'Slip should show the locked result');

  // 9. Personal flow still needs a grant: Grant Reward is available again and the label says Personal.
  await page.getByRole('button', { name: 'Player view', exact: true }).click();
  await page.waitForTimeout(350);
  await page.locator('#availability').selectOption('PERSONAL');
  await page.locator('#profileName').fill('Personal Again');
  await page.locator('#minSelections').fill('3');
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('savedProfile').selectedOptions[0]?.textContent.startsWith('Personal Again'));
  assert(await page.locator('#openBoostNote').isHidden() && await page.locator('#grantReward').isEnabled(), 'Personal profile must restore Grant Reward');
  assert((await page.locator('#savedProfile option:checked').textContent()).includes('personal'), 'Picker label should say personal');
  assert(errors.length === 0, `Console/page errors: ${errors.join(' | ')}`);
  return { profileId, optIns: optIns.length, offers: calls('/api/boost/offers').length };
}
