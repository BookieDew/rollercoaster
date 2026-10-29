async (page) => {
  // Run via playwright-cli run-code --filename after a fresh snapshot.
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.unroute('**/api/**');
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
      fullPath: document.getElementById('fullRidePath').getAttribute('d'),
      revealed: ride.finalDisplay,
    }));
    assert(live.current === `${(live.boost * 100).toFixed(2)}%`, `${mode} current differs from leading point`);
    assert(!live.path.includes('C'), 'Curve invents unsampled values');
    assert(!live.raw.ride_path, 'Active response exposes future path');
    assert(live.finalHidden, 'Final maximum shown while active');
    assert(live.fullPath === '' && live.revealed === null, 'Full path revealed before final');
    assert(live.chartHeight >= 320 && live.chartHeight <= 500, 'Desktop chart does not use the approved taller range');
    await page.screenshot({ path: `output/playwright/two-block/${mode.toLowerCase()}-live-desktop.png`, fullPage: true });
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
      revealed: ride.finalDisplay,
      fullPath: document.getElementById('fullRidePath').getAttribute('d'),
      afterPath: document.getElementById('afterStopPath').getAttribute('d'),
      axisSeconds: Number(document.getElementById('rideChart').dataset.axisSeconds),
      ceiling: Number(document.getElementById('rideChart').dataset.ceiling),
      width: document.getElementById('rideChart').viewBox.baseVal.width,
      height: document.getElementById('rideChart').viewBox.baseVal.height,
    }));
    assert(final.raw.maximum_model === 'WAVES_PRE_CRASH_SUPREMUM_V2', 'New lock missing V2 discriminator');
    assert(await page.locator('#rideMaximumLabel').textContent() === 'Ride maximum', 'V2 final label is wrong');
    assert(final.label === 'Locked boost', 'Did not lock before minimum crash');
    assert(final.boost === final.raw.locked_boost_pct, 'Lock marker boost mismatch');
    assert(final.seconds === final.raw.ride_stop_at_offset_seconds, 'Lock marker time mismatch');
    assert(final.current === final.value, 'Current not reconciled to final');
    assert(Array.isArray(final.raw.ride_path), 'Raw terminal path lost');
    assert(final.revealed && final.revealed.points.length === final.raw.ride_path.length, 'Full server samples not revealed after lock');
    assert(final.axisSeconds === Math.max(final.raw.ride_end_at_offset_seconds, final.seconds), 'Axis does not cover full duration and exact stop');
    assert(final.revealed.points.every((point, i) => point.seconds === final.raw.ride_path[i].timePct * final.raw.ride_end_at_offset_seconds && point.boost === final.raw.ride_path[i].baseBoostValue), 'Full path altered server sample values');
    assert(final.revealed.points.some(point => point.seconds > final.seconds) && final.afterPath === final.fullPath, 'After-stop path missing');
    const geometry = [...final.fullPath.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    assert(geometry.length === final.raw.ride_path.length, 'Sampled trace adds or loses vertices');
    assert(geometry.every(([x,y],i)=>Math.abs(x-(64+final.revealed.points[i].seconds/final.axisSeconds*(final.width-76))) < .011 && Math.abs(y-(final.height-32-final.revealed.points[i].boost/final.ceiling*(final.height-64))) < .011), 'SVG does not map exact server samples');
    await page.waitForTimeout(500);
    assert(await page.locator('#ridePathLine').getAttribute('d') === final.path && await page.locator('#fullRidePath').getAttribute('d') === final.fullPath, 'Final paths changed after lock');
    await page.screenshot({ path: `output/playwright/two-block/${mode.toLowerCase()}-locked-desktop.png`, fullPage: false });
    result.push({ mode, liveCount: live.count, finalCount: final.count, current: final.current, seconds: final.seconds, chartHeight: live.chartHeight, maximumModel: final.raw.maximum_model, revealedPoints: final.revealed.points.length, duration: final.axisSeconds });
  }
  return result;
}
