import { z } from 'zod';
import { CURRENCY_PATTERN, MAX_BONUS_CAP_MINOR, MAX_STAKE_MINOR } from '../money/minorUnits';

const selectionTypeSchema = z.enum(['STANDARD', 'SGP_COMPOSITE', 'SGP_LEG']);

/** Upper bounds for caller-supplied identifiers and ticket data. */
export const MAX_IDENTIFIER_LENGTH = 255;
export const MAX_SELECTION_ODDS = 10_000;
export const MAX_SELECTIONS = 100;
/** Settlement correction reason length. */
export const MAX_RESETTLE_REASON_LENGTH = 500;

/** Reward validity bounds: 1 minute to 365 days. */
export const MIN_REWARD_VALIDITY_SECONDS = 60;
export const MAX_REWARD_VALIDITY_SECONDS = 31_536_000;
export const MAX_BONUS_CAP_CURRENCIES = 50;

const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);

/** Brand identifier: 1-64 characters of letters, digits, underscore or hyphen. */
export const brandIdSchema = z.string().min(1).max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'brand_id may only contain letters, digits, underscore and hyphen');

/** ISO-4217 style currency code: three uppercase letters. */
export const currencySchema = z.string().regex(CURRENCY_PATTERN, 'currency must be a 3-letter uppercase ISO-4217 code');

/** Per-currency bonus cap in minor units: at least one positive integer entry. */
export const maxBonusMinorSchema = z.record(
  currencySchema,
  z.number().int().positive().max(MAX_BONUS_CAP_MINOR)
).refine((map) => Object.keys(map).length >= 1, {
  message: 'max_bonus_minor needs at least one currency',
}).refine((map) => Object.keys(map).length <= MAX_BONUS_CAP_CURRENCIES, {
  message: `max_bonus_minor allows at most ${MAX_BONUS_CAP_CURRENCIES} currencies`,
});

const rewardValiditySecondsSchema = z.number().int()
  .min(MIN_REWARD_VALIDITY_SECONDS)
  .max(MAX_REWARD_VALIDITY_SECONDS);

/** Query string of the brand-scoped GET endpoints. */
export const brandQuerySchema = z.object({
  brand_id: brandIdSchema,
});

/** Optional brand filter for the admin profile list. */
export const optionalBrandQuerySchema = z.object({
  brand_id: brandIdSchema.optional(),
});
const selectionTextSchema = z.string().max(MAX_IDENTIFIER_LENGTH);

// Path parameter schemas
export const idParamsSchema = z.object({
  id: z.string().uuid(),
});

export const userIdParamsSchema = z.object({
  userId: identifierSchema,
});

export const betIdParamsSchema = z.object({
  betId: identifierSchema,
});

/** Decimal places settlement can represent exactly (the settlement calculator scales odds by 10^6). */
const MAX_ODDS_DECIMALS = 6;
const SHORTEST_DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * True when the number has at most 6 decimal places, judged exactly as the
 * settlement calculator judges it: from the shortest round-trip string
 * (`String(value)`), so 2.123456 passes and 2.1234567 does not.
 */
function hasAtMostSettlementDecimals(value: number): boolean {
  const match = SHORTEST_DECIMAL_PATTERN.exec(String(value));
  if (!match) return false;
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  return (match[2] ?? '').length - exponent <= MAX_ODDS_DECIMALS;
}

// Selection schema
export const selectionSchema = z.object({
  id: identifierSchema,
  odds: z.number().positive().max(MAX_SELECTION_ODDS).refine(hasAtMostSettlementDecimals, {
    message: `odds must have at most ${MAX_ODDS_DECIMALS} decimal places`,
  }),
  name: selectionTextSchema.optional(),
  market: selectionTextSchema.optional(),
  event: selectionTextSchema.optional(),
  selection_type: selectionTypeSchema.optional(),
  sgp_group_id: z.string().min(1).max(100).optional(),
  eligible: z.boolean().optional(),
  ineligible_reason: z.string().max(200).optional(),
}).superRefine((data, ctx) => {
  if (data.selection_type === 'STANDARD' && data.sgp_group_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sgp_group_id is only allowed for SGP_COMPOSITE or SGP_LEG selections',
      path: ['sgp_group_id'],
    });
  }

  if ((data.selection_type === 'SGP_COMPOSITE' || data.selection_type === 'SGP_LEG')
    && !data.sgp_group_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sgp_group_id is required when selection_type is SGP_COMPOSITE or SGP_LEG',
      path: ['sgp_group_id'],
    });
  }
});

