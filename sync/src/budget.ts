import type { Db } from './db';

/**
 * Gmail suspends IMAP for roughly 24 hours when an account exceeds about
 * 2.5 GB of downloads in a day. We budget against 2 GB to leave margin for
 * the fact that IMAP protocol overhead is not visible to us. (Spec L6)
 */
export const DAILY_BYTE_LIMIT = 2 * 1024 * 1024 * 1024;

/**
 * Backfill may consume at most this share of the daily budget, leaving the
 * remainder for live sync. Without this, a backfill exhausts the day's
 * allowance and new mail stops arriving until midnight.
 */
export const BACKFILL_SHARE = 0.7;

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly remaining: number;
}

export function checkBudget(
  used: number,
  requested: number,
  limit: number = DAILY_BYTE_LIMIT,
): BudgetDecision {
  const available = limit - used;
  const allowed = requested <= available;
  const remaining = Math.max(0, available - requested);
  return { allowed, remaining };
}

/**
 * Budget state is persisted per account per day, so a process restart
 * cannot silently reset the allowance and re-trigger a lockout.
 *
 * Note: Parameter properties are avoided project-wide because the service
 * runs under --experimental-strip-types, which does not support them.
 */
export class ByteBudget {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async used(accountId: string): Promise<number> {
    const rows = await this.db.query(
      'select bytes_used from byte_budget where account_id=$1 and day=$2',
      [accountId, this.today()],
    );
    return Number(rows[0]?.bytes_used ?? 0);
  }

  async reserve(accountId: string, bytes: number, limit?: number): Promise<BudgetDecision> {
    return checkBudget(await this.used(accountId), bytes, limit);
  }

  async record(accountId: string, bytes: number): Promise<void> {
    await this.db.query(
      `insert into byte_budget (account_id, day, bytes_used) values ($1,$2,$3)
       on conflict (account_id, day) do update set bytes_used = byte_budget.bytes_used + $3`,
      [accountId, this.today(), bytes],
    );
  }
}
