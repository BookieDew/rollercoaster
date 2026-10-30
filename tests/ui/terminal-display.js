async (page) => {
  // Controlled HTTP responses verify display authority and freshness, not server math.
  const assert = (value, message) => { if (!value) throw new Error(message); };
  let pendingQuote, attempts = 0, reward = 0, legacy = false;
  const replay = { ride_end_at_offset_seconds: 8, ride_crash_at_offset_seconds: 6, ride_path: [{timePct:0,baseBoostValue:.1},{timePct:.3,baseBoostValue:.3},{timePct:.8,baseBoostValue:0},{timePct:1,baseBoostValue:0}] };
  const pending = async () => {
    const deadline = Date.now() + 5000;
    while (!pendingQuote && Date.now() < deadline) await page.waitForTimeout(10);
    assert(pendingQuote, 'No quote request pending');
    const route = pendingQuote; pendingQuote = null; return route;
  };
  const advance = async (seconds, boost, count) => {
    const route = await pending();
    await route.fulfill({contentType:'application/json',body:JSON.stringify({...replay,eligible:true,ride_elapsed_seconds:seconds,current_boost_pct:boost})});
    await page.waitForFunction(count => document.querySelectorAll('#rideSamples circle').length === count, count);
  };
  const direction = () => page.locator('#rideDirection').getAttribute('data-direction');
  const noReveal = async () => assert(await page.locator('#fullRidePath').getAttribute('d') === '' && await page.evaluate(() => ride.finalDisplay === null), 'Unaccepted full path revealed');
  await page.unroute('**/api/**');
  await page.route('**/api/**', async route => {
    const url = route.request().url();
    const reply = value => route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if (url.endsWith('/api/profiles')) return reply({id:'profile'});
    if (url.endsWith('/api/rewards')) return reply({id:`reward-${++reward}`});
    if (url.endsWith('/opt-in')) return reply({status:'ENTERED'});
    if (url.endsWith('/api/boost/quote')) { pendingQuote = route; return; }
    if (url.endsWith('/api/boost/lock')) {
      attempts++;
      if (attempts === 1) return route.abort('failed');
      const data = {...replay,...route.request().postDataJSON(),lock_id:'lock',locked_boost_pct:.123456,ride_stop_at_offset_seconds:2.1,theoretical_max_boost_pct:.45,maximum_model:'PRE_CRASH_SUPREMUM_V4'};
      if (attempts === 2) data.reward_id = 'different-reward';
      if (legacy) delete data.ride_end_at_offset_seconds;
      return reply(data);
    }
    throw new Error(`Unexpected route ${url}`);
  });
  try {
    await page.reload(); await page.setViewportSize({width:1440,height:1000});
    await page.locator('#createProfile').click();
    await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
    await page.locator('#grantReward').click();
    await page.waitForFunction(() => !document.getElementById('startRide').disabled);
    await page.locator('#startRide').click();
    await advance(.1,.1,1); assert(await direction() === 'none', 'First sample implies direction'); await noReveal();
    await advance(.2,.2,2); assert(await direction() === 'up', 'Rising quote not shown');
    await advance(.3,.15,3); assert(await direction() === 'down', 'Falling quote not shown');
    await advance(.4,.15,4); assert(await direction() === 'flat', 'Equal quote not flat');
    await page.waitForFunction(() => document.getElementById('rideDirection').dataset.direction === 'none');
    assert(await page.locator('#rideCurrentBoost').textContent() === '15.00%', 'Stale handling changed boost');
    await (await pending()).abort('failed');
    await page.waitForFunction(() => document.getElementById('rideSummary').textContent.includes('Gap retained'));
    assert(await direction() === 'none', 'Error retained fresh trend'); await noReveal();
    await advance(.5,.3,5); assert(await direction() === 'none', 'First observation after gap implies trend');
    await advance(.6,.4,6); assert(await direction() === 'up', 'Fresh pair after gap is not rising');
    await page.locator('#toggleAutoQuote').click();
    assert(await direction() === 'none', 'Paused quote implies live direction');
    await page.locator('#quoteOnce').click();
    await advance(.7,.5,7); assert(await direction() === 'none', 'Manual quote implies unpaused live trend');
    await page.locator('#lockBoost').click();
    await page.waitForFunction(() => document.getElementById('lockBoost').textContent === 'Retry Stop (Lock)');
    await noReveal(); assert(await direction() === 'none', 'Uncertain lock retains trend');
    await page.locator('#lockBoost').click();
    await page.waitForFunction(() => document.getElementById('lockBoost').textContent === 'Retry Stop (Lock)');
    await noReveal();
    await page.locator('#lockBoost').click();
    await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
    assert(await direction() === 'none', 'Final state implies fresh trend');
    assert(await page.locator('#fullRidePath').getAttribute('d'), 'Accepted terminal path missing');
    assert(await page.locator('#rideFinalMaxBoost').textContent() === '45.00%', 'Sample peak used as ride maximum');
    const frozen = await page.locator('#fullRidePath').getAttribute('d');
    await page.locator('#grantReward').click();
    await page.waitForFunction(() => !document.getElementById('startRide').disabled);
    assert(await page.locator('#fullRidePath').getAttribute('d') === frozen, 'Grant changed frozen path');
    await page.locator('#startRide').click();
    await page.waitForFunction(() => ride.phase === 'running' && ride.samples.length === 0);
    await noReveal();
    await advance(.1,.1,1); await noReveal();
    legacy = true;
    await page.locator('#lockBoost').click();
    await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
    assert(await page.locator('#rideFinalBoost').textContent() === '12.35%', 'Legacy final outcome lost');
    assert(await page.locator('#fullRidePath').getAttribute('d') === '' && (await page.locator('#revealInfo').textContent()).includes('unavailable'), 'Invalid metadata did not use explicit observed-only fallback');
    return ['first/up/down/flat','stale value retained, trend neutral','error/gap/manual/paused neutral','uncertain/retry and mismatched identity cannot reveal','accepted final reveals and separates true maximum','grant preserves frozen result, new ride clears reveal','legacy/malformed metadata retains exact final'];
  } finally {
    if (pendingQuote) await pendingQuote.abort('failed').catch(()=>{});
    await page.unroute('**/api/**');
  }
}