// Ticket schema
export const ticketSchema = z.object({
  selections: z.array(selectionSchema).min(1).max(MAX_SELECTIONS),
  /** Deprecated and ignored: the stake is the integer stake_minor sent at opt-in. */
  stake: z.number().positive().optional(),
});

// Reward Profile schemas
export const createRewardProfileSchema = z.object({
  brand_id: brandIdSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  min_selections: z.number().int().min(1).max(20),
  min_combined_odds: z.number().positive(),
  min_selection_odds: z.number().positive(),
  min_boost_pct: z.number().min(0).max(1),
  max_boost_pct: z.number().min(0).max(10),
  max_boost_min_selections: z.number().int().min(1).max(50).optional(),
  max_boost_min_combined_odds: z.number().positive().optional(),
  max_eligibility_selection_weight: z.number().min(0).max(1).default(0.75),
  max_eligibility_odds_weight: z.number().min(0).max(1).default(0.25),
  effective_min_floor_rate: z.number().min(0).max(1).default(0.35),
  ride_mode: z.enum(['WAVES', 'LINEAR']).default('WAVES'),
  ride_duration_seconds: z.number().int().min(1).max(86400),
  max_bonus_minor: maxBonusMinorSchema,
  reward_validity_seconds: rewardValiditySecondsSchema,
}).refine(data => data.min_boost_pct <= data.max_boost_pct, {
  message: 'min_boost_pct must be less than or equal to max_boost_pct',
  path: ['min_boost_pct'],
}).refine(data => Math.abs(
  (data.max_eligibility_selection_weight + data.max_eligibility_odds_weight) - 1
) < 0.0001, {
  message: 'max_eligibility_selection_weight + max_eligibility_odds_weight must equal 1',
  path: ['max_eligibility_selection_weight'],
}).refine(data => {
  if (data.max_boost_min_selections === undefined) return true;
  return data.max_boost_min_selections >= data.min_selections;
}, {
  message: 'max_boost_min_selections must be greater than or equal to min_selections',
  path: ['max_boost_min_selections'],
}).refine(data => {
  if (data.max_boost_min_combined_odds === undefined) return true;
  return data.max_boost_min_combined_odds >= data.min_combined_odds;
}, {
  message: 'max_boost_min_combined_odds must be greater than or equal to min_combined_odds',
  path: ['max_boost_min_combined_odds'],
});

export const updateRewardProfileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  min_selections: z.number().int().min(1).max(20).optional(),
  min_combined_odds: z.number().positive().optional(),
  min_selection_odds: z.number().positive().optional(),
  min_boost_pct: z.number().min(0).max(1).optional(),
  max_boost_pct: z.number().min(0).max(10).optional(),
  max_boost_min_selections: z.number().int().min(1).max(50).optional(),
  max_boost_min_combined_odds: z.number().positive().optional(),
  max_eligibility_selection_weight: z.number().min(0).max(1).optional(),
  max_eligibility_odds_weight: z.number().min(0).max(1).optional(),
  effective_min_floor_rate: z.number().min(0).max(1).optional(),
  ride_mode: z.enum(['WAVES', 'LINEAR']).optional(),
  ride_duration_seconds: z.number().int().min(1).max(86400).optional(),
  max_bonus_minor: maxBonusMinorSchema.optional(),
  reward_validity_seconds: rewardValiditySecondsSchema.optional(),
  is_active: z.boolean().optional(),
  /** Present only to reject it: a profile never changes brand. */
  brand_id: z.unknown().optional(),
}).refine(data => data.brand_id === undefined, {
  message: 'brand_id is immutable and cannot be updated',
  path: ['brand_id'],
}).refine(data => {
  if (
    data.max_eligibility_selection_weight === undefined
    || data.max_eligibility_odds_weight === undefined
  ) {
    return true;
  }
  return Math.abs(
    (data.max_eligibility_selection_weight + data.max_eligibility_odds_weight) - 1
  ) < 0.0001;
}, {
  message: 'max_eligibility_selection_weight + max_eligibility_odds_weight must equal 1',
  path: ['max_eligibility_selection_weight'],
});

