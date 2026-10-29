import { v4 as uuidv4 } from 'uuid';
import { betBoostLockRepository } from '../db/repositories/betBoostLockRepository';
import { settlementRepository } from '../db/repositories/settlementRepository';
import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import {
  runInTransaction,
  Rollback,
  isUniqueViolation,
  type TransactionScope,
} from '../db/repositories/transaction';
import {
  calculateSettlement,
  SettlementCalculationError,
  type SettlementCalculation,
  type SettlementMinimums,
} from '../computations/settlementCalculator';
import { issueReplacementReward } from './rewardEntitlementService';
import type { BetBoostLock } from '../types/betBoostLock';
import type { UserReward } from '../types/userReward';
import type { Selection } from '../types/ticket';
import {
  replacementStatusOf,
  toSettlementResponse,
  type BetSettlement,
  type SettlementLeg,
  type SettlementOutcome,
  type SettlementResponse,
} from '../types/settlement';
import { ReasonCode } from '../types/reasonCodes';
import { LEGACY_BRAND_ID } from '../types/brand';

/**
 * Settlement of locked bets (Phase 1a contract, section 4).
 *
 * The pure calculator (src/computations/settlementCalculator.ts) decides the
 * bet result and the integer bonus; this service supplies its inputs from the
 * frozen snapshots and persists the outcome:
 *  - stored selections: the reward's whole stored ticket (ticket_snapshot.selections);
 *  - stake, currency and bonus cap: the reward's opt-in money snapshot;
 *  - locked boost: the lock;
 *  - minimums: the lock snapshot (profile minimums frozen at opt-in/lock).
 *
 * Every settle and resettle writes, in one transaction, the settlement
 * revision, any replacement reward or revocation, and audit rows. Races are
 * resolved by unique(lock_id, revision), one current revision per lock and a
 * conditional "supersede" update; they never surface as 500.
 */

export interface SettleInput {
  brandId: string;
  betId: string;
  outcome: SettlementOutcome;
  /** Required for SETTLED, absent otherwise (enforced by the HTTP schema and the calculator). */
  legs?: SettlementLeg[];
}

export interface ResettleInput extends SettleInput {
  /** Correction reason, 1-500 characters. */
  reason: string;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
    details?: unknown;
  };
}

/** Normalized request: legs sorted by selection_id (null for CASHOUT/CANCELLED). */
interface NormalizedPayload {
  outcome: SettlementOutcome;
  legs: SettlementLeg[] | null;
}

interface MoneySnapshot {
  stakeMinor: number;
  currency: string;
  bonusCapMinor: number;
}

interface PreparedSettlement {
  lock: BetBoostLock;
  reward: UserReward;
  money: MoneySnapshot;
  payload: NormalizedPayload;
  calculation: SettlementCalculation;
}

type Prepared = { ok: true; value: PreparedSettlement } | { ok: false; result: ServiceResult<never> };

