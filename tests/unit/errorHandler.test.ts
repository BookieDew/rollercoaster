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

  it('never returns a driver error code and hides driver messages in every mode', () => {
    for (const env of ['production', 'development', 'test']) {
      process.env.NODE_ENV = env;
      for (const driverError of [
        Object.assign(new Error("insert into `settlement_records` (`bet_id`) values ('bet-secret') - SQLITE_CONSTRAINT: UNIQUE constraint failed"), {
          code: 'SQLITE_CONSTRAINT',
          errno: 19,
        }),
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          detail: 'Key (bet_id)=(bet-secret) already exists.',
        }),
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('select * from x where id = ?'), { sql: 'select * from x where id = ?', bindings: ['bet-secret'] }),
      ]) {
        const res = createMockResponse();
        errorHandler(driverError as never, createMockRequest(), res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Internal Server Error',
          code: ReasonCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred',
        });
      }
    }
  });

  it('treats a non-ReasonCode code with a status as an internal error', () => {
    const err = Object.assign(new Error('weird'), { code: 'NOT_A_REASON', statusCode: 418 });
    const res = createMockResponse();
    errorHandler(err as never, createMockRequest(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: ReasonCode.INTERNAL_ERROR }));
  });

  it('hides unexpected messages when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    const res = createMockResponse();
    errorHandler(new Error('internal detail'), createMockRequest(), res, next);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'An unexpected error occurred' }));
    process.env.NODE_ENV = 'test';
  });

  it('always logs the stack server-side', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('logged');
    errorHandler(err, createMockRequest(), createMockResponse(), next);
    expect(console.error).toHaveBeenCalledWith(
      '[ERROR] POST /api/test:',
      expect.objectContaining({ message: 'logged', stack: err.stack })
    );
  });

  it.each([
    [{ type: 'entity.parse.failed', status: 400, body: '{"secret":' }, 400, 'Bad Request', 'Malformed JSON request body'],
    [{ type: 'entity.too.large', status: 413 }, 413, 'Payload Too Large', 'Request body too large'],
    [{ type: 'charset.unsupported', status: 415 }, 415, 'Unsupported Media Type', 'Invalid request body'],
  ])('maps body-parser error %j to VALIDATION_ERROR', (props, status, title, message) => {
    const err = Object.assign(new Error('raw parser message'), props);
    const res = createMockResponse();
    errorHandler(err as never, createMockRequest(), res, next);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error: title, code: ReasonCode.VALIDATION_ERROR, message });
  });

  it('does not treat server-side body stream errors as client errors', () => {
    const err = Object.assign(new Error('stream encoding should not be set'), { type: 'stream.encoding.set', status: 500 });
    const res = createMockResponse();
    errorHandler(err as never, createMockRequest(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it.each([
    [ReasonCode.BET_ALREADY_BOUND, 409, 'Conflict'],
    [ReasonCode.SETTLEMENT_NOT_FOUND, 404, 'Not Found'],
    [ReasonCode.ROUTE_NOT_FOUND, 404, 'Not Found'],
  ])('maps %s to %i', (code, status, title) => {
    const res = createMockResponse();
    errorHandler(createApiError('msg', code), createMockRequest(), res, next);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: title, code }));
  });

  it('createApiError sets default status from reason code', () => {
    const err = createApiError('bad input', ReasonCode.VALIDATION_ERROR);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ReasonCode.VALIDATION_ERROR);
  });
});
