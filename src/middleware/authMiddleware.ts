import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

export interface AuthenticatedRequest extends Request {
  /**
   * Label of the credential that authenticated the call: 'service' or 'admin' for
   * API keys, 'hmac' for signatures. Never derived from secret material.
   */
  apiKeyId?: string;
  rawBody?: string;
  authMethod?: 'api_key' | 'hmac';
}

/** HMAC-SHA256 hex digest; either letter case is accepted. */
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;
/** Epoch milliseconds, digits only (15 digits stay a safe integer). */
const TIMESTAMP_PATTERN = /^\d{1,15}$/;

/** Keyed by the canonical lowercase digest so letter-case variants cannot replay. */
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
    const keyLabel = matchApiKey(apiKey);
    if (keyLabel) {
      req.apiKeyId = keyLabel;
      req.authMethod = 'api_key';
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
      req.authMethod = 'hmac';
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

/** Timing-safe comparison of a provided key against a configured secret. */
function secretMatches(provided: Buffer, secret: string): boolean {
  const expected = Buffer.from(secret);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/**
 * Matches an API key against the service and admin secrets and returns the label
 * of the matching credential. Both secrets are always compared.
 */
function matchApiKey(apiKey: string): 'service' | 'admin' | null {
  const provided = Buffer.from(apiKey);
  const isAdmin = secretMatches(provided, config.api.adminKeySecret);
  const isService = secretMatches(provided, config.api.keySecret);
  if (isAdmin) {
    return 'admin';
  }
  return isService ? 'service' : null;
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
  if (!SIGNATURE_PATTERN.test(signature) || !TIMESTAMP_PATTERN.test(timestamp)) {
    return false;
  }

  // Check the timestamp is within the allowed skew
  const requestTime = Number(timestamp);
  const now = Date.now();
  if (Math.abs(now - requestTime) > config.api.hmacMaxSkewMs) {
    return false;
  }

  // Build the message to sign
  const method = req.method.toUpperCase();
  const path = req.originalUrl || req.url;
  const body = (req as AuthenticatedRequest).rawBody ?? '';
  const message = `${timestamp}\n${method}\n${path}\n${body}`;

  // Both buffers are 32 bytes: the pattern check guarantees 64 hex characters.
  const expected = createHmac('sha256', config.api.hmacSecret)
    .update(message)
    .digest();
  const provided = Buffer.from(signature, 'hex');
  if (!timingSafeEqual(expected, provided)) {
    return false;
  }

  const replayKey = expected.toString('hex');
  pruneReplayCache(now);
  if (replayCache.has(replayKey)) {
    return false;
  }

  replayCache.set(replayKey, requestTime);
  return true;
}

/**
 * Optional admin-only middleware for sensitive endpoints.
 */
export function adminOnlyMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!apiKey) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin API key required',
    });
    return;
  }

  if (!secretMatches(Buffer.from(apiKey), config.api.adminKeySecret)) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
    return;
  }

  next();
}
