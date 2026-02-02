import { Router } from 'express';
import { getQuote, lockBoost, getLock } from '../controllers/boostController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

// All boost routes require authentication
router.use(authMiddleware);

/**
 * POST /boost/quote
 * Get a boost quote for a prospective ticket
 * Does not consume the reward - just shows current boost value
 */
router.post('/quote', getQuote);

/**
 * POST /boost/lock
 * Lock the current boost for a bet
 * Consumes the reward and freezes the boost percentage
 */
router.post('/lock', lockBoost);

/**
 * GET /boost/lock/:betId
 * Get an existing lock by bet ID
 */
router.get('/lock/:betId', getLock);

export default router;
