import { Router } from 'express';
import rewardProfilesRouter from './rewardProfiles';
import rewardsRouter from './rewards';
import boostRouter from './boost';
import settlementRouter from './settlement';
import simulationRouter from './simulation';
import adminRouter from './admin';
import { createApiError } from '../middleware/errorHandler';
import { ReasonCode } from '../types/reasonCodes';

const router = Router();

// Mount all route modules under their respective base paths
router.use('/profiles', rewardProfilesRouter);
router.use('/rewards', rewardsRouter);
router.use('/boost', boostRouter);
router.use('/settlement', settlementRouter);
router.use('/simulation', simulationRouter);
router.use('/admin', adminRouter);

// Anything else under /api is a JSON 404 (must stay last).
router.use((_req, _res, next) => {
  next(createApiError('Route not found', ReasonCode.ROUTE_NOT_FOUND));
});

export default router;
