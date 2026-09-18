async (page) => {
  // Deterministic HTTP fixtures exercise UI concurrency, not backend math.
  const assert = (value, message) => { if (!value) throw new Error(message); };
  let quoteIndex = 0, rewardIndex = 0, active = 0, maxActive = 0, quoteBehavior, lockBehavior, optInBehavior;
  const quote = (seconds, boost) => ({ eligible: true, current_boost_pct: boost, ride_elapsed_seconds: seconds });
  const locked = (seconds = 0.45) => ({ lock_id: 'lock', locked_boost_pct: 0.123456, ride_stop_at_offset_seconds: seconds, theoretical_max_boost_pct: 0.5, maximum_model: 'WAVES_PRE_CRASH_SUPREMUM_V2', ride_path: [{ timePct: 0, baseBoostValue: 0.05 }, { timePct: 1, baseBoostValue: 0 }] });
  await page.unroute('**/api/**');
  await page.route('**/api/**', async route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '');
    const reply = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/profiles') return reply({ id: 'profile' });
    if (path === '/api/rewards') return reply({ id: `reward-${++rewardIndex}` });
    if (path.endsWith('/eligibility')) return reply({ eligible: true, reason_code: 'ELIGIBLE' });
    if (path.endsWith('/opt-in')) { quoteIndex = 0; return optInBehavior ? optInBehavior(route, reply) : reply({ status: 'ENTERED' }); }
    if (path === '/api/boost/lock') return lockBehavior ? lockBehavior(route, reply) : reply(locked());
    if (path === '/api/boost/quote') {
      const index = ++quoteIndex;
      active++; maxActive = Math.max(active, maxActive);
      try { await quoteBehavior(index, route, reply); } finally { active--; }
      return;
    }
    throw new Error(`Unexpected API path: ${path}`);
  });
  const count = () => page.locator('#rideSamples circle').count();
  const ready = async (auto = false) => {
    await page.reload();
    await page.evaluate(label => document.title = label, `Fixture ${++readyCount}`);
    if (!auto) await page.getByRole('button', { name: 'Auto Quote (ON)', exact: true }).click();
    await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
    await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('startRide').disabled);
    await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#rideSamples circle').length === 1);
    await page.waitForFunction(() => !document.getElementById('quoteOnce').disabled);
  };
  const manual = async () => {
    await page.getByRole('button', { name: 'Get Quote', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('quoteOnce').disabled || document.getElementById('rideOutcomeBox').style.display === 'block');
  };
  const report = [];
  let readyCount = 0;

  quoteBehavior = async (i, route, reply) => {
    if (i === 2) { await page.waitForTimeout(1200); return reply(quote(0.3, 0.9)); }
    return reply(quote(0.1, 0.1));
  };
  await ready();
  await page.getByRole('button', { name: 'Get Quote', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('quoteOnce').disabled);
  await page.getByRole('button', { name: 'Stop Ride (Lock)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
  assert(await page.locator('#rideFinalBoost').textContent() === '12.35%', 'Exact lock final not shown');
  assert(await page.locator('#rideMaximumLabel').textContent() === 'Ride maximum', 'New-model maximum label missing');
  const frozenPath = await page.locator('#ridePathLine').getAttribute('d');
  await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(document.getElementById('responseBox').textContent).reason_code === 'ELIGIBLE');
  assert(await page.locator('#ridePathLine').getAttribute('d') === frozenPath, 'Generic response erased final path');
  await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('startRide').disabled);
  const start = Date.now();
  await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'none' && document.querySelectorAll('#rideSamples circle').length === 1);
  assert(Date.now() - start < 800, 'New initial quote blocked by old request');
  await page.waitForTimeout(1300);
  assert(await count() === 1, 'Old quote contaminated new ride');
  assert(await page.locator('#rideCurrentBoost').textContent() === '10.00%', 'Old response overwrote current');
  report.push('delayed quote ignored across lock, raw precheck and immediate new ride; fresh quote under800ms');

  quoteBehavior = async (i, route, reply) => i === 2 ? route.abort('failed') : reply(quote(i * 0.2, i * 0.1));
  await ready(); await manual();
  assert((await page.locator('#rideSummary').textContent()).includes('Gap retained'), 'Network failure not visible');
  await manual();
  assert(await count() === 2, 'Network gap invented observations');
  assert((await page.locator('#ridePathLine').getAttribute('d')).match(/M/g).length === 2, 'Gap joined by a line');
  report.push('network failure preserved samples and disconnected next observation');

  quoteBehavior = async (i, route, reply) => reply(quote(i === 3 ? 0.1 : i * 0.2, i * 0.1));
  await ready(); await manual(); await manual();
  assert(await count() === 2, 'Out-of-order quote appended');
  assert(await page.locator('#rideCurrentBoost').textContent() === '20.00%', 'Out-of-order quote changed current');
  report.push('out-of-order time rejected');

  for (const code of ['RIDE_CRASHED', 'RIDE_ENDED']) {
    quoteBehavior = async (i, route, reply) => reply(i < 3 ? quote(i * 0.2, i * 0.1) : { eligible: false, reason_code: code, current_boost_pct: 0, ride_elapsed_seconds: 0.65, ride_path: [{ timePct: 1, baseBoostValue: 999 }] });
    await ready(); await manual(); await manual();
    assert(await count() === 3, 'Terminal full path replaced observed history');
    assert(await page.locator('#rideCurrentBoost').textContent() === '0.00%', 'Terminal zero missing');
    assert(await page.locator('#rideFinalLabel').textContent() === (code === 'RIDE_CRASHED' ? 'Crashed boost' : 'Ended boost'), 'Terminal status confused');
    assert(await page.locator('#rideMaximumLabel').textContent() === 'Reference maximum (legacy)', 'Legacy label missing');
    assert((await page.locator('#responseBox').textContent()).includes('999'), 'Raw terminal path removed');
    report.push(`${code}: exact observed zero, distinct final, raw path retained`);
  }

  quoteBehavior = async (i, route, reply) => { await page.waitForTimeout(300); return reply(quote(i * 0.2, 0.1)); };
  maxActive = 0; active = 0;
  await ready(true);
  await page.waitForFunction(() => document.querySelectorAll('#rideSamples circle').length >= 3);
  await page.getByRole('button', { name: 'Auto Quote (ON)', exact: true }).click();
  await page.waitForTimeout(400);
  assert(maxActive === 1, `Quote requests overlapped: ${maxActive}`);
  report.push('automatic polling serialized at300ms response latency');

  let attempts = 0;
  lockBehavior = async (route, reply) => ++attempts === 1 ? route.abort('failed') : reply(locked(0.9));
  quoteBehavior = async (i, route, reply) => reply(quote(0.1, 0.1));
  await ready();
  await page.getByRole('button', { name: 'Stop Ride (Lock)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('lockBoost').textContent === 'Retry Stop (Lock)');
  assert(await page.locator('#quoteOnce').isDisabled(), 'Ambiguous lock permits quotes');
  await page.getByRole('button', { name: 'Retry Stop (Lock)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
  assert(await page.locator('#rideFinalLabel').textContent() === 'Locked boost', 'Idempotent lock retry not recovered');
  report.push('ambiguous lock pauses observations and retry recovers');
  lockBehavior = async (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'RIDE_CRASHED', details: { ride_elapsed_seconds: 0.6, current_boost_pct: 0 } }) });
  await ready();
  await page.getByRole('button', { name: 'Stop Ride (Lock)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
  assert(await page.locator('#rideFinalLabel').textContent() === 'Crashed boost', 'Terminal lock error did not reconcile');
  report.push('terminal lock rejection appends observed zero');

  quoteBehavior = async (i, route, reply) => reply({ eligible: false, reason_code: 'MIN_SELECTIONS_NOT_MET', current_boost_pct: null, effective_min_boost_pct: null, effective_max_boost_pct: null, boost_model: null });
  await page.reload();
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
  await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('startRide').disabled);
  await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideSummary').textContent.includes('MIN_SELECTIONS_NOT_MET'));
  assert(await count() === 0, 'Ineligible quote plotted a zero');
  assert(await page.locator('#rideCurrentBoost').textContent() === 'n/a', 'Null current became zero');
  assert(await page.locator('#modelEffectiveMax').textContent() === 'n/a', 'Null effective cap became zero');
  report.push('null/ineligible response displays n/a without a point');
  optInBehavior = async route => route.abort('failed');
  quoteBehavior = async (i, route, reply) => reply(quote(0.5, 0.2));
  await ready();
  assert((await page.locator('#rideSummary').textContent()).includes('recovered'), 'Lost opt-in response was not recovered');
  assert(await count() === 1, 'Opt-in recovery invented earlier observations');
  report.push('lost opt-in response recovered only from confirmed authoritative quote');
  await page.unroute('**/api/**');
  return report;
}
