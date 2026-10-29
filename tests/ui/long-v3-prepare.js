async (page) => {
  await page.unroute('**/api/**');
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const mode = await page.evaluate(() => new URL(location.href).searchParams.get('qaMode') === 'LINEAR' ? 'LINEAR' : 'WAVES');
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('demo-ui-test-key');
  await page.getByLabel('Ride mode', { exact: true }).selectOption(mode);
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('grantReward').disabled);
  await page.getByRole('button', { name: 'Grant Reward', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('startRide').disabled);
  await page.getByRole('button', { name: 'Precheck Eligibility', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(document.getElementById('responseBox').textContent).eligible === true);
  return page.evaluate(() => ({ rewardId: document.getElementById('rewardId').textContent, profileId: document.getElementById('profileId').textContent, betId: document.getElementById('betId').value }));
}
