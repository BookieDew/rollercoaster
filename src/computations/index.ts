export {
  filterQualifyingSelections,
  meetsMinSelectionCount,
  type FilterResult,
} from './qualifyingSelectionFilter';

export {
  calculateCombinedOdds,
  meetsCombinedOddsThreshold,
  roundOdds,
} from './combinedOddsCalculator';

export {
  computeTicketStrength,
  computeLinearStrength,
  type TicketStrengthConfig,
} from './ticketStrengthScorer';

export {
  generateSeed,
  deriveRideParams,
  deriveCrashPct,
  deriveRideDurationSeconds,
  generateRide,
  interpolateRideValue,
  calculateElapsedPct,
  hasRideEnded,
  type RideCheckpoint,
  type RideConfig,
  type GeneratedRide,
} from './deterministicRideGenerator';

export {
  calculateFinalBoost,
  calculateFinalBoostDetails,
  computeBoostModelDetails,
  computeMaxEligibleBoostPct,
  getBoostModelConstants,
  calculateBonusAmount,
  clampValue,
  formatBoostPercentage,
  type BoostModelDetails,
  type FinalBoostConfig,
  type FinalBoostInput,
} from './finalBoostCalculator';

export {
  buildEffectiveRidePath,
} from './ridePathBuilder';