function failure(code: ReasonCode, message: string, details?: unknown): ServiceResult<never> {
  return { success: false, error: details === undefined ? { code, message } : { code, message, details } };
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Sorts legs by selection_id and keeps only selection_id and result. */
export function normalizeSettlementPayload(
  outcome: SettlementOutcome,
  legs: readonly SettlementLeg[] | null | undefined
): NormalizedPayload {
  if (outcome !== 'SETTLED' || !legs) {
    return { outcome, legs: null };
  }
  const sorted = legs
    .map((leg) => ({ selection_id: leg.selection_id, result: leg.result }))
    .sort((a, b) => compareIds(a.selection_id, b.selection_id) || compareIds(a.result, b.result));
  return { outcome, legs: sorted };
}

function payloadKey(payload: NormalizedPayload): string {
  return JSON.stringify([payload.outcome, payload.legs]);
}

function storedPayloadKey(settlement: BetSettlement): string {
  return payloadKey(normalizeSettlementPayload(settlement.outcome, settlement.legs));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Minimums frozen in the lock snapshot, or null when the snapshot predates them. */
function minimumsOf(lock: BetBoostLock): SettlementMinimums | null {
  const snapshot = (lock.snapshot ?? {}) as Partial<BetBoostLock['snapshot']>;
  const { minSelections, minCombinedOdds, minSelectionOdds } = snapshot;
  if (!isFiniteNumber(minSelections) || !isFiniteNumber(minCombinedOdds) || !isFiniteNumber(minSelectionOdds)) {
    return null;
  }
  return { minSelections, minCombinedOdds, minSelectionOdds };
}

/**
 * Money snapshot of a reward. Rewards locked without a stake/currency/cap
 * snapshot (legacy data, or an internal opt-in without money) cannot be settled:
 * a missing stake is never replaced by a default.
 */
function moneyOf(reward: UserReward): MoneySnapshot | null {
  const { stakeMinor, currency, bonusCapMinor } = reward;
  if (stakeMinor === null || stakeMinor === undefined
    || currency === null || currency === undefined
    || bonusCapMinor === null || bonusCapMinor === undefined) {
    return null;
  }
  return { stakeMinor, currency, bonusCapMinor };
}

function storedSelectionsOf(reward: UserReward): Selection[] | null {
  const selections = reward.ticketSnapshot?.selections;
  return Array.isArray(selections) ? (selections as Selection[]) : null;
}

function unavailable(message: string): Prepared {
  return {
    ok: false,
    result: failure(ReasonCode.SETTLEMENT_UNAVAILABLE, `Bet cannot be settled: ${message}`),
  };
}

/** Maps calculator errors to API failures; anything else is rethrown. */
function calculationFailure(error: unknown): ServiceResult<never> {
  if (!(error instanceof SettlementCalculationError)) {
    throw error;
  }
  if (error.code === 'INVALID_LEGS') {
    return failure(ReasonCode.VALIDATION_ERROR, error.message, error.problems);
  }
  // INVALID_INPUT comes from stored data (odds, stake, boost, cap, minimums), never from the
  // request, so it is a state problem and the calculator's message is not echoed.
  return failure(ReasonCode.SETTLEMENT_UNAVAILABLE, 'Bet cannot be settled: its stored ticket or money snapshot is invalid');
}

/** Loads the lock, reward and snapshots, normalizes the payload and runs the calculator. */
async function prepare(input: SettleInput): Promise<Prepared> {
  const lock = await betBoostLockRepository.findByBetId(input.betId, input.brandId);
  if (!lock) {
    return {
      ok: false,
      result: failure(ReasonCode.LOCK_NOT_FOUND, `No boost lock found for bet ${input.betId} in brand ${input.brandId}`),
    };
  }

  const reward = await userRewardRepository.findById(lock.rewardId);
  if (!reward) {
    return unavailable('the reward of this lock no longer exists');
  }
  const money = moneyOf(reward);
  if (!money) {
    return unavailable('the reward has no stake, currency and bonus cap snapshot (it was opted in before Phase 1a)');
  }
  const storedSelections = storedSelectionsOf(reward);
  if (!storedSelections) {
    return unavailable('the reward has no stored ticket');
  }
  const minimums = minimumsOf(lock);
  if (!minimums) {
    return unavailable('the lock has no snapshot of the profile minimums');
  }

  const payload = normalizeSettlementPayload(input.outcome, input.legs);
  let calculation: SettlementCalculation;
  try {
    calculation = calculateSettlement({
      outcome: input.outcome,
      legs: input.legs,
      storedSelections,
      stakeMinor: money.stakeMinor,
      lockedBoostPct: lock.lockedBoostPct,
      bonusCapMinor: money.bonusCapMinor,
      minimums,
    });
  } catch (error) {
    return { ok: false, result: calculationFailure(error) };
  }

  return { ok: true, value: { lock, reward, money, payload, calculation } };
}

/** Bonus of the revision before `settlement`, or null for revision 1. */
async function previousBonusOf(settlement: BetSettlement): Promise<number | null> {
  if (settlement.revision <= 1) return null;
  const previous = await settlementRepository.findRevision(settlement.lockId, settlement.revision - 1);
  return previous ? previous.bonusMinor : null;
}

async function respond(settlement: BetSettlement): Promise<ServiceResult<SettlementResponse>> {
  return { success: true, data: toSettlementResponse(settlement, await previousBonusOf(settlement)) };
}

/** Identical normalized payload -> the stored revision; anything else -> 409. */
async function replayOrConflict(
  existing: BetSettlement,
  payload: NormalizedPayload,
  conflictMessage: string
): Promise<ServiceResult<SettlementResponse>> {
  if (storedPayloadKey(existing) === payloadKey(payload)) {
    return respond(existing);
  }
  return failure(ReasonCode.BET_ALREADY_SETTLED, conflictMessage);
}

function isPastValidity(reward: UserReward, now: Date): boolean {
  return reward.validUntil != null && now.getTime() > new Date(reward.validUntil).getTime();
}

/**
 * Returns the token of a cancelled bet: a replacement reward, unless the
 * original's validity has already passed (then none is issued).
 */
async function issueReplacementIfValid(
  original: UserReward,
  settlementId: string,
  betId: string,
  trigger: 'SETTLE' | 'RESETTLE',
  tx: TransactionScope,
  now: Date
): Promise<UserReward | null> {
  if (isPastValidity(original, now)) {
    return null;
  }
  return issueReplacementReward(original, { settlementId, betId, trigger }, tx, now);
}

type RevocationResult = 'REVOKED' | 'NOTHING_TO_REVOKE' | 'ALREADY_USED';

/** True when a reward has been opted into (a ride was started with it). */
function wasEntered(reward: UserReward): boolean {
  return reward.status === 'ENTERED' || reward.status === 'USED' || reward.betId !== null;
}

/**
 * Revokes a replacement that is still GRANTED (-> EXPIRED, audited). A
 * replacement that was already opted into cannot be revoked. A replacement
 * that expired unused needs nothing.
 */
async function revokeReplacement(
  replacementId: string,
  settlementId: string,
  betId: string,
  tx: TransactionScope,
  now: Date
): Promise<RevocationResult> {
  const replacement = await userRewardRepository.findById(replacementId, tx);
  if (!replacement) {
    return 'NOTHING_TO_REVOKE';
  }
  if (replacement.status === 'GRANTED') {
    const revoked = await userRewardRepository.updateStatus(replacementId, 'EXPIRED', undefined, {
      tx,
      fromStatus: 'GRANTED',
    });
    if (!revoked) {
      // Changed by a concurrent request after the read above: decide from the
      // current state. Used replacements cannot be revoked; one that expired or
      // was revoked unused needs nothing. Still GRANTED (the update changed no
      // rows for an unknown reason) fails safe: the resettle aborts and rolls back.
      const current = await userRewardRepository.findById(replacementId, tx);
      if (current && (current.status === 'GRANTED' || wasEntered(current))) {
        return 'ALREADY_USED';
      }
      return 'NOTHING_TO_REVOKE';
    }
    await auditLogRepository.append({
      entityType: 'user_reward',
      entityId: replacementId,
      action: 'EXPIRE',
      payload: {
        brandId: replacement.brandId ?? LEGACY_BRAND_ID,
        reason: 'REVOKED_BY_RESETTLEMENT',
        trigger: 'RESETTLE',
        previousStatus: 'GRANTED',
        settlementId,
        betId,
        replacesRewardId: replacement.replacesRewardId ?? null,
        expiredAt: now.toISOString(),
      },
    }, tx);
    return 'REVOKED';
  }
  return wasEntered(replacement) ? 'ALREADY_USED' : 'NOTHING_TO_REVOKE';
}

function auditPayload(
  prepared: PreparedSettlement,
  settlement: BetSettlement
): Record<string, unknown> {
  return {
    brandId: settlement.brandId,
    betId: settlement.betId,
    lockId: settlement.lockId,
    rewardId: prepared.reward.id,
    userId: prepared.reward.userId,
    revision: settlement.revision,
    outcome: settlement.outcome,
    legs: settlement.legs,
    betResult: settlement.betResult,
    currency: settlement.currency,
    stakeMinor: settlement.stakeMinor,
    totalReturnMinor: settlement.totalReturnMinor,
    lockedBoostPct: settlement.lockedBoostPct,
    bonusMinor: settlement.bonusMinor,
    bonusCapMinor: settlement.bonusCapMinor,
    capApplied: settlement.capApplied,
    minimumsMet: settlement.minimumsMet,
    replacementRewardId: settlement.replacementRewardId,
    replacementStatus: replacementStatusOf(settlement),
  };
}

function revisionInput(
  prepared: PreparedSettlement,
  id: string,
  revision: number,
  replacementRewardId: string | null,
  reason: string | null,
  settledAt: string
) {
  const { lock, money, payload, calculation } = prepared;
  return {
    id,
    brandId: lock.brandId,
    betId: lock.betId,
    lockId: lock.id,
    revision,
    outcome: payload.outcome,
    betResult: calculation.betResult,
    legs: payload.legs,
    currency: money.currency,
    stakeMinor: money.stakeMinor,
    // Exact decimal string: the total return can exceed 2^53 (no size limit).
    totalReturnMinor: calculation.totalReturnMinor === null ? null : calculation.totalReturnMinor.toString(),
    lockedBoostPct: lock.lockedBoostPct,
    bonusMinor: calculation.bonusMinor,
    bonusCapMinor: money.bonusCapMinor,
    capApplied: calculation.capApplied,
    minimumsMet: calculation.minimumsMet,
    replacementRewardId,
    reason,
    settledAt,
  };
}

/**
 * POST /settlement: settles a locked bet (revision 1). An identical normalized
 * replay returns the current revision; a different payload is a conflict.
 */
export async function settleBet(input: SettleInput): Promise<ServiceResult<SettlementResponse>> {
  const prepared = await prepare(input);
  if (!prepared.ok) return prepared.result;
  const { lock, reward, payload, calculation } = prepared.value;

  const conflictMessage = 'Bet is already settled with a different result; use POST /api/settlement/resettle to correct it';
  const existing = await settlementRepository.findCurrentByLockId(lock.id);
  if (existing) {
    return replayOrConflict(existing, payload, conflictMessage);
  }

  const settlementId = uuidv4();
  const now = new Date();
  try {
    const created = await runInTransaction(async (tx) => {
      const replacement = calculation.issueReplacement
        ? await issueReplacementIfValid(reward, settlementId, lock.betId, 'SETTLE', tx, now)
        : null;
      const settlement = await settlementRepository.create(
        revisionInput(prepared.value, settlementId, 1, replacement?.id ?? null, null, now.toISOString()),
        tx
      );
      await auditLogRepository.append({
        entityType: 'bet_settlement',
        entityId: settlement.id,
        action: 'SETTLE',
        payload: auditPayload(prepared.value, settlement),
      }, tx);
      return settlement;
    });
    return { success: true, data: toSettlementResponse(created, null) };
  } catch (error) {
    // A concurrent settlement won (lock_id, revision 1): re-read and apply the replay rule.
    if (isUniqueViolation(error)) {
      const winner = await settlementRepository.findCurrentByLockId(lock.id);
      if (winner) {
        return replayOrConflict(winner, payload, conflictMessage);
      }
    }
    throw error;
  }
}

type ResettleTransactionResult =
  | { kind: 'CREATED'; settlement: BetSettlement }
  | { kind: 'RACE' }
  | { kind: 'REPLACEMENT_ALREADY_USED'; replacementRewardId: string };

/**
 * POST /settlement/resettle: corrects the current revision n by creating
 * revision n+1 (marked current). A payload identical to the current revision is
 * a replay. Replacement tokens follow the CANCELLED transitions: entering
 * CANCELLED issues one, leaving CANCELLED revokes a still-GRANTED one, and a
 * replacement that was already used makes the correction a 409 with nothing
 * changed.
 */
export async function resettleBet(input: ResettleInput): Promise<ServiceResult<SettlementResponse>> {
  const prepared = await prepare(input);
  if (!prepared.ok) return prepared.result;
  const { lock, reward, payload, calculation } = prepared.value;

  const current = await settlementRepository.findCurrentByLockId(lock.id);
  if (!current) {
    return failure(
      ReasonCode.SETTLEMENT_NOT_FOUND,
      `Bet ${input.betId} has not been settled yet; use POST /api/settlement`
    );
  }
  if (storedPayloadKey(current) === payloadKey(payload)) {
    return respond(current);
  }

  const raceMessage = 'Settlement was corrected concurrently; read the current revision and retry';
  const settlementId = uuidv4();
  const now = new Date();
  let result: ResettleTransactionResult;
  try {
    result = await runInTransaction<ResettleTransactionResult>(async (tx) => {
      if (!await settlementRepository.markSuperseded(current.id, tx)) {
        throw new Rollback<ResettleTransactionResult>({ kind: 'RACE' });
      }

      const wasCancelled = current.betResult === 'CANCELLED';
      const isCancelled = calculation.betResult === 'CANCELLED';
      let replacementRewardId: string | null = null;
      let revokedRewardId: string | null = null;
      if (isCancelled && wasCancelled) {
        // Still cancelled: the token already returned (or not issued) stays as it is.
        replacementRewardId = current.replacementRewardId;
      } else if (isCancelled) {
        const replacement = await issueReplacementIfValid(reward, settlementId, lock.betId, 'RESETTLE', tx, now);
        replacementRewardId = replacement?.id ?? null;
      } else if (wasCancelled && current.replacementRewardId) {
        const revocation = await revokeReplacement(
          current.replacementRewardId, settlementId, lock.betId, tx, now
        );
        if (revocation === 'ALREADY_USED') {
          throw new Rollback<ResettleTransactionResult>({
            kind: 'REPLACEMENT_ALREADY_USED',
            replacementRewardId: current.replacementRewardId,
          });
        }
        revokedRewardId = revocation === 'REVOKED' ? current.replacementRewardId : null;
      }

      const settlement = await settlementRepository.create(
        revisionInput(
          prepared.value, settlementId, current.revision + 1, replacementRewardId, input.reason, now.toISOString()
        ),
        tx
      );
      await auditLogRepository.append({
        entityType: 'bet_settlement',
        entityId: settlement.id,
        action: 'RESETTLE',
        payload: {
          ...auditPayload(prepared.value, settlement),
          reason: input.reason,
          previousSettlementId: current.id,
          previousRevision: current.revision,
          previousBetResult: current.betResult,
          previousBonusMinor: current.bonusMinor,
          bonusDeltaMinor: settlement.bonusMinor - current.bonusMinor,
          revokedRewardId,
        },
      }, tx);
      return { kind: 'CREATED', settlement };
    });
  } catch (error) {
    // A concurrent correction inserted revision n+1 first.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    result = { kind: 'RACE' };
  }

  if (result.kind === 'CREATED') {
    return { success: true, data: toSettlementResponse(result.settlement, current.bonusMinor) };
  }
  if (result.kind === 'REPLACEMENT_ALREADY_USED') {
    return failure(
      ReasonCode.REPLACEMENT_ALREADY_USED,
      'The replacement reward issued for this cancelled bet has already been used; the settlement was not changed',
      { replacement_reward_id: result.replacementRewardId }
    );
  }
  const winner = await settlementRepository.findCurrentByLockId(lock.id);
  if (winner) {
    return replayOrConflict(winner, payload, raceMessage);
  }
  return failure(ReasonCode.BET_ALREADY_SETTLED, raceMessage);
}

/**
 * GET /settlement/:betId?brand_id=: the current revision, or null when the bet
 * (brand_id, bet_id) has not been settled.
 */
export async function getSettlementByBetId(
  brandId: string,
  betId: string
): Promise<ServiceResult<SettlementResponse | null>> {
  const settlement = await settlementRepository.findCurrentByBet(brandId, betId);
  if (!settlement) {
    return { success: true, data: null };
  }
  return respond(settlement);
}

export const settlementService = {
  settleBet,
  resettleBet,
  getSettlementByBetId,
};
