import { Router } from 'express';
import { simulateRide } from '../controllers/simulationController';
import { authMiddleware, adminOnlyMiddleware } from '../middleware/authMiddleware';

const router = Router();

// Simulation routes require authentication and admin access
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

/**
 * POST /simulation
 * Simulate ride curves for internal tuning
 * Returns checkpoints and interpolated curve for visualization
 */
router.post('/', simulateRide);

export default router;
