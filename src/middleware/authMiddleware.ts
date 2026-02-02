import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

export interface AuthenticatedRequest extends Request {
  apiKeyId?: string;
  rawBody?: string;
}

const replayCache = new Map<string, number>();

function pruneReplayCache(now: number): void {
  const maxEntries = config.api.hmacReplayCacheSize;
  const maxAgeMs = config.api.hmacMaxSkewMs;

  for (const [key, timestamp] of replayCache.entries()) {
    if (now - timestamp > maxAgeMs) {
      replayCache.delete(key);
    }
  }

  if (replayCache.size <= maxEntries) {
    return;
  }

  // Remove oldest entries if cache grows too large
  const entries = Array.from(replayCache.entries())
    .sort((a, b) => a[1] - b[1]);

  const overflow = replayCache.size - maxEntries;
  for (let i = 0; i < overflow; i++) {
    replayCache.delete(entries[i][0]);
  }
}

/**
 * Validates API key or HMAC signature on incoming requests.
 * Rejects unauthorized calls with 401 status.
 *
 * Supports two authentication methods:
 * 1. API Key: X-API-Key header
 * 2. HMAC Signature: X-Signature header with timestamp
 */
export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // Check for API key authentication
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) {
    if (validateApiKey(apiKey)) {
      req.apiKeyId = apiKey.substring(0, 8); // First 8 chars as identifier
      return next();
    }
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
    return;
  }

  // Check for HMAC signature authentication
  const signature = req.headers['x-signature'] as string | undefined;
  const timestamp = req.headers['x-timestamp'] as string | undefined;

  if (signature && timestamp) {
    if (validateHmacSignature(req, signature, timestamp)) {
      req.apiKeyId = 'hmac';
      return next();
    }
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid signature',
    });
    return;
  }

  // No authentication provided
  res.status(401).json({
    error: 'Unauthorized',
    message: 'Authentication required. Provide X-API-Key or X-Signature header.',
  });
}

/**
 * Validates an API key against the configured secret.
 * In production, this would check against a database of valid keys.
 */
function validateApiKey(apiKey: string): boolean {
  // Simple validation: key must match the configured secret
  // In production, you'd look up keys in a database
  try {
    const expectedKey = Buffer.from(config.api.keySecret);
    const providedKey = Buffer.from(apiKey);

    if (expectedKey.length !== providedKey.length) {
      return false;
    }

    return timingSafeEqual(expectedKey, providedKey);
  } catch {
    return false;
  }
}

/**
 * Validates HMAC signature for request authenticity.
 * Signature = HMAC-SHA256(timestamp + method + path + body, secret)
 */
function validateHmacSignature(
  req: Request,
  signature: string,
  timestamp: string
): boolean {
  // Check timestamp is within 5 minutes
  const requestTime = parseInt(timestamp, 10);
  const now = Date.now();

  if (isNaN(requestTime) || Math.abs(now - requestTime) > config.api.hmacMaxSkewMs) {
    return false;
  }

  // Build the message to sign
  const method = req.method.toUpperCase();
  const path = req.originalUrl || req.url;
  const body = (req as AuthenticatedRequest).rawBody ?? '';
  const message = `${timestamp}\n${method}\n${path}\n${body}`;

  // Calculate expected signature
  const expectedSignature = createHmac('sha256', config.api.hmacSecret)
    .update(message)
    .digest('hex');

  try {
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const providedBuf = Buffer.from(signature, 'hex');

    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }

    if (!timingSafeEqual(expectedBuf, providedBuf)) {
      return false;
    }

    pruneReplayCache(now);
    if (replayCache.has(signature)) {
      return false;
    }

    replayCache.set(signature, requestTime);
    return true;
  } catch {
    return false;
  }
}

/**
 * Optional admin-only middleware for sensitive endpoints.
 */
export function adminOnlyMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // In production, check for admin-level API key or role
  // For now, all authenticated requests are allowed
  if (!req.apiKeyId) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
    return;
  }
  next();
}
