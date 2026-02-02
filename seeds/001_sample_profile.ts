import type { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';

export async function seed(knex: Knex): Promise<void> {
  // Clear existing entries
  await knex('settlement_records').del();
  await knex('bet_boost_locks').del();
  await knex('ride_definitions').del();
  await knex('user_rewards').del();
  await knex('reward_profile_versions').del();

  const now = new Date().toISOString();

  // Insert sample reward profiles
  await knex('reward_profile_versions').insert([
    {
      id: uuidv4(),
      name: 'Standard Combo Boost',
      description: 'Default boost profile for everyday combo bets. Moderate volatility and boost range.',
      min_selections: 3,
      min_combined_odds: 3.0,
      min_selection_odds: 1.2,
      min_boost_pct: 0.05,
      max_boost_pct: 0.5,
      ride_duration_seconds: 3600, // 1 hour
      checkpoint_count: 10,
      volatility: 0.5,
      is_active: true,
      created_at: now,
      updated_at: now,
    },
    {
      id: uuidv4(),
      name: 'Premium High Roller',
      description: 'Higher boost potential for VIP users with larger parlays. Requires more selections.',
      min_selections: 5,
      min_combined_odds: 10.0,
      min_selection_odds: 1.3,
      min_boost_pct: 0.1,
      max_boost_pct: 1.0,
      ride_duration_seconds: 7200, // 2 hours
      checkpoint_count: 20,
      volatility: 0.7,
      is_active: true,
      created_at: now,
      updated_at: now,
    },
    {
      id: uuidv4(),
      name: 'Quick Burst',
      description: 'Short duration, high volatility ride for flash promotions.',
      min_selections: 2,
      min_combined_odds: 2.0,
      min_selection_odds: 1.1,
      min_boost_pct: 0.02,
      max_boost_pct: 0.3,
      ride_duration_seconds: 900, // 15 minutes
      checkpoint_count: 5,
      volatility: 0.9,
      is_active: true,
      created_at: now,
      updated_at: now,
    },
    {
      id: uuidv4(),
      name: 'Steady Eddie',
      description: 'Low volatility profile with consistent boost values. Good for conservative users.',
      min_selections: 3,
      min_combined_odds: 4.0,
      min_selection_odds: 1.25,
      min_boost_pct: 0.15,
      max_boost_pct: 0.25,
      ride_duration_seconds: 5400, // 1.5 hours
      checkpoint_count: 15,
      volatility: 0.2,
      is_active: true,
      created_at: now,
      updated_at: now,
    },
    {
      id: uuidv4(),
      name: 'Archived Legacy',
      description: 'Previous version profile - no longer in use.',
      min_selections: 4,
      min_combined_odds: 5.0,
      min_selection_odds: 1.3,
      min_boost_pct: 0.05,
      max_boost_pct: 0.4,
      ride_duration_seconds: 3600,
      checkpoint_count: 8,
      volatility: 0.4,
      is_active: false, // Inactive
      created_at: now,
      updated_at: now,
    },
  ]);

  console.log('Seed completed: Inserted 5 sample reward profiles');
}
