async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const accepted = [];
  const mode = await page.locator('#rideMode').inputValue();
  const listener = async response => {
    if (response.url().endsWith('/api/boost/quote')) {
      const payload = await response.json();
      accepted.push(payload);
    }
  };
  page.on('response', listener);
  const inspect = () => page.evaluate(() => ({
    rewardId: document.getElementById('rewardId').textContent,
    points: ride.samples.map(sample => ({ ...sample })),
    markerSeconds: Number(document.getElementById('currentMarker').dataset.seconds),
    markerBoost: Number(document.getElementById('currentMarker').dataset.boost),
    current: document.getElementById('rideCurrentBoost').textContent,
    raw: JSON.parse(document.getElementById('responseBox').textContent),
    path: document.getElementById('ridePathLine').getAttribute('d'),
    summary: document.getElementById('rideSummary').textContent,
    label: document.getElementById('rideFinalLabel').textContent,
    revealed: ride.finalDisplay,
    fullPath: document.getElementById('fullRidePath').getAttribute('d'),
    axisSeconds: Number(document.getElementById('rideChart').dataset.axisSeconds),
    eventSeconds: Number(document.getElementById('serverEventMarker').dataset.seconds),
    terminalMarkerSeconds: Number(document.getElementById('crashMarker').dataset.seconds),
  }));
  try {
    await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => Number(document.getElementById('currentMarker').dataset.seconds) >= 0.35);
    const before = await inspect();
    await page.screenshot({ path: 'output/playwright/two-block/v3-long-before.png', fullPage: false });
    await page.waitForFunction(() => Number(document.getElementById('currentMarker').dataset.seconds) >= 4.2, null, { timeout: 12000 });
    const after = await inspect();
    await page.screenshot({ path: 'output/playwright/two-block/v3-long-after.png', fullPage: false });
    assert(after.points.length > before.points.length + 10, 'Long ride did not progressively add points');
    assert(after.current === `${(after.markerBoost * 100).toFixed(2)}%`, 'Current differs from leading marker');
    assert(after.markerBoost > after.raw.effective_min_boost_pct + 0.01, 'Long ride did not visibly leave floor');
    assert(after.points.some(p => p.boost > before.points[0].boost + 0.01), 'Observed boosts never changed above initial floor');
    assert(!after.raw.ride_path && !before.raw.ride_path, 'Active response revealed future path');
    assert(!after.revealed && !after.fullPath, 'Live chart reveals terminal geometry');
    if (await page.evaluate(() => new URL(location.href).searchParams.has('qaLate'))) {
      await page.waitForFunction(() => Number(document.getElementById('currentMarker').dataset.seconds) >= 5);
      await page.locator('#toggleAutoQuote').click();
      await page.waitForTimeout(7000);
      await page.locator('#quoteOnce').click();
    }
    await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block', null, { timeout: 18000 });
    const terminal = await inspect();
    const kind = terminal.raw.reason_code === 'RIDE_CRASHED' ? 'crash' : 'end';
    await page.screenshot({ path: `output/playwright/two-block/v3-long-${kind}-final.png`, fullPage: false });
    assert(['RIDE_CRASHED', 'RIDE_ENDED'].includes(terminal.raw.reason_code), 'Unexpected real terminal reason');
    assert(terminal.current === '0.00%' && terminal.points.at(-1).boost === 0, 'Terminal zero not plotted');
    assert(Array.isArray(terminal.raw.ride_path), 'Terminal raw path removed');
    assert(terminal.raw.maximum_model === 'PRE_CRASH_SUPREMUM_V4', 'Maximum model label is not the V4 label');
    assert(terminal.revealed && terminal.revealed.points.length === terminal.raw.ride_path.length, 'Full terminal samples not revealed');
    assert(terminal.terminalMarkerSeconds === terminal.points.at(-1).seconds, 'Terminal marker changed the observation time');
    assert(terminal.axisSeconds === Math.max(terminal.revealed.duration, terminal.points.at(-1).seconds), 'Late observation is outside the time axis');
    assert(terminal.eventSeconds === terminal.raw.ride_crash_at_offset_seconds, 'Reported event time moved to polling time');
    assert(terminal.points.length === accepted.length, 'Plot received an unobserved point or lost a quote');
    assert(terminal.points.every(point => accepted.some(response => response.ride_elapsed_seconds === point.seconds && response.current_boost_pct === point.boost)), 'Plot differs from observed API samples');
    assert(accepted.filter(response => response.eligible).every(response => !response.ride_path), 'Live quotes expose full future path');
    const activePoints = terminal.points.filter(point => point.boost > 0);
    const rises = activePoints.filter((point, index) => index && point.boost > activePoints[index - 1].boost).length;
    const falls = activePoints.filter((point, index) => index && point.boost < activePoints[index - 1].boost).length;
    if (mode === 'WAVES') assert(rises > 0 && falls > 0, 'Long WAVES ride did not show both an observed rise and fall');
    await page.waitForTimeout(300);
    assert(await page.locator('#ridePathLine').getAttribute('d') === terminal.path, 'Terminal observed history not frozen');
    return {
      rewardId: terminal.rewardId,
      mode, rises, falls,
      before: { count: before.points.length, seconds: before.markerSeconds, boost: before.markerBoost },
      after: { count: after.points.length, seconds: after.markerSeconds, boost: after.markerBoost, effectiveFloor: after.raw.effective_min_boost_pct },
      terminal: { count: terminal.points.length, last: terminal.points.at(-1), reason: terminal.raw.reason_code, label: terminal.label, rawPathPoints: terminal.raw.ride_path.length },
      observed: terminal.points,
      maximumModel: terminal.raw.maximum_model,
      revealedPoints: terminal.revealed.points.length, duration: terminal.revealed.duration, axisSeconds: terminal.axisSeconds, eventSeconds: terminal.eventSeconds,
    };
  } finally { page.off('response', listener); }
}
