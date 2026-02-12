import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler, createApiError } from '../../src/middleware/errorHandler';
import { ReasonCode } from '../../src/types/reasonCodes';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createMockRequest(): Request {
  return {
    method: 'POST',
    path: '/api/test',
  } as Request;
}

describe('errorHandler', () => {
  const next = jest.fn() as NextFunction;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('formats Zod validation errors as 400', () => {
    const schema = z.object({ x: z.number() });
    const parsed = schema.safeParse({ x: 'bad' });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error('Expected schema parse to fail');
    }

    const req = createMockRequest();
    const res = createMockResponse();
    errorHandler(parsed.error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Validation Error',
      code: ReasonCode.VALIDATION_ERROR,
      message: 'Request validation failed',
    }));
  });

  it('formats known API errors with mapped status code', () => {
    const err = createApiError('Missing reward', ReasonCode.REWARD_NOT_FOUND);
    const req = createMockRequest();
    const res = createMockResponse();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Not Found',
      code: ReasonCode.REWARD_NOT_FOUND,
      message: 'Missing reward',
    }));
  });

  it('formats known API errors with explicit status override', () => {
    const err = createApiError('Forbidden', ReasonCode.NOT_OPTED_IN, 403, { reason: 'manual' });
    const req = createMockRequest();
    const res = createMockResponse();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Forbidden',
      code: ReasonCode.NOT_OPTED_IN,
      details: { reason: 'manual' },
    }));
  });

  it('returns internal error details in non-production', () => {
    process.env.NODE_ENV = 'test';
    const err = new Error('unexpected') as Error & { statusCode?: number };
    const req = createMockRequest();
    const res = createMockResponse();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Internal Server Error',
      code: ReasonCode.INTERNAL_ERROR,
      message: 'unexpected',
    }));
  });

  it('hides unknown error details in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('sensitive') as Error & { statusCode?: number };
    const req = createMockRequest();
    const res = createMockResponse();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Internal Server Error',
      code: ReasonCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
    }));
  });

  it('createApiError sets default status from reason code', () => {
    const err = createApiError('bad input', ReasonCode.VALIDATION_ERROR);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ReasonCode.VALIDATION_ERROR);
  });
});
