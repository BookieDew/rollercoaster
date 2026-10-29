async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.unroute('**/api/**');
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const inspect = () => page.evaluate(() => {
    const ancestors = id => {
      const chain = [];
      for (let el = document.getElementById(id); el; el = el.parentElement) {
        const style = getComputedStyle(el);
        chain.push({ element: el.id || el.tagName, overflowY: style.overflowY, position: style.position });
      }
      return chain;
    };
    return {
      documentHeight: document.documentElement.scrollHeight,
      scrollElement: document.scrollingElement.tagName,
      nested: [...document.querySelectorAll('body *')].filter(el => el.getClientRects().length && ['auto','scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2).map(el=>el.id||el.className),
      ancestors: { chart: ancestors('rideChart'), preview: ancestors('oddsList'), json: ancestors('responseBox') },
    };
  });
  const initial = await inspect();
  assert(!await page.locator('#responseBox').isVisible(), 'JSON should start collapsed');
  assert(await page.locator('#toggleResponse').getAttribute('aria-controls') === 'responseDetails', 'JSON button has no region relationship');
  assert(await page.locator('#toggleResponse').getAttribute('aria-expanded') === 'false', 'JSON button starts expanded');
  const ids = ['modelSplit','modelFloorRate','modelExponent','modelEligibilityFactor','modelSelectionRatio','modelOddsRatio','modelEffectiveMin','modelEffectiveMax'];
  for (const id of ids) assert(await page.locator(`#${id}`).textContent() === 'n/a', `Missing initial null state for ${id}`);
  await page.locator('#apiKey').fill('demo-ui-test-key');
  await page.locator('#createProfile').click();
  await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
  assert(JSON.parse(await page.locator('#responseBox').textContent()).id, 'Hidden JSON did not receive profile response');
  await page.locator('#grantReward').click();
  await page.waitForFunction(() => !document.getElementById('startRide').disabled);
  await page.locator('#startRide').click();
  await page.waitForFunction(() => document.querySelectorAll('#rideSamples circle').length >= 3);
  await page.evaluate(() => scrollTo(0, 0));
  const live = await page.evaluate(() => ({ height: document.getElementById('rideWorkspace').getBoundingClientRect().height, actions: ['lockBoost','quoteOnce','toggleAutoQuote'].map(id=>({id, top:document.getElementById(id).getBoundingClientRect().top,bottom:document.getElementById(id).getBoundingClientRect().bottom})), raw: JSON.parse(document.getElementById('responseBox').textContent) }));
  assert(live.height <= 500 && live.actions.every(button => button.top >= 0 && button.bottom <= 1000), 'Live actions not visible in compact desktop ride');
  assert(!live.raw.ride_path && !await page.locator('#responseBox').isVisible(), 'Live quote opened JSON or revealed future path');
  await page.locator('#lockBoost').click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
  const savedJSON = await page.locator('#responseBox').textContent();
  const final = JSON.parse(savedJSON);
  assert(final.lock_id && final.ride_path.length === 60, 'Real lock/full response not retained');
  const outcome = await page.locator('#rideOutcomeBox').boundingBox();
  assert(outcome.y >= 0 && outcome.y + outcome.height <= 1000, 'Final result outside desktop viewport');
  const row = page.locator('.selection-row').nth(2);
  await row.locator('.selection-type').selectOption('SGP_COMPOSITE');
  await row.locator('.selection-group').fill('expanded-demo-group');
  await row.locator('.selection-leg-count').fill('12');
  await row.locator('.selection-leg-count').press('Tab');
  await page.locator('#ticketPreview summary').click();
  const expanded = await inspect();
  assert(await page.locator('#oddsList').textContent() === await page.locator('#oddsList').evaluate(el => el.value), 'Preview lost text');
  await page.locator('#modelDetails summary').click();
  assert((await page.locator('#modelDetails summary').textContent()).includes('Calculation details'), 'Unclear advanced title retained');
  assert((await page.locator('#modelDetails').textContent()).includes('Max-access factor'), 'Max-access factor mislabeled');
  for (const id of ids) assert(await page.locator(`#${id}`).textContent() !== 'n/a', `Server model did not update ${id}`);
  await page.locator('#toggleResponse').focus();
  await page.keyboard.press('Space');
  assert(await page.locator('#toggleResponse').getAttribute('aria-expanded') === 'true' && await page.locator('#responseBox').isVisible(), 'Keyboard JSON disclosure failed');
  assert(await page.locator('#responseBox').textContent() === savedJSON, 'Opening JSON changed payload');
  const openJSON = await inspect();
  assert([initial,expanded,openJSON].every(state=>state.scrollElement === 'HTML' && state.nested.length === 0), 'Nested scroll found in an exercised state');
  await page.evaluate(() => scrollTo(0, document.getElementById('responseBox').getBoundingClientRect().top + scrollY + 100));
  const beforeWheel = await page.evaluate(() => scrollY);
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, 350);
  await page.waitForTimeout(150);
  const afterWheel = await page.evaluate(() => scrollY);
  assert(afterWheel > beforeWheel, 'Wheel over JSON did not scroll the document');
  await page.screenshot({path:'output/playwright/two-block/open-json-scroll.png',fullPage:false});
  await page.locator('#toggleResponse').click();
  assert(await page.locator('#responseBox').textContent() === savedJSON && !await page.locator('#responseBox').isVisible(), 'Closing JSON removed response');
  await page.locator('#demoSetup').scrollIntoViewIfNeeded();
  await page.screenshot({path:'output/playwright/two-block/expanded-setup.png',fullPage:false});
  return { initial, expanded, openJSON, wheel: { before: beforeWheel, after: afterWheel }, liveHeight: live.height, finalReason: 'locked', retainedPathPoints: final.ride_path.length, modelReadouts: ids.length };
}
