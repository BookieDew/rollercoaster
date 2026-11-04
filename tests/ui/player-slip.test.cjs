const test = require('node:test');
const assert = require('node:assert/strict');
const slip = require('../../public/demo/player-slip');

test('toRational parses decimals, exponents and rejects non-decimals', () => {
  assert.deepEqual(slip.toRational('9.96'), { n: 996n, d: 100n });
  assert.deepEqual(slip.toRational(1.5), { n: 15n, d: 10n });
  assert.deepEqual(slip.toRational(1e-7), { n: 1n, d: 10000000n });
  assert.deepEqual(slip.toRational('2e3'), { n: 2000n, d: 1n });
  for (const bad of [-1, NaN, Infinity, '', 'abc', '1.2.3', null, undefined, {}, '-3']) assert.equal(slip.toRational(bad), null);
});

test('odds are rounded half-up to two decimals', () => {
  assert.equal(slip.formatOdds('9.995'), '10.00');
  assert.equal(slip.formatOdds('9.994'), '9.99');
  assert.equal(slip.formatOdds(1.005), '1.01');
  assert.equal(slip.formatOdds('abc'), null);
});

test('boosted odds and return follow gross + bonus over stake (reference scenario)', () => {
  const result = slip.computePotential({ stakeMinor: 1000, combinedOdds: '9.96', boost: 0.04, capMinor: 50000 });
  assert.equal(result.grossMinor, 9960n);
  assert.equal(result.bonusMinor, 398n); // 398.4 rounds down
  assert.equal(result.totalMinor, 10358n);
  assert.equal(result.baseOdds, '9.96');
  assert.equal(result.boostedOdds, '10.36'); // 10.358 rounds up
  assert.equal(result.capped, false);
});

test('gross and bonus round half-up to whole minor units', () => {
  // 100 x 1.005 = 100.5 -> 101; 1 x 1.5 x 0.5 = 0.75 -> 1; 1 x 1.5 x 0.3 = 0.45 -> 0
  assert.equal(slip.computePotential({ stakeMinor: 100, combinedOdds: '1.005', boost: 0 }).grossMinor, 101n);
  const half = slip.computePotential({ stakeMinor: 1, combinedOdds: '1.5', boost: 0.5 });
  assert.equal(half.grossMinor, 2n);
  assert.equal(half.bonusMinor, 1n);
  assert.equal(slip.computePotential({ stakeMinor: 1, combinedOdds: '1.5', boost: 0.3 }).bonusMinor, 0n);
  // 1 x 1 x 0.5 = exactly 0.5 -> 1 (half up, never banker's rounding)
  assert.equal(slip.computePotential({ stakeMinor: 1, combinedOdds: '1', boost: 0.5 }).bonusMinor, 1n);
  assert.equal(slip.computePotential({ stakeMinor: 1, combinedOdds: '1', boost: 0.4999 }).bonusMinor, 0n);
});

test('the bonus is capped at the maximum bonus and reported as capped', () => {
  const capped = slip.computePotential({ stakeMinor: 1000, combinedOdds: '9.96', boost: 0.04, capMinor: 300 });
  assert.equal(capped.bonusMinor, 300n);
  assert.equal(capped.totalMinor, 10260n);
  assert.equal(capped.boostedOdds, '10.26');
  assert.equal(capped.capped, true);
  const exact = slip.computePotential({ stakeMinor: 1000, combinedOdds: '9.96', boost: 0.04, capMinor: 398 });
  assert.equal(exact.bonusMinor, 398n);
  assert.equal(exact.capped, false);
  assert.equal(slip.computePotential({ stakeMinor: 1000, combinedOdds: '9.96', boost: 0.04, capMinor: 0 }).bonusMinor, 0n);
  assert.equal(slip.computePotential({ stakeMinor: 1000, combinedOdds: '9.96', boost: 0.04, capMinor: null }).capped, false);
});

