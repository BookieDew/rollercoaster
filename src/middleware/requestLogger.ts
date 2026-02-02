import { Request, Response, NextFunction } from 'express';

/**
 * Logs incoming requests with method, path, duration, and status code.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();
  const { method, path, ip } = req;

  // Log request start
  const requestId = generateRequestId();
  req.headers['x-request-id'] = requestId;

  // Capture response finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;

    const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    const logFn = logLevel === 'error' ? console.error : logLevel === 'warn' ? console.warn : console.log;

    logFn(
      `[${new Date().toISOString()}] ${method} ${path} ${statusCode} ${duration}ms`,
      {
        requestId,
        ip: ip || req.headers['x-forwarded-for'],
        userAgent: req.headers['user-agent']?.substring(0, 100),
      }
    );
  });

  next();
}

/**
 * Generates a simple request ID for tracing.
 */
function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}
