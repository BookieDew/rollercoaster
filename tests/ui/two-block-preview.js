async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#startRide').click();
  await page.evaluate(() => scrollTo(0,0));
  await page.waitForFunction(() => Number(document.getElementById('currentMarker').dataset.seconds) >= 4.2);
  const live = await page.evaluate(() => ({ samples: ride.samples.map(point=>({...point})), direction: document.getElementById('rideDirectionText').textContent, fullPath: document.getElementById('fullRidePath').getAttribute('d') }));
  assert(!live.fullPath, 'Future path visible before lock');
  assert(live.samples.some((point,index)=>index && point.boost < live.samples[index-1].boost), 'Preview has no observed fall');
  assert(live.samples.some((point,index)=>index && point.boost > live.samples[index-1].boost), 'Preview has no observed rise');
  await page.screenshot({path:'output/playwright/two-block/live-direction-wave.png',fullPage:false});
  await page.locator('#lockBoost').click();
  await page.waitForFunction(() => document.getElementById('rideOutcomeBox').style.display === 'block');
  const final = await page.evaluate(() => ({ outcome: ride.final, revealed: ride.finalDisplay, count: ride.samples.length, raw: JSON.parse(document.getElementById('responseBox').textContent), marker: {seconds:Number(document.getElementById('stopMarker').dataset.seconds),boost:Number(document.getElementById('stopMarker').dataset.boost)} }));
  assert(final.raw.lock_id && final.revealed, 'Real midride lock did not reveal server samples');
  assert(final.marker.seconds === final.raw.ride_stop_at_offset_seconds && final.marker.boost === final.raw.locked_boost_pct, 'Exact stop differs from raw lock');
  assert(final.revealed.points.every((point,index)=>point.seconds === final.raw.ride_path[index].timePct*final.raw.ride_end_at_offset_seconds && point.boost === final.raw.ride_path[index].baseBoostValue), 'Revealed values changed');
  assert(final.revealed.points.some(point=>point.seconds > final.marker.seconds && point.boost > 0), 'No nonzero after-stop samples shown');
  await page.screenshot({path:'output/playwright/two-block/post-lock-full-wave.png',fullPage:false});
  return { liveCount:live.samples.length, liveLast:live.samples.at(-1), liveDirection:live.direction, finalCount:final.count, exactStop:final.marker, revealedPoints:final.revealed.points.length, duration:final.revealed.duration, crash:final.revealed.crash, theoreticalMaximum:final.outcome.referenceMax };
}
