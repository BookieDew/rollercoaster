import { Router } from 'express';
import { expireRewards } from '../controllers/adminController';
import { authMiddleware, adminOnlyMiddleware } from '../middleware/authMiddleware';

const router = Router();

// Admin routes require authentication and the admin key
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

/**
 * POST /admin/rewards/expire
 * Expire GRANTED rewards past valid_until and unlocked ENTERED rewards whose
 * ride is over. Idempotent; returns the number of rewards changed.
 */
router.post('/rewards/expire', expireRewards);

export default router;
