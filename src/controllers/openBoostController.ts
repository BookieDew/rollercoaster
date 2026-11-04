import { Request, Response, NextFunction } from 'express';
import { openBoostService } from '../services/openBoostService';
import { openBoostOfferSchema, openOptInSchema } from '../validation/schemas';
import { toOptInResponse } from '../types/userReward';
import { createApiError } from '../middleware/errorHandler';
import { ReasonCode } from '../types/reasonCodes';

/**
 * Open-boost offer for the bet slip. Shows the applicable profile's entry criteria only: never the boost range,
 * the bonus cap, a ride path or any timing.
 */
export interface OpenBoostOfferResponse {
  brand_id: string;
  user_id: string;
  qualifies: boolean;
  /** ELIGIBLE when the slip qualifies, otherwise the most important failing reason. */
  reason_code: ReasonCode;
  /** Every failing reason (empty when the slip qualifies). */
  reason_codes: ReasonCode[];
  profile: {
    profile_version_id: string;
    name: string;
    description: string | null;
    segment: string | null;
    min_selections: number;
    min_combined_odds: number;
    min_selection_odds: number;
  } | null;
  qualifying_selection_count: number | null;
  total_selection_count: number;
  /** Exact decimal string beyond the double range; null when no open profile applies. */
  combined_odds: number | string | null;
}

/**
 * POST /boost/offers - Which open boost would apply to this slip, and does it qualify now (read-only)
 */
export async function getOpenOffer(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = openBoostOfferSchema.parse(req.body);
    const selections = validated.ticket.selections;

    const offer = await openBoostService.getOpenOffer({
      brandId: validated.brand_id,
      userId: validated.user_id,
      segments: validated.segments ?? [],
      stakeMinor: validated.stake_minor,
      currency: validated.currency,
      selections,
    });

    const response: OpenBoostOfferResponse = {
      brand_id: validated.brand_id,
      user_id: validated.user_id,
      qualifies: offer.qualifies,
      reason_code: offer.reasonCodes[0] ?? ReasonCode.ELIGIBLE,
      reason_codes: offer.reasonCodes,
      profile: offer.profile
        ? {
            profile_version_id: offer.profile.id,
            name: offer.profile.name,
            description: offer.profile.description,
            segment: offer.profile.segment ?? null,
            min_selections: offer.profile.minSelections,
            min_combined_odds: offer.profile.minCombinedOdds,
            min_selection_odds: offer.profile.minSelectionOdds,
          }
        : null,
      qualifying_selection_count: offer.ticket ? offer.ticket.qualifying.length : null,
      total_selection_count: selections.length,
      combined_odds: offer.ticket ? offer.ticket.combinedOddsDisplay : null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /boost/open-opt-in - The player uses an open boost on a placed bet: grant + opt-in in one transaction
 */
export async function openOptIn(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = openOptInSchema.parse(req.body);

    const result = await openBoostService.openOptIn({
      brandId: validated.brand_id,
      userId: validated.user_id,
      segments: validated.segments ?? [],
      profileVersionId: validated.profile_version_id,
      betId: validated.bet_id,
      stakeMinor: validated.stake_minor,
      currency: validated.currency,
      selections: validated.ticket.selections,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to use open boost',
        result.error?.code!,
        undefined,
        result.error?.details
      );
    }

    res.json(toOptInResponse(result.data.reward, result.data.rideStarted));
  } catch (error) {
    next(error);
  }
}
