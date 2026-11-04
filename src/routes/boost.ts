import { Router } from 'express';
import { getQuote, lockBoost, getLock, getBoostedBet } from '../controllers/boostController';
import { getOpenOffer, openOptIn } from '../controllers/openBoostController';
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

/**
 * GET /boost/bets/:betId
 * Whether a bet is boosted (operator-only data for the operator's own cash-out policy)
 */
router.get('/bets/:betId', getBoostedBet);

/**
 * POST /boost/offers
 * Read-only: which OPEN profile would apply to this slip and whether it qualifies now
 */
router.post('/offers', getOpenOffer);

/**
 * POST /boost/open-opt-in
 * The player uses an open boost on a placed bet: grant + opt-in + ride start in one transaction
 */
router.post('/open-opt-in', openOptIn);

export default router;