test('no boost leaves odds and return at the base values', () => {
  const none = slip.computePotential({ stakeMinor: 1000, combinedOdds: 9.96, boost: 0 });
  assert.equal(none.bonusMinor, 0n);
  assert.equal(none.boostedOdds, none.baseOdds);
});

test('huge exact combined odds stay exact (no float in the money path)', () => {
  const result = slip.computePotential({ stakeMinor: 1000, combinedOdds: '123456789012345678901234567890.55', boost: 0 });
  assert.equal(result.grossMinor, 123456789012345678901234567890550n);
  assert.equal(result.baseOdds, '123456789012345678901234567890.55');
});

test('invalid inputs give no result', () => {
  for (const input of [
    { stakeMinor: 0, combinedOdds: '2', boost: 0.1 }, { stakeMinor: -5, combinedOdds: '2', boost: 0.1 },
    { stakeMinor: 1.5, combinedOdds: '2', boost: 0.1 }, { stakeMinor: 100, combinedOdds: 'x', boost: 0.1 },
    { stakeMinor: 100, combinedOdds: '2', boost: -0.1 }, { stakeMinor: 100, combinedOdds: 0, boost: 0.1 },
    { stakeMinor: 100, combinedOdds: '2', boost: 0.1, capMinor: -1 }, { stakeMinor: null, combinedOdds: '2', boost: 0.1 },
  ]) assert.equal(slip.computePotential(input), null);
});

test('money text uses minor units with comma decimals and thousands spacing', () => {
  assert.equal(slip.formatMoney(10365, 'EUR'), '€103,65');
  assert.equal(slip.formatMoney(105061, 'EUR'), '€1 050,61');
  assert.equal(slip.formatMoney(5n, 'USD'), '$0,05');
  assert.equal(slip.formatMoney(12345, 'CHF'), 'CHF 123,45');
  assert.equal(slip.formatMoney(null, 'EUR'), '—');
  assert.equal(slip.formatStake(1000, 'EUR'), '10 €');
  assert.equal(slip.formatStake(1250, 'EUR'), '12,50 €');
});

test('fixtures are deterministic and rows map to legs (SGP is one priced leg, bad rows are skipped)', () => {
  assert.deepEqual(slip.fixtureFor(1), slip.fixtureFor(1));
  assert.notDeepEqual(slip.fixtureFor(1), slip.fixtureFor(2));
  assert.equal(slip.fixtureFor(3).pick, slip.fixtureFor(3).away);
  const rows = [
    { odds: '1.50', type: 'STANDARD' },
    { odds: '1.40', type: 'EXCLUDED' },
    { odds: '', type: 'STANDARD' },
    { odds: '3.20', type: 'SGP_COMPOSITE', legOdds: ['1.5', '', '2.1'] },
    { odds: '1.10', type: 'STANDARD' },
  ];
  const legs = slip.legsFromRows(rows, { minSelectionOdds: 1.3 });
  assert.deepEqual(legs.map((leg) => leg.position), [1, 2, 4, 5]);
  assert.deepEqual(legs.map((leg) => leg.counted), [true, false, true, false]);
  assert.equal(legs[2].kind, 'sgp');
  assert.equal(legs[2].legCount, 2);
  assert.deepEqual(legs, slip.legsFromRows(rows, { minSelectionOdds: 1.3 }));
  // preview product counts only counted legs: 1.50 x 3.20 = 4.80
  assert.equal(slip.formatOdds(slip.productOdds(legs)), '4.80');
  assert.equal(slip.productOdds([]), null);
});

test('computePotential accepts the preview product (rational) as odds', () => {
  const product = slip.productOdds(slip.legsFromRows([{ odds: '1.5' }, { odds: '2' }]));
  assert.equal(slip.computePotential({ stakeMinor: 1000, combinedOdds: product, boost: 0 }).grossMinor, 3000n);
});

test('percent text trims trailing zeros', () => {
  assert.equal(slip.percentText(0.37), '37%');
  assert.equal(slip.percentText(0.12345), '12.35%');
});
