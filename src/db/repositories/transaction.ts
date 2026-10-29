import type { Knex } from 'knex';
import db from '../connection';

/**
 * Handle shared by the repository calls of one unit of work.
 *
 * The underlying database transaction is started lazily, on the first query
 * that needs it, so a unit of work whose repository calls never reach the
 * database (for example fully stubbed unit tests) never opens a connection.
 */
export interface TransactionScope {
  executor(): Promise<Knex.Transaction>;
}

/**
 * Thrown inside a unit of work to roll it back and make runInTransaction
 * resolve with `result` instead of rejecting.
 */
export class Rollback<T> extends Error {
  constructor(readonly result: T) {
    super('Transaction rolled back');
    this.name = 'Rollback';
  }
}

/** Query executor for a repository call: the scope's transaction, or the shared pool. */
export async function executorFor(tx?: TransactionScope): Promise<Knex> {
  return tx ? tx.executor() : db;
}

/**
 * Runs `work` atomically. Every repository call that receives the scope uses
 * the same transaction; it commits when `work` resolves and rolls back when it
 * throws. Callers must not issue non-scoped queries inside `work` (SQLite uses
 * a single pooled connection, so they would wait for the open transaction).
 */
export async function runInTransaction<T>(
  work: (tx: TransactionScope) => Promise<T>,
  database: Knex = db
): Promise<T> {
  let pending: Promise<Knex.Transaction> | undefined;
  const scope: TransactionScope = {
    executor: () => {
      pending ??= database.transaction();
      return pending;
    },
  };

  let result: T;
  try {
    result = await work(scope);
  } catch (error) {
    await rollbackQuietly(pending);
    if (error instanceof Rollback) {
      return error.result as T;
    }
    throw error;
  }

  if (pending) {
    const trx = await pending;
    await trx.commit();
  }
  return result;
}

async function rollbackQuietly(pending: Promise<Knex.Transaction> | undefined): Promise<void> {
  if (!pending) return;
  try {
    const trx = await pending;
    if (!trx.isCompleted()) {
      await trx.rollback();
    }
  } catch (rollbackError) {
    console.error('[ERROR] Transaction rollback failed:', rollbackError);
  }
}

/** Detects a unique-constraint violation from SQLite or Postgres. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === '23505') return true;
  return (code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE')
    && typeof message === 'string'
    && /UNIQUE constraint failed/i.test(message);
}
