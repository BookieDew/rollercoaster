import { selectionTimingReasons, selectionTimingMessage } from '../../src/services/selectionTiming';
import { ReasonCode } from '../../src/types/reasonCodes';

describe('selectionTimingReasons', () => {
  const kickOff = '2026-11-04T18:00:00.000Z';
  const kickOffMs = Date.parse(kickOff);
  const open = { requireTiming: true };
  const personal = { requireTiming: false };

  it('allows a prematch selection strictly before kick-off and refuses it from kick-off on', () => {
    const selections = [{ id: 'a', odds: 2, starts_at: kickOff }];
    expect(selectionTimingReasons(selections, new Date(kickOffMs - 1), open)).toEqual([]);
    expect(selectionTimingReasons(selections, new Date(kickOffMs), open)).toEqual([ReasonCode.SELECTION_ALREADY_STARTED]);
    expect(selectionTimingReasons(selections, new Date(kickOffMs + 1), personal))
      .toEqual([ReasonCode.SELECTION_ALREADY_STARTED]);
  });

  it('compares instants, whatever the offset the kick-off was written in', () => {
    const selections = [{ id: 'a', odds: 2, starts_at: '2026-11-04T20:00:00+02:00' }];
    expect(selectionTimingReasons(selections, new Date(kickOffMs - 1), open)).toEqual([]);
    expect(selectionTimingReasons(selections, new Date(kickOffMs), open)).toEqual([ReasonCode.SELECTION_ALREADY_STARTED]);
  });

  it('allows a live selection until it is settled, and never a settled one', () => {
    const now = new Date(kickOffMs + 3_600_000);
    expect(selectionTimingReasons([{ id: 'a', odds: 2, live: true, starts_at: kickOff }], now, open)).toEqual([]);
    expect(selectionTimingReasons([{ id: 'a', odds: 2, live: true, settled: true }], now, open))
      .toEqual([ReasonCode.SELECTION_ALREADY_SETTLED]);
    expect(selectionTimingReasons([{ id: 'a', odds: 2, settled: true }], now, personal))
      .toEqual([ReasonCode.SELECTION_ALREADY_SETTLED]);
  });

  it('requires starts_at or live: true for open boosts only', () => {
    const bare = [{ id: 'a', odds: 2 }, { id: 'b', odds: 2, live: false }];
    expect(selectionTimingReasons(bare, new Date(kickOffMs), open)).toEqual([ReasonCode.SELECTION_TIMING_REQUIRED]);
    expect(selectionTimingReasons(bare, new Date(kickOffMs), personal)).toEqual([]);
  });

  it('reports each reason once, most serious first, each with a message', () => {
    const reasons = selectionTimingReasons([
      { id: 'a', odds: 2 },
      { id: 'b', odds: 2, starts_at: kickOff },
      { id: 'c', odds: 2, settled: true },
      { id: 'd', odds: 2, settled: true },
    ], new Date(kickOffMs), open);
    expect(reasons).toEqual([
      ReasonCode.SELECTION_ALREADY_SETTLED,
      ReasonCode.SELECTION_ALREADY_STARTED,
      ReasonCode.SELECTION_TIMING_REQUIRED,
    ]);
    for (const reason of reasons) expect(selectionTimingMessage(reason)).toMatch(/selection/i);
  });
});
