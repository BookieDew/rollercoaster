async (page) => {
  // Run via playwright-cli run-code --filename after a fresh snapshot.
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('demo-ui-test-key');
  const result = [];
  for (const mode of ['WAVES', 'LINEAR']) {
    await page.locator('#rideMode').selectOption(mode);
    await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
    await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('startRide').disabled);
    await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById('responseBox').textContent).eligible === true);
    await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#rideSamples circle').length >= 4 && document.getElementById('rideOutcomeBox').style.display === 'none' && document.getElementById('currentMarker').style.display === 'block', { timeout: 6000 });
    const live = await page.evaluate(() => ({
      count: document.querySelectorAll('#rideSamples circle').length,
      boost: Number(document.getElementById('currentMarker').dataset.boost),
      current: document.getElementById('rideCurrentBoost').textContent,
      path: document.getElementById('ridePathLine').getAttribute('d'),
      raw: JSON.parse(document.getElementById('responseBox').textContent),
      finalHidden: document.getElementById('rideOutcomeBox').style.display === 'none',
      chartHeight: document.querySelector('.chart').getBoundingClientRect().height,
    }));
    assert(live.current === `${(live.boost * 100).toFixed(2)}%`, `${mode} current differs from leading point`);
    assert(!live.path.includes('C'), 'Curve invents unsampled values');
    assert(!live.raw.ride_path, 'Active response exposes future path');
    assert(live.finalHidden, 'Final maximum shown while active');
    assert(live.chartHeight <= 310, 'Chart expands beyond compact height');
    await page.screenshot({ path: `output/playwright/${mode.toLowerCase()}-live-desktop.png`, fullPage: true });
    await page.getByRole('button', { name: 'Stop Ride (Lock)', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
    const final = await page.evaluate(() => ({
      label: document.getElementById('rideFinalLabel').textContent,
      value: document.getElementById('rideFinalBoost').textContent,
      current: document.getElementById('rideCurrentBoost').textContent,
      boost: Number(document.getElementById('stopMarker').dataset.boost),
      seconds: Number(document.getElementById('stopMarker').dataset.seconds),
      raw: JSON.parse(document.getElementById('responseBox').textContent),
      path: document.getElementById('ridePathLine').getAttribute('d'),
      count: document.querySelectorAll('#rideSamples circle').length,
    }));
    assert(final.raw.maximum_model === 'WAVES_PRE_CRASH_SUPREMUM_V2', 'New lock missing V2 discriminator');
    assert(await page.locator('#rideMaximumLabel').textContent() === 'Ride maximum', 'V2 final label is wrong');
    assert(final.label === 'Locked boost', 'Did not lock before minimum crash');
    assert(final.boost === final.raw.locked_boost_pct, 'Lock marker boost mismatch');
    assert(final.seconds === final.raw.ride_stop_at_offset_seconds, 'Lock marker time mismatch');
    assert(final.current === final.value, 'Current not reconciled to final');
    assert(Array.isArray(final.raw.ride_path), 'Raw terminal path lost');
    await page.waitForTimeout(500);
    assert(await page.locator('#ridePathLine').getAttribute('d') === final.path, 'Final path changed after lock');
    await page.screenshot({ path: `output/playwright/${mode.toLowerCase()}-locked-desktop.png`, fullPage: false });
    result.push({ mode, liveCount: live.count, finalCount: final.count, current: final.current, seconds: final.seconds, chartHeight: live.chartHeight, maximumModel: final.raw.maximum_model });
  }
  return result;
}
