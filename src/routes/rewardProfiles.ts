import { Router } from 'express';
import {
  createProfile,
  getProfile,
  getAllProfiles,
  updateProfile,
  deleteProfile,
} from '../controllers/rewardProfileController';
import { authMiddleware, adminOnlyMiddleware } from '../middleware/authMiddleware';

const router = Router();

// All profile routes require authentication and admin access
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

/**
 * POST /profiles
 * Create a new reward profile version
 */
router.post('/', createProfile);

/**
 * GET /profiles
 * Get all reward profiles (use ?active=true for active only)
 */
router.get('/', getAllProfiles);

/**
 * GET /profiles/:id
 * Get a specific reward profile by ID
 */
router.get('/:id', getProfile);

/**
 * PUT /profiles/:id
 * Update a reward profile
 */
router.put('/:id', updateProfile);

/**
 * DELETE /profiles/:id
 * Delete a reward profile
 */
router.delete('/:id', deleteProfile);

export default router;
