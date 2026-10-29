import type { Knex } from 'knex';
import db from '../../src/db/connection';
import {
  runInTransaction,
  Rollback,
  executorFor,
  isUniqueViolation,
} from '../../src/db/repositories/transaction';

const TABLE = 'tx_probe';

describe('runInTransaction', () => {
  beforeAll(async () => {
    await db.schema.createTable(TABLE, (table) => {
      table.string('id').primary();
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db(TABLE).del();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function insert(tx: Parameters<typeof executorFor>[0], id: string): Promise<void> {
    const q = await executorFor(tx);
    await q(TABLE).insert({ id });
  }

  it('commits every scoped write when the work resolves', async () => {
    const result = await runInTransaction(async (tx) => {
      await insert(tx, 'a');
      await insert(tx, 'b');
      return 'done';
    });
    expect(result).toBe('done');
    expect((await db(TABLE).orderBy('id')).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('rolls back every scoped write when the work throws', async () => {
    await expect(runInTransaction(async (tx) => {
      await insert(tx, 'a');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db(TABLE)).toHaveLength(0);
  });

  it('rolls back on a database error inside the work (e.g. a unique violation)', async () => {
    await db(TABLE).insert({ id: 'taken' });
    let caught: unknown;
    try {
      await runInTransaction(async (tx) => {
        await insert(tx, 'new');
        await insert(tx, 'taken');
      });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect((await db(TABLE)).map((r) => r.id)).toEqual(['taken']);
  });

  it('resolves with the Rollback result after undoing the writes', async () => {
    const result = await runInTransaction<string>(async (tx) => {
      await insert(tx, 'a');
      throw new Rollback('conflict');
    });
    expect(result).toBe('conflict');
    expect(await db(TABLE)).toHaveLength(0);
  });

  it('never opens a transaction when no scoped query runs', async () => {
    const fakeDb = { transaction: jest.fn() } as unknown as Knex;
    await expect(runInTransaction(async () => 42, fakeDb)).resolves.toBe(42);
    await expect(runInTransaction(async () => {
      throw new Rollback('early');
    }, fakeDb)).resolves.toBe('early');
    expect(fakeDb.transaction).not.toHaveBeenCalled();

    const statements: string[] = [];
    const onQuery = (query: { sql: string }) => statements.push(query.sql);
    db.on('query', onQuery);
    await runInTransaction(async () => 'no-op');
    db.removeListener('query', onQuery);
    expect(statements).toEqual([]);
  });

  it('starts the transaction once and shares it across scoped calls', async () => {
    const fakeTrx = { commit: jest.fn().mockResolvedValue(undefined) };
    const fakeDb = { transaction: jest.fn().mockResolvedValue(fakeTrx) } as unknown as Knex;
    await runInTransaction(async (tx) => {
      expect(await tx.executor()).toBe(fakeTrx);
      expect(await tx.executor()).toBe(fakeTrx);
    }, fakeDb);
    expect(fakeDb.transaction).toHaveBeenCalledTimes(1);
    expect(fakeTrx.commit).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a failed rollback, rethrowing the original error', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const fakeDb = { transaction: () => Promise.reject(new Error('acquire failed')) } as unknown as Knex;

    await expect(runInTransaction(async (tx) => {
      await tx.executor().catch(() => undefined);
      throw new Error('work failed');
    }, fakeDb)).rejects.toThrow('work failed');
    expect(consoleSpy).toHaveBeenCalledWith('[ERROR] Transaction rollback failed:', expect.any(Error));
  });

  it('uses the shared pool when no scope is given', async () => {
    expect(await executorFor()).toBe(db);
  });
});

describe('isUniqueViolation', () => {
  it.each([
    [{ code: '23505' }, true],
    [{ code: 'SQLITE_CONSTRAINT', message: 'UNIQUE constraint failed: t.id' }, true],
    [{ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'x - UNIQUE constraint failed: t.id' }, true],
    [{ code: 'SQLITE_CONSTRAINT', message: 'NOT NULL constraint failed: t.id' }, false],
    [{ code: 'SQLITE_CONSTRAINT' }, false],
    [{ code: '23503' }, false],
    [new Error('plain'), false],
    [null, false],
    ['23505', false],
  ])('%j -> %s', (error, expected) => {
    expect(isUniqueViolation(error)).toBe(expected);
  });
});
