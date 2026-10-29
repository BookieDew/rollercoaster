async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const results = [];
  await page.reload();
  for (const [width, height] of [[1440, 1000], [1280, 800], [1100, 800], [768, 1024], [390, 844], [375, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    const dimensions = await page.evaluate(() => {
      const line = getComputedStyle(document.getElementById('ridePathLine'));
      const contrast = (colorA, colorB) => {
        const lum = color => {
          const values = color.match(/[\d.]+/g).slice(0, 3).map(x => Number(x)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
          return .2126*values[0]+.7152*values[1]+.0722*values[2];
        };
        return (Math.max(lum(colorA),lum(colorB))+.05)/(Math.min(lum(colorA),lum(colorB))+.05);
      };
      const label = document.querySelector('label[for="minSelections"]');
      let surface = label;
      while (surface.parentElement && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
      const mutedColors = { foreground: getComputedStyle(label).color, background: getComputedStyle(surface).backgroundColor };
      // Inspect the actual enabled-action CSS synchronously without dispatching events.
      const primaryButton = document.getElementById('startRide');
      const wasDisabled = primaryButton.disabled;
      primaryButton.disabled = false;
      const primaryColors = { foreground: getComputedStyle(primaryButton).color, background: getComputedStyle(primaryButton).backgroundColor };
      primaryButton.disabled = wasDisabled;
      const rect = id => { const box = document.getElementById(id).getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; };
      return {
        alignment: { left: rect('rideWorkspace'), profile: rect('profileSetup'), right: rect('rideChartCard'), ticket: rect('ticketSetup') },
        timeBelow: rect('elapsedSeconds').top >= rect('rideCurrentBoost').bottom,
        width: innerWidth, document: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
        rideHeight: document.getElementById('rideWorkspace').getBoundingClientRect().height, setupTop: document.getElementById('demoSetup').getBoundingClientRect().top,
        ticketHeight: document.getElementById('ticketSetup').getBoundingClientRect().height,
        domRideFirst: !!(document.getElementById('rideWorkspace').compareDocumentPosition(document.getElementById('demoSetup')) & Node.DOCUMENT_POSITION_FOLLOWING),
        fixedOrSticky: [...document.querySelectorAll('body *')].filter(el => ['fixed','sticky'].includes(getComputedStyle(el).position)).map(el=>el.id||el.className),
        clipped: [...document.querySelectorAll('input,select,button')].filter(el=>el.getClientRects().length && (el.getBoundingClientRect().left < -1 || el.getBoundingClientRect().right > innerWidth+1)).map(el=>el.id||el.className),
        stroke: line.strokeWidth, vectorEffect: line.vectorEffect,
        mainMetricSize: getComputedStyle(document.getElementById('rideCurrentBoost')).fontSize,
        fieldLabelSize: getComputedStyle(document.querySelector('label[for="minSelections"]')).fontSize,
        mutedColors, primaryColors,
        mutedContrast: contrast(mutedColors.foreground, mutedColors.background), primaryContrast: contrast(primaryColors.foreground, primaryColors.background),
        sampledPathContrast: contrast(getComputedStyle(document.getElementById('fullRidePath')).stroke, getComputedStyle(document.getElementById('rideChartCard')).backgroundColor),
        nestedScrollers: [...document.querySelectorAll('body *')].filter(el=>['auto','scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight+2).map(el=>el.id||el.className),
      };
    });
    assert(dimensions.document === width, `Horizontal overflow at ${width}`);
    assert(!dimensions.clipped.length, `Controls clipped at ${width}: ${dimensions.clipped}`);
    assert(dimensions.stroke === '1.65px' && dimensions.vectorEffect === 'non-scaling-stroke', 'Line is not a fixed fine stroke');
    assert(parseFloat(dimensions.mainMetricSize) >= 42 && parseFloat(dimensions.fieldLabelSize) >= 12, 'Type hierarchy too small');
    assert(dimensions.mutedContrast >= 4.5 && dimensions.primaryContrast >= 4.5, 'Text contrast below4.5');
    assert(dimensions.sampledPathContrast >= 3, 'Full sampled path contrast below3');
    assert(!dimensions.nestedScrollers.length, `Nested scroll traps: ${dimensions.nestedScrollers}`);
    assert(dimensions.domRideFirst && !dimensions.fixedOrSticky.length, 'Ride DOM order or single-document scrolling is wrong');
    assert(dimensions.timeBelow, 'Observed time is not below the metric');
    if (width > 1000) {
      const { left, profile, right, ticket } = dimensions.alignment;
      assert(Math.abs(left.left-profile.left) < .1 && Math.abs(left.right-profile.right) < .1 && Math.abs(right.left-ticket.left) < .1 && Math.abs(right.right-ticket.right) < .1, 'Ride and setup tracks differ');
      assert(right.bottom <= height && left.bottom <= height, 'Desktop metric/actions/chart not visible together');
    }
    if (width >= 1280) {
      assert(dimensions.rideHeight <= 500, 'Desktop ride is too tall');
      assert(dimensions.setupTop < height - 80, 'Setup does not begin in the desktop viewport');
      assert(dimensions.ticketHeight < 720, 'Desktop ticket still uses a tall narrow layout');
    }
    await page.screenshot({ path: `output/playwright/two-block/idle-${width}.png`, fullPage: false });
    results.push(dimensions);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('Tab');
  await page.locator('#createProfile').focus();
  const focus = await page.locator('#createProfile').evaluate(el=>({style:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth}));
  assert(focus.style !== 'none' && parseFloat(focus.width) >= 2, 'Keyboard focus is not visible');
  await page.locator('#modelDetails summary').click();
  await page.locator('#toggleResponse').click();
  assert(await page.locator('#modelSplit').isVisible() && await page.locator('#responseBox').isVisible(), 'Technical disclosures inaccessible');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.locator('#startRide').evaluate(el=>getComputedStyle(el).transitionDuration);
  assert(motion.split(',').every(value=>parseFloat(value) === 0), 'Reduced motion not respected');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return { viewports: results, layout: 'DOM ride first; compact desktop setup below; one document scroll', keyboardFocus: focus, disclosures: 'accessible', reducedMotion: 'passed' };
}
