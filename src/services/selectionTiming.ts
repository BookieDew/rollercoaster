import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';

export type SelectionTimingReason =
  | ReasonCode.SELECTION_ALREADY_SETTLED
  | ReasonCode.SELECTION_ALREADY_STARTED
  | ReasonCode.SELECTION_TIMING_REQUIRED;

/** Most serious first: the order in which a failing ticket reports its timing reason. */
const SEVERITY: readonly SelectionTimingReason[] = [
  ReasonCode.SELECTION_ALREADY_SETTLED,
  ReasonCode.SELECTION_ALREADY_STARTED,
  ReasonCode.SELECTION_TIMING_REQUIRED,
];

export interface SelectionTimingOptions {
  /**
   * Open boosts: every selection must carry `starts_at` or `live: true`. Personal opt-in leaves
   * this off and checks only the fields that were sent.
   */
  requireTiming: boolean;
}

/**
 * Service-side slip timing protection (owner rule "Open boosts: base-case rules"). A settled selection is never
 * boostable; a live selection is boostable until settled; a prematch selection only strictly before its
 * kick-off. Returns every distinct failing reason, most serious first (empty = timing is fine). Pure.
 */
export function selectionTimingReasons(
  selections: readonly Selection[],
  now: Date,
  options: SelectionTimingOptions
): SelectionTimingReason[] {
  const found = new Set<SelectionTimingReason>();
  const nowMs = now.getTime();
  for (const selection of selections) {
    if (selection.settled === true) {
      found.add(ReasonCode.SELECTION_ALREADY_SETTLED);
      continue;
    }
    if (selection.live === true) continue;
    if (selection.starts_at !== undefined) {
      if (nowMs >= Date.parse(selection.starts_at)) found.add(ReasonCode.SELECTION_ALREADY_STARTED);
      continue;
    }
    if (options.requireTiming) found.add(ReasonCode.SELECTION_TIMING_REQUIRED);
  }
  return SEVERITY.filter((reason) => found.has(reason));
}

const MESSAGES: Record<SelectionTimingReason, string> = {
  [ReasonCode.SELECTION_ALREADY_SETTLED]: 'A selection is already settled',
  [ReasonCode.SELECTION_ALREADY_STARTED]: 'A prematch selection has already started',
  [ReasonCode.SELECTION_TIMING_REQUIRED]: 'Every selection needs starts_at or live: true',
};

export function selectionTimingMessage(reason: SelectionTimingReason): string {
  return MESSAGES[reason];
}
