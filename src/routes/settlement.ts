import { Router } from 'express';
import { settleBet, getSettlement } from '../controllers/settlementController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

// All settlement routes require authentication
router.use(authMiddleware);

/**
 * POST /settlement
 * Settle a bet outcome and calculate bonus
 */
router.post('/', settleBet);

/**
 * GET /settlement/:betId
 * Get settlement record by bet ID
 */
router.get('/:betId', getSettlement);

export default router;
