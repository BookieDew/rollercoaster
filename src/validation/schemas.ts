import { z } from 'zod';

// Selection schema
export const selectionSchema = z.object({
  id: z.string().min(1),
  odds: z.number().positive(),
  name: z.string().optional(),
  market: z.string().optional(),
  event: z.string().optional(),
  eligible: z.boolean().optional(),
  ineligible_reason: z.string().max(200).optional(),
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
  ride_duration_seconds: z.number().int().min(60).max(86400),
}).refine(data => data.min_boost_pct <= data.max_boost_pct, {
  message: 'min_boost_pct must be less than or equal to max_boost_pct',
  path: ['min_boost_pct'],
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
  ride_duration_seconds: z.number().int().min(60).max(86400).optional(),
  is_active: z.boolean().optional(),
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
