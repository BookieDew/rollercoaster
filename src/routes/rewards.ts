import { Router } from 'express';
import {
  grantReward,
  precheckEligibility,
  getReward,
  getRewardsByUser,
  optInToReward,
  getActiveReward,
} from '../controllers/rewardController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

// All reward routes require authentication
router.use(authMiddleware);

/**
 * POST /rewards
 * Grant a reward entitlement to a user
 */
router.post('/', grantReward);

/**
 * POST /rewards/:id/eligibility
 * Precheck eligibility before starting ride
 */
router.post('/:id/eligibility', precheckEligibility);

/**
 * GET /rewards/user/:userId
 * Get all rewards for a user
 */
router.get('/user/:userId', getRewardsByUser);

/**
 * GET /rewards/user/:userId/active
 * Get the active reward for a user
 */
router.get('/user/:userId/active', getActiveReward);

/**
 * GET /rewards/:id
 * Get a specific reward by ID
 */
router.get('/:id', getReward);

/**
 * POST /rewards/:id/opt-in
 * User opts into a reward (starts the ride)
 */
router.post('/:id/opt-in', optInToReward);

export default router;
