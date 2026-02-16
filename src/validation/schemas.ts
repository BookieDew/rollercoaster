import { z } from 'zod';

const selectionTypeSchema = z.enum(['STANDARD', 'SGP_COMPOSITE', 'SGP_LEG']);

// Selection schema
export const selectionSchema = z.object({
  id: z.string().min(1),
  odds: z.number().positive(),
  name: z.string().optional(),
  market: z.string().optional(),
  event: z.string().optional(),
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
  selections: z.array(selectionSchema).min(1),
  stake: z.number().positive().optional(),
});

// Reward Profile schemas
export const createRewardProfileSchema = z.object({
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
  is_active: z.boolean().optional(),
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
  user_id: z.string().min(1),
  profile_version_id: z.string().uuid(),
  duration_seconds: z.number().int().positive().optional(),
});

// Eligibility precheck schema (bet not started yet)
export const eligibilityRequestSchema = z.object({
  user_id: z.string().min(1),
  ticket: ticketSchema,
});

// Quote schema
export const quoteRequestSchema = z.object({
  user_id: z.string().min(1),
  reward_id: z.string().uuid(),
  bet_id: z.string().min(1),
});

// Lock schema
export const lockRequestSchema = z.object({
  user_id: z.string().min(1),
  reward_id: z.string().uuid(),
  bet_id: z.string().min(1),
});

// Start ride schema (bet already placed)
export const startRideSchema = z.object({
  user_id: z.string().min(1),
  bet_id: z.string().min(1),
  ticket: ticketSchema,
});

// Settlement schema
export const settlementRequestSchema = z.object({
  bet_id: z.string().min(1),
  outcome: z.enum(['WIN', 'LOSS', 'VOID', 'CASHOUT']),
  winnings: z.number().min(0),
});

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
export type SimulationRequestBody = z.infer<typeof simulationRequestSchema>;
export type StartRideBody = z.infer<typeof startRideSchema>;
