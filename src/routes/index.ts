import { Router } from 'express';
import rewardProfilesRouter from './rewardProfiles';
import rewardsRouter from './rewards';
import boostRouter from './boost';
import settlementRouter from './settlement';
import simulationRouter from './simulation';

const router = Router();

// Mount all route modules under their respective base paths
router.use('/profiles', rewardProfilesRouter);
router.use('/rewards', rewardsRouter);
router.use('/boost', boostRouter);
router.use('/settlement', settlementRouter);
router.use('/simulation', simulationRouter);

export default router;
