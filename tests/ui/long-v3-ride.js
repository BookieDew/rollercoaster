async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const accepted = [];
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
  }));
  try {
    await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
    await page.waitForFunction(() => Number(document.getElementById('currentMarker').dataset.seconds) >= 0.35);
    const before = await inspect();
    await page.screenshot({ path: 'output/playwright/v3-long-before.png', fullPage: false });
    await page.waitForFunction(() => Number(document.getElementById('currentMarker').dataset.seconds) >= 4.2, null, { timeout: 12000 });
    const after = await inspect();
    await page.screenshot({ path: 'output/playwright/v3-long-after.png', fullPage: false });
    assert(after.points.length > before.points.length + 10, 'Long ride did not progressively add points');
    assert(after.current === `${(after.markerBoost * 100).toFixed(2)}%`, 'Current differs from leading marker');
    assert(after.markerBoost > after.raw.effective_min_boost_pct + 0.01, 'Long ride did not visibly leave floor');
    assert(after.points.some(p => p.boost > before.points[0].boost + 0.01), 'Observed boosts never changed above initial floor');
    assert(!after.raw.ride_path && !before.raw.ride_path, 'Active response revealed future path');
    await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block', null, { timeout: 18000 });
    const terminal = await inspect();
    const kind = terminal.raw.reason_code === 'RIDE_CRASHED' ? 'crash' : 'end';
    await page.screenshot({ path: `output/playwright/v3-long-${kind}-final.png`, fullPage: false });
    assert(['RIDE_CRASHED', 'RIDE_ENDED'].includes(terminal.raw.reason_code), 'Unexpected real terminal reason');
    assert(terminal.current === '0.00%' && terminal.points.at(-1).boost === 0, 'Terminal zero not plotted');
    assert(Array.isArray(terminal.raw.ride_path), 'Terminal raw path removed');
    assert(terminal.raw.maximum_model === 'WAVES_PRE_CRASH_SUPREMUM_V2', 'Maximum model label changed with phase version');
    assert(terminal.points.length === accepted.length, 'Plot received an unobserved point or lost a quote');
    assert(terminal.points.every(point => accepted.some(response => response.ride_elapsed_seconds === point.seconds && response.current_boost_pct === point.boost)), 'Plot differs from observed API samples');
    assert(accepted.filter(response => response.eligible).every(response => !response.ride_path), 'Live quotes expose full future path');
    await page.waitForTimeout(300);
    assert(await page.locator('#ridePathLine').getAttribute('d') === terminal.path, 'Terminal observed history not frozen');
    return {
      rewardId: terminal.rewardId,
      before: { count: before.points.length, seconds: before.markerSeconds, boost: before.markerBoost },
      after: { count: after.points.length, seconds: after.markerSeconds, boost: after.markerBoost, effectiveFloor: after.raw.effective_min_boost_pct },
      terminal: { count: terminal.points.length, last: terminal.points.at(-1), reason: terminal.raw.reason_code, label: terminal.label, rawPathPoints: terminal.raw.ride_path.length },
      observed: terminal.points,
      maximumModel: terminal.raw.maximum_model,
    };
  } finally { page.off('response', listener); }
}
