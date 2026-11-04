async (page) => {
  // Run via playwright-cli run-code --filename after a fresh snapshot (isolated server on :4318).
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.unroute('**/api/**');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('demo-ui-test-key');
  await page.locator('#brandId').fill('pickerbrand');
  await page.locator('#brandId').dispatchEvent('change');
  const group = `VIP ${Date.now() % 100000}`;
  await page.locator('#profileName').fill('Picker Plain');
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('profileId').textContent !== 'n/a');
  await page.locator('#profileName').fill('Picker Labelled');
  await page.locator('#minSelections').fill('4');
  await page.locator('#profileSegment').fill(group);
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await page.waitForFunction((n) => document.getElementById('savedProfile').selectedOptions[0]?.textContent.startsWith(n), 'Picker Labelled');
  const created = await page.evaluate(() => document.getElementById('profileId').textContent);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#savedProfile option')].map((o) => o.textContent));
  assert(labels[1].startsWith('Picker Labelled') && labels[1].includes(group) && labels[2].startsWith('Picker Plain'), 'Picker not newest first / label format wrong: ' + labels.join('|'));
  // filter by group
  await page.locator('#profileGroupFilter').selectOption(group);
  assert(await page.locator('#savedProfile option').count() === 2, 'Group filter did not narrow the list');
  // scramble the form, then pick
  await page.locator('#minSelections').fill('9');
  await page.locator('#profileName').fill('Changed');
  assert(await page.locator('#profileDirty').isVisible(), 'Dirty marker missing after edit');
  await page.locator('#savedProfile').selectOption('');
  await page.locator('#savedProfile').selectOption(created);
  const filled = await page.evaluate(() => ({ name: profileName.value, min: minSelections.value, seg: profileSegment.value, cap: maxBonus.value, id: profileId.textContent, dirty: !profileDirty.hidden }));
  assert(filled.name === 'Picker Labelled' && filled.min === '4' && filled.seg === group && filled.cap === '500.00' && filled.id === created && !filled.dirty, 'Pick did not fill form: ' + JSON.stringify(filled));
  await page.screenshot({ path: 'output/playwright/two-block/profile-picker-desktop.png', fullPage: false });
  // grant shows group
  await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('startRide').disabled);
  assert(await page.locator('#rewardSegment').textContent() === group, 'Reward group not shown');
  // plain profile -> Group none
  await page.locator('#profileGroupFilter').selectOption('');
  const plain = await page.evaluate(() => [...document.querySelectorAll('#savedProfile option')].find((o) => o.textContent.startsWith('Picker Plain')).value);
  await page.locator('#savedProfile').selectOption(plain);
  await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rewardSegment').textContent === 'none');
  // back to labelled, ride locks
  await page.locator('#savedProfile').selectOption(created);
  await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
  await page.waitForFunction((g) => document.getElementById('rewardSegment').textContent === g && !document.getElementById('startRide').disabled, group);
  await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ride (Opt-in)', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#rideSamples circle').length >= 3, { timeout: 6000 });
  await page.getByRole('button', { name: 'Stop Ride (Lock)', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
  assert(await page.locator('#rideFinalLabel').textContent() === 'Locked boost', 'Ride did not lock');
  // mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#savedProfile').scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert(!overflow, 'Horizontal overflow at 390');
  await page.locator('.profile-picker').screenshot({ path: 'output/playwright/two-block/profile-picker-390.png' });
  // failed load never breaks the console
  await page.route('**/api/profiles?*', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('profilePickerNote').textContent.startsWith('Could not load'));
  await page.unroute('**/api/profiles?*');
  assert(errors.length === 0, 'Page errors: ' + errors.join(';'));
  return { group, labels: labels.length };
}
