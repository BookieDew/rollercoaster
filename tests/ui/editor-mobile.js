async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.unroute('**/api/**');
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.getByLabel('Min boost rate', { exact: true }).inputValue() === '0.05', 'Minimum rate units changed payload input');
  assert(await page.getByLabel('Max boost rate', { exact: true }).inputValue() === '1.0', 'Maximum rate units changed payload input');
  assert(await page.getByText('Boost rates: 0.05 = 5% · 1 = 100% · 10 = 1,000%.', { exact: true }).isVisible(), 'Fractional-rate helper missing');
  const row = page.locator('.selection-row').nth(2);
  await row.locator('.selection-type').selectOption('SGP_COMPOSITE');
  await row.locator('.selection-group').fill('g"><img src=x onerror=alert(1)>');
  await row.locator('.selection-leg-count').fill('2');
  await row.locator('.selection-leg-count').press('Tab');
  await row.locator('.leg-odds').nth(0).fill('1.6');
  await row.locator('.leg-odds').nth(1).fill('2.3');
  await row.locator('.selection-leg-count').fill('3');
  await row.locator('.selection-leg-count').press('Tab');
  assert(await row.locator('.leg-odds').nth(0).inputValue() === '1.6', 'Leg count change erased first leg');
  assert(await row.locator('.leg-odds').nth(1).inputValue() === '2.3', 'Leg count change erased second leg');
  await page.locator('.selection-row').nth(1).locator('.selection-reason').fill('E"><svg onload=alert(1)>');
  await page.locator('#selectionCount').fill('8');
  await page.getByRole('button', { name: 'Build Rows', exact: true }).click();
  assert(await page.locator('#selectionRows img, #selectionRows svg').count() === 0, 'Typed editor values interpreted as HTML');
  assert(await row.locator('.selection-group').inputValue() === 'g"><img src=x onerror=alert(1)>', 'Group input not retained');
  assert(await row.locator('.leg-odds').nth(1).inputValue() === '2.3', 'Build Rows erased leg values');
  await row.locator('.selection-group').fill('sgp-qa');
  await page.locator('.selection-row').nth(1).locator('.selection-reason').fill('BOOSTED');
  await page.locator('#selectionCount').fill('7');
  await page.getByRole('button', { name: 'Build Rows', exact: true }).click();
  const result = [];
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      clipped: [...document.querySelectorAll('input, select, button')].filter(el => el.getClientRects().length && (el.getBoundingClientRect().right > innerWidth + 1 || el.getBoundingClientRect().left < -1)).map(el => el.id || el.className),
      legs: [...document.querySelectorAll('.leg-row')].map(el => ({ top: el.getBoundingClientRect().top, left: el.getBoundingClientRect().left })),
    }));
    assert(layout.document <= width, `Horizontal overflow at${width}: ${layout.document}`);
    assert(!layout.clipped.length, `Clipped inputs at${width}: ${layout.clipped}`);
    assert(layout.legs[1].top > layout.legs[0].top && layout.legs[1].left === layout.legs[0].left, 'SGP legs are not vertical');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `output/playwright/mobile-${width}-editor.png`, fullPage: true });
    result.push({ width, documentWidth: layout.document, clipped: layout.clipped.length, verticalLegs: layout.legs.length });
  }
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('demo-ui-test-key');
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
  await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('precheckEligibility').disabled);
  await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(document.getElementById('responseBox').textContent).eligible === true);
  const eligibility = await page.locator('#responseBox').textContent();
  assert(JSON.parse(eligibility).qualifying_selection_count === 5, 'Optional SGP legs changed eligible count');
  await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#rideSamples circle').length >= 3);
  await page.locator('.chart-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/mobile-390-live.png', fullPage: false });
  await page.getByRole('button', { name: 'Stop Ride (Lock)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
  await page.locator('.chart-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/mobile-390-final.png', fullPage: false });
  const final = await page.locator('#responseBox').textContent();
  assert(JSON.parse(final).lock_id, 'Mobile did not lock in time');
  return { layout: result, qualifyingCount: 5, finalBoost: JSON.parse(final).locked_boost_pct };
}
