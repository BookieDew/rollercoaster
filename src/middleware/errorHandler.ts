import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ReasonCode, isReasonCode } from '../types/reasonCodes';

export interface ApiError extends Error {
  statusCode?: number;
  code?: ReasonCode;
  details?: unknown;
}

const GENERIC_INTERNAL_MESSAGE = 'An unexpected error occurred';

/** Errors raised by express.json (body-parser) carry a `type` and an HTTP status. */
interface BodyParserError extends Error {
  type: string;
  status: number;
}

const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'Malformed JSON request body',
  'entity.too.large': 'Request body too large',
};

/**
 * Global error handler.
 *
 * Only ReasonCode values are ever returned as `code`. Anything else, including
 * database driver errors that carry their own `.code` (SQLITE_*, 23505, ...),
 * becomes 500 INTERNAL_ERROR. Messages of unexpected errors are only exposed in
 * development/test, and never for driver errors (their text embeds SQL and
 * bound values). The full error and stack are always logged server-side.
 */
export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[ERROR] ${req.method} ${req.path}:`, {
    message: err?.message,
    code: (err as { code?: unknown })?.code,
    stack: err?.stack,
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

  // Malformed / oversized / unsupported request bodies
  if (isClientBodyParserError(err)) {
    res.status(err.status).json({
      error: getErrorTypeForStatusCode(err.status),
      code: ReasonCode.VALIDATION_ERROR,
      message: BODY_PARSER_MESSAGES[err.type] ?? 'Invalid request body',
    });
    return;
  }

  // Handle known API errors (whitelisted reason codes only)
  if (isReasonCode(err?.code)) {
    const statusCode = err.statusCode ?? getStatusCodeForReasonCode(err.code);
    res.status(statusCode).json({
      error: getErrorTypeForStatusCode(statusCode),
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }

  // Everything else is an internal error
  res.status(500).json({
    error: getErrorTypeForStatusCode(500),
    code: ReasonCode.INTERNAL_ERROR,
    message: exposesInternalMessages() && !looksLikeDriverError(err) && err?.message
      ? err.message
      : GENERIC_INTERNAL_MESSAGE,
  });
}

function exposesInternalMessages(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

function isClientBodyParserError(err: unknown): err is BodyParserError {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { type?: unknown; status?: unknown };
  return typeof candidate.type === 'string'
    && typeof candidate.status === 'number'
    && candidate.status >= 400
    && candidate.status < 500;
}

/** Driver/system errors: any non-ReasonCode `.code`, or SQL/bindings/errno metadata. */
function looksLikeDriverError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as Record<string, unknown>;
  return candidate.code !== undefined
    || 'sql' in candidate
    || 'bindings' in candidate
    || 'errno' in candidate
    || 'detail' in candidate;
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
    case ReasonCode.SETTLEMENT_NOT_FOUND:
    case ReasonCode.ROUTE_NOT_FOUND:
      return 404;

    case ReasonCode.ALREADY_OPTED_IN:
    case ReasonCode.BET_ALREADY_BOUND:
    case ReasonCode.BET_ALREADY_LOCKED:
    case ReasonCode.BET_ALREADY_SETTLED:
    case ReasonCode.REPLACEMENT_ALREADY_USED:
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
    case ReasonCode.CURRENCY_NOT_SUPPORTED:
    case ReasonCode.SETTLEMENT_UNAVAILABLE:
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
    case 413:
      return 'Payload Too Large';
    case 415:
      return 'Unsupported Media Type';
    case 422:
      return 'Unprocessable Entity';
    case 500:
    default:
      return 'Internal Server Error';
  }
}
