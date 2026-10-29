import { Router } from 'express';
import { settleBet, resettleBet, getSettlement } from '../controllers/settlementController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

// All settlement routes require authentication
router.use(authMiddleware);

/**
 * POST /settlement
 * Settle a locked bet from its leg results and compute the bonus
 */
router.post('/', settleBet);

/**
 * POST /settlement/resettle
 * Correct a settlement: creates the next revision and adjusts replacement tokens
 */
router.post('/resettle', resettleBet);

/**
 * GET /settlement/:betId?brand_id=
 * Current settlement revision of a bet
 */
router.get('/:betId', getSettlement);

export default router;
