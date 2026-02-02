import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ReasonCode } from '../types/reasonCodes';

export interface ApiError extends Error {
  statusCode?: number;
  code?: ReasonCode;
  details?: unknown;
}

/**
 * Global error handler that formats errors consistently and logs them.
 */
export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log the error
  console.error(`[ERROR] ${req.method} ${req.path}:`, {
    message: err.message,
    code: err.code,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation Error',
      code: ReasonCode.VALIDATION_ERROR,
      message: 'Request validation failed',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // Handle known API errors
  if (err.code) {
    const statusCode = err.statusCode ?? getStatusCodeForReasonCode(err.code);
    res.status(statusCode).json({
      error: getErrorTypeForStatusCode(statusCode),
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }

  // Handle unknown errors
  const statusCode = err.statusCode ?? 500;
  res.status(statusCode).json({
    error: getErrorTypeForStatusCode(statusCode),
    code: ReasonCode.INTERNAL_ERROR,
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message,
  });
}

/**
 * Creates an API error with proper typing.
 */
export function createApiError(
  message: string,
  code: ReasonCode,
  statusCode?: number,
  details?: unknown
): ApiError {
  const error: ApiError = new Error(message);
  error.code = code;
  error.statusCode = statusCode ?? getStatusCodeForReasonCode(code);
  error.details = details;
  return error;
}

function getStatusCodeForReasonCode(code: ReasonCode): number {
  switch (code) {
    case ReasonCode.VALIDATION_ERROR:
      return 400;

    case ReasonCode.REWARD_NOT_FOUND:
    case ReasonCode.PROFILE_NOT_FOUND:
    case ReasonCode.LOCK_NOT_FOUND:
      return 404;

    case ReasonCode.ALREADY_OPTED_IN:
    case ReasonCode.BET_ALREADY_LOCKED:
    case ReasonCode.BET_ALREADY_SETTLED:
      return 409;

    case ReasonCode.MIN_SELECTIONS_NOT_MET:
    case ReasonCode.MIN_ODDS_NOT_MET:
    case ReasonCode.MIN_COMBINED_ODDS_NOT_MET:
    case ReasonCode.REWARD_EXPIRED:
    case ReasonCode.REWARD_ALREADY_USED:
    case ReasonCode.NOT_OPTED_IN:
    case ReasonCode.RIDE_ENDED:
    case ReasonCode.RIDE_CRASHED:
    case ReasonCode.PROFILE_INACTIVE:
    case ReasonCode.INVALID_CONFIGURATION:
    case ReasonCode.INVALID_OUTCOME:
      return 422;

    case ReasonCode.INTERNAL_ERROR:
    default:
      return 500;
  }
}

function getErrorTypeForStatusCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 422:
      return 'Unprocessable Entity';
    case 500:
    default:
      return 'Internal Server Error';
  }
}
