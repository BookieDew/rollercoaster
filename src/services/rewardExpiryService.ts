import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction } from '../db/repositories/transaction';
import { calculateElapsedPct, hasRideEnded } from '../computations';
import type { UserReward } from '../types/userReward';
import { LEGACY_BRAND_ID } from '../types/brand';
import { resolveRideMathSnapshot } from './rideMathSnapshot';
import { config } from '../config';

export type ExpiryTrigger = 'OPT_IN' | 'JOB';

export interface ExpireRewardsResult {
  /** GRANTED rewards moved to EXPIRED because valid_until passed. */
  granted_expired: number;
  /** ENTERED rewards moved to EXPIRED because the ride ended or crashed unlocked. */
  entered_expired: number;
  total_expired: number;
  evaluated_at: string;
}

const GRANTED_BATCH_SIZE = 500;

/**
 * Moves one GRANTED reward whose validity has elapsed to EXPIRED. Conditional
 * (only while it is still GRANTED and past valid_until) and audited in the same
 * transaction; returns false when another request already changed the reward.
 */
export async function expireGrantedReward(
  reward: UserReward,
  now: Date,
  trigger: ExpiryTrigger
): Promise<boolean> {
  const nowIso = now.toISOString();
  return runInTransaction(async (tx) => {
    const updated = await userRewardRepository.updateStatus(reward.id, 'EXPIRED', undefined, {
      tx,
      fromStatus: 'GRANTED',
      validUntilBefore: nowIso,
    });
    if (!updated) return false;

    await auditLogRepository.append({
      entityType: 'user_reward',
      entityId: reward.id,
      action: 'EXPIRE',
      payload: {
        brandId: reward.brandId ?? LEGACY_BRAND_ID,
        reason: 'VALIDITY_ELAPSED',
        trigger,
        previousStatus: 'GRANTED',
        validUntil: reward.validUntil,
        expiredAt: nowIso,
      },
    }, tx);
    return true;
  });
}

async function expireGrantedPastValidity(now: Date): Promise<number> {
  let expired = 0;
  for (;;) {
    const batch = await userRewardRepository.findGrantedPastValidity(now.toISOString(), GRANTED_BATCH_SIZE);
    let changedInBatch = 0;
    for (const reward of batch) {
      if (await expireGrantedReward(reward, now, 'JOB')) changedInBatch += 1;
    }
    expired += changedInBatch;
    // A batch that changed nothing would be re-read forever, so stop on it.
    if (batch.length < GRANTED_BATCH_SIZE || changedInBatch === 0) return expired;
  }
}

/** True once an ENTERED ride can no longer be locked: its end time or crash has passed. */
async function isRideOver(reward: UserReward, now: Date): Promise<boolean> {
  const rideMath = await resolveRideMathSnapshot(reward);
  if (!rideMath) {
    // Without saved ride math fall back to the reward's own end time.
    return new Date(reward.endTime).getTime() <= now.getTime();
  }
  const elapsedPct = calculateElapsedPct(rideMath.startTime, rideMath.endTime, now);
  const crashed = elapsedPct >= rideMath.crashPct && rideMath.crashPct < 1;
  return crashed || hasRideEnded(rideMath.startTime, rideMath.endTime, now);
}

/**
 * ENTERED rewards are expired only once their ride has been over for at least
 * `graceSeconds`. Until then quote and lock keep reporting the ride's own
 * terminal result (RIDE_CRASHED / RIDE_ENDED). "Over for at least the grace"
 * is evaluated as "already over at now - grace", which reuses the ride helpers.
 */
async function expireEnteredWithOverRide(now: Date, graceSeconds: number): Promise<number> {
  const nowIso = now.toISOString();
  const overSince = new Date(now.getTime() - graceSeconds * 1000);
  let expired = 0;
  for (const reward of await userRewardRepository.findEntered()) {
    if (!await isRideOver(reward, overSince)) continue;

    const changed = await runInTransaction(async (tx) => {
      const updated = await userRewardRepository.updateStatus(reward.id, 'EXPIRED', undefined, {
        tx,
        fromStatus: 'ENTERED',
      });
      if (!updated) return false;

      await auditLogRepository.append({
        entityType: 'user_reward',
        entityId: reward.id,
        action: 'EXPIRE',
        payload: {
          brandId: reward.brandId ?? LEGACY_BRAND_ID,
          reason: 'RIDE_OVER_WITHOUT_LOCK',
          trigger: 'JOB',
          previousStatus: 'ENTERED',
          betId: reward.betId,
          rideExpiryGraceSeconds: graceSeconds,
          expiredAt: nowIso,
        },
      }, tx);
      return true;
    });
    if (changed) expired += 1;
  }
  return expired;
}

/**
 * Expiry job. Idempotent: every change is a conditional status update with one
 * audit row, so running it twice (or concurrently) changes each reward once.
 *  - GRANTED past valid_until -> EXPIRED
 *  - ENTERED whose ride ended or crashed without a lock, at least
 *    `rideGraceSeconds` (RIDE_EXPIRY_GRACE_SECONDS) ago -> EXPIRED
 */
export async function expireRewards(
  now: Date = new Date(),
  rideGraceSeconds: number = config.rewards.rideExpiryGraceSeconds
): Promise<ExpireRewardsResult> {
  const grantedExpired = await expireGrantedPastValidity(now);
  const enteredExpired = await expireEnteredWithOverRide(now, rideGraceSeconds);
  return {
    granted_expired: grantedExpired,
    entered_expired: enteredExpired,
    total_expired: grantedExpired + enteredExpired,
    evaluated_at: now.toISOString(),
  };
}

export interface RewardExpiryJob {
  stop(): void;
}

/**
 * Runs expireRewards every `intervalSeconds`. A zero interval starts nothing.
 * The timer never keeps the process alive, a run never overlaps the previous
 * one, and a failing run is logged instead of crashing the server.
 */
export function startRewardExpiryJob(
  intervalSeconds: number,
  run: () => Promise<ExpireRewardsResult> = () => expireRewards()
): RewardExpiryJob | null {
  if (intervalSeconds <= 0) return null;

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    run()
      .then((result) => {
        if (result.total_expired > 0) {
          console.log(`[expiry] expired ${result.total_expired} reward(s)`, result);
        }
      })
      .catch((error) => {
        console.error('[ERROR] Reward expiry job failed:', error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalSeconds * 1000);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}

export const rewardExpiryService = {
  expireRewards,
  expireGrantedReward,
  startRewardExpiryJob,
};
