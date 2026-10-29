async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.unroute('**/api/**');
  await page.reload();
  await page.setViewportSize({ width: 375, height: 844 });
  await page.locator('#apiKey').fill('demo-ui-test-key');
  for (const [id, value] of Object.entries({ minBoostPct: '1', maxBoostPct: '10', effectiveMinFloorRate: '1', maxBoostMinSelections: '5', maxBoostMinCombinedOdds: '10' })) {
    await page.locator(`#${id}`).fill(value);
  }
  await page.locator('#createProfile').click();
  await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
  await page.locator('#grantReward').click();
  await page.waitForFunction(() => !document.getElementById('startRide').disabled);
  await page.locator('#startRide').click();
  await page.waitForFunction(() => document.getElementById('rideCurrentBoost').textContent === '1000.00%');
  await page.locator('#lockBoost').click();
  await page.waitForFunction(() => document.getElementById('rideFinalBoost').textContent === '1000.00%');
  const results = [];
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
    await page.waitForFunction(() => document.getElementById('rideChart').viewBox.baseVal.width === document.getElementById('rideChart').clientWidth);
    const bounds = await page.evaluate(() => {
      const svg = document.getElementById('rideChart');
      return [...document.querySelectorAll('#rideGrid text[text-anchor="end"]')].map(text => {
        const box = text.getBBox();
        return { label: text.textContent, x: box.x, right: box.x + box.width, svgWidth: svg.viewBox.baseVal.width };
      });
    });
    assert(bounds.some(item => item.label === '1200.0%'), 'High-cap axis not exercised');
    assert(bounds.every(item => item.x >= 0 && item.right <= item.svgWidth), `Clipped tick glyphs at ${width}: ${JSON.stringify(bounds)}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), 'High boost causes horizontal overflow');
    await page.locator('#rideWorkspace').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/two-block/high-boost-${width}.png`, fullPage: false });
    results.push({ width, bounds });
  }
  return { current: await page.locator('#rideCurrentBoost').textContent(), viewports: results };
}