// User Reward schemas
export const grantRewardSchema = z.object({
  user_id: identifierSchema,
  profile_version_id: z.string().uuid(),
  duration_seconds: z.number().int().positive().optional(),
});

// Eligibility precheck schema (bet not started yet)
export const eligibilityRequestSchema = z.object({
  user_id: identifierSchema,
  ticket: ticketSchema,
});

// Quote schema
export const quoteRequestSchema = z.object({
  user_id: identifierSchema,
  reward_id: z.string().uuid(),
  bet_id: identifierSchema,
});

// Lock schema
export const lockRequestSchema = z.object({
  user_id: identifierSchema,
  reward_id: z.string().uuid(),
  bet_id: identifierSchema,
});

// Start ride schema (bet already placed)
export const startRideSchema = z.object({
  user_id: identifierSchema,
  bet_id: identifierSchema,
  /** Integer minor units, e.g. 1000 = 10.00 EUR. */
  stake_minor: z.number().int().positive().max(MAX_STAKE_MINOR),
  currency: currencySchema,
  ticket: ticketSchema,
}).superRefine((data, ctx) => {
  // Settlement reports a result per selection_id, so ids must identify one selection.
  const seen = new Set<string>();
  data.ticket.selections.forEach((selection, index) => {
    if (seen.has(selection.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `selection id ${selection.id} is used more than once; selection ids must be unique`,
        path: ['ticket', 'selections', index, 'id'],
      });
    }
    seen.add(selection.id);
  });
});

// Settlement schemas
const settlementLegSchema = z.object({
  selection_id: identifierSchema,
  result: z.enum(['WON', 'LOST', 'PUSH', 'CANCELLED']),
});

const settlementBodyShape = {
  brand_id: brandIdSchema,
  bet_id: identifierSchema,
  outcome: z.enum(['SETTLED', 'CASHOUT', 'CANCELLED']),
  /** Required (one per bet leg) for SETTLED, forbidden otherwise. */
  legs: z.array(settlementLegSchema).min(1).max(MAX_SELECTIONS).optional(),
};

function refineSettlementLegs(
  data: { outcome: 'SETTLED' | 'CASHOUT' | 'CANCELLED'; legs?: unknown[] },
  ctx: z.RefinementCtx
): void {
  if (data.outcome === 'SETTLED' && data.legs === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'legs are required when outcome is SETTLED',
      path: ['legs'],
    });
  }
  if (data.outcome !== 'SETTLED' && data.legs !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `legs are not allowed when outcome is ${data.outcome}`,
      path: ['legs'],
    });
  }
}

export const settlementRequestSchema = z.object(settlementBodyShape).superRefine(refineSettlementLegs);

export const resettlementRequestSchema = z.object({
  ...settlementBodyShape,
  reason: z.string().trim().min(1).max(MAX_RESETTLE_REASON_LENGTH),
}).superRefine(refineSettlementLegs);

// Simulation schema
export const simulationRequestSchema = z.object({
  profile_id: z.string().uuid().optional(),
  seed: z.string().optional(),
  min_boost_pct: z.number().min(0).max(1).optional(),
  max_boost_pct: z.number().min(0).max(10).optional(),
  sample_points: z.number().int().min(10).max(1000).optional(),
  ticket: ticketSchema.optional(),
});

// Type exports for validated data
export type CreateRewardProfileBody = z.infer<typeof createRewardProfileSchema>;
export type UpdateRewardProfileBody = z.infer<typeof updateRewardProfileSchema>;
export type GrantRewardBody = z.infer<typeof grantRewardSchema>;
export type EligibilityRequestBody = z.infer<typeof eligibilityRequestSchema>;
export type QuoteRequestBody = z.infer<typeof quoteRequestSchema>;
export type LockRequestBody = z.infer<typeof lockRequestSchema>;
export type SettlementRequestBody = z.infer<typeof settlementRequestSchema>;
export type ResettlementRequestBody = z.infer<typeof resettlementRequestSchema>;
export type SimulationRequestBody = z.infer<typeof simulationRequestSchema>;
export type BrandQuery = z.infer<typeof brandQuerySchema>;
export type StartRideBody = z.infer<typeof startRideSchema>;
