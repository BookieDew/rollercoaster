/** V3 baseline for the ride lab only (frozen copy; see types.ts). */
export {
  deriveRideParams,
  deriveRideDurationSeconds,
  interpolateRideValue,
} from './deterministicRideGenerator';
export { calculateLinearBoostPctAtElapsed } from './linearRideMode';
export { computeLinearModeMaxBoostPct } from './rideReferenceMaximum';
export { generatePhaseCorrectedRide, deriveFeasibleCrashPhase } from './feasibleRidePhase';
