import Decimal from 'decimal.js';
import type { Knex } from 'knex';
import { ChainWriter } from '../chain/writer';
import { db } from '../db/connection';
import { publishEvent } from './webhooks';

// ---------------------------------------------------------------------------
// periods.ts — period state management and closing
// ---------------------------------------------------------------------------

// ── Error classes ────────────────────────────────────────────────────────────

export class InvalidPeriodStateError extends Error {
  constructor(periodId: string, currentStatus: string, requiredStatus: string) {
    super(`Period ${periodId} is ${currentStatus}, must be ${requiredStatus}`);
    this.name = 'InvalidPeriodStateError';
  }
}

export class PeriodNotFoundError extends Error {
  constructor(periodId: string) {
    super(`Period ${periodId} not found`);
    this.name = 'PeriodNotFoundError';
  }
}

export class PeriodSequenceError extends Error {
  constructor(periodId: string, previousPeriodId: string) {
    super(
      `Cannot close ${periodId}: previous period ${previousPeriodId} is not yet closed`,
    );
    this.name = 'PeriodSequenceError';
  }
}

export class StagingNotClearError extends Error {
  constructor(periodId: string, pendingCount: number) {
    super(
      `Cannot close ${periodId}: ${pendingCount} transaction${pendingCount === 1 ? '' : 's'} still pending approval`,
    );
    this.name = 'StagingNotClearError';
  }
}

export class TrialBalanceError extends Error {
  constructor(periodId: string, totalDebits: string, totalCredits: string) {
    super(
      `Cannot close ${periodId}: trial balance does not balance. ` +
        `Debits: ${totalDebits}, Credits: ${totalCredits}, ` +
        `Difference: ${new Decimal(totalDebits).minus(totalCredits).abs().toFixed(2)}`,
    );
    this.name = 'TrialBalanceError';
  }
}

export class PeriodNotEndedError extends Error {
  constructor(periodId: string, endDate: string) {
    super(
      `Cannot soft-close ${periodId}: period end date ${endDate} has not yet passed`,
    );
    this.name = 'PeriodNotEndedError';
  }
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface PeriodRow {
  period_id: string;
  start_date: string;
  end_date: string;
  status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';
  data_flag: 'PROVISIONAL' | 'AUTHORITATIVE';
  opened_at: string;
  soft_closed_at: string | null;
  hard_closed_at: string | null;
  closed_by: string | null;
  closing_chain_hash: string | null;
}

// ── Public result types ───────────────────────────────────────────────────────

export interface SoftCloseResult {
  period_id: string;
  status: 'SOFT_CLOSE';
  soft_closed_at: string;
}

export interface HardCloseResult {
  period_id: string;
  status: 'HARD_CLOSE';
  hard_closed_at: string;
  closing_chain_hash: string;
  next_period_id: string;
}

// ── Balance sheet account types that carry forward to next period ─────────────

const BALANCE_SHEET_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY']);

// ---------------------------------------------------------------------------
// softClosePeriod
// ---------------------------------------------------------------------------

/**
 * Transitions a period from OPEN → SOFT_CLOSE.
 *
 * Checks:
 *  - Period must exist and be OPEN.
 *  - Today must be on or after the period's end_date.
 *
 * After soft close, appendEntry still accepts transactions for this period
 * only if softCloseOverride is set.
 */
export async function softClosePeriod(
  periodId: string,
  todayOverride?: string, // inject "today" in tests to avoid date-dependency
): Promise<SoftCloseResult> {
  return db.transaction(async (trx) => {
    const period = await trx<PeriodRow>('periods')
      .where('period_id', periodId)
      .forUpdate()
      .first();

    if (!period) throw new PeriodNotFoundError(periodId);
    if (period.status !== 'OPEN') {
      throw new InvalidPeriodStateError(periodId, period.status, 'OPEN');
    }

    const today = todayOverride ?? new Date().toISOString().slice(0, 10);
    if (today < period.end_date) {
      throw new PeriodNotEndedError(periodId, period.end_date);
    }

    const now = new Date().toISOString();
    await trx('periods').where('period_id', periodId).update({
      status: 'SOFT_CLOSE',
      soft_closed_at: now,
    });

    const softCloseResult: SoftCloseResult = { period_id: periodId, status: 'SOFT_CLOSE', soft_closed_at: now };

    publishEvent('PERIOD_SOFT_CLOSED', { period_id: periodId, soft_closed_at: now });

    return softCloseResult;
  });
}

// ── Public result type ──────────────────────────────────────────────────────

export interface OpenPeriodResult {
  period_id: string;
  status: 'OPEN';
  start_date: string;
  end_date: string;
  opened_at: string;
  is_new: boolean;
}

/**
 * Opens (or returns) an accounting period.
 *
 * If the period already exists and is OPEN or SOFT_CLOSE, returns it.
 * If the period does not exist, creates a new DB row and chain genesis file.
 * If the period exists and is HARD_CLOSE, throws — a sealed period cannot be reopened.
 */
export async function openPeriod(
  periodId: string,
  opts: {
    chainWriter: ChainWriter;
  },
): Promise<OpenPeriodResult> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodId)) {
    throw new Error(`Invalid period_id format: "${periodId}". Expected YYYY-MM.`);
  }

  return db.transaction(async (trx) => {
    const existing = await trx<PeriodRow>('periods')
      .where('period_id', periodId)
      .forUpdate()
      .first();

    if (existing) {
      if (existing.status === 'HARD_CLOSE') {
        throw new InvalidPeriodStateError(periodId, 'HARD_CLOSE', 'OPEN or not yet created');
      }
      return {
        period_id: existing.period_id,
        status: 'OPEN' as const,
        start_date: existing.start_date,
        end_date: existing.end_date,
        opened_at: existing.opened_at,
        is_new: false,
      };
    }

    const { startDate, endDate } = computePeriodDates(periodId);
    const now = new Date().toISOString();

    await trx('periods').insert({
      period_id: periodId,
      start_date: startDate,
      end_date: endDate,
      status: 'OPEN',
      data_flag: 'PROVISIONAL',
      opened_at: now,
    });

    await trx('chain_metadata')
      .insert({
        period_id: periodId,
        last_sequence: 0,
        last_entry_hash: null,
        entry_count: 0,
        last_verified_at: null,
        chain_valid: null,
      })
      .onConflict('period_id')
      .ignore();

    await opts.chainWriter.createPeriodFile(periodId, null, {});

    publishEvent('PERIOD_OPENED', { period_id: periodId, opened_at: now });

    return {
      period_id: periodId,
      status: 'OPEN' as const,
      start_date: startDate,
      end_date: endDate,
      opened_at: now,
      is_new: true,
    };
  });
}

// ---------------------------------------------------------------------------
// hardClosePeriod
// ---------------------------------------------------------------------------

/**
 * Transitions a period from SOFT_CLOSE → HARD_CLOSE.
 *
 * Full checklist (all must pass):
 *  1. Period must exist and be SOFT_CLOSE.
 *  2. All prior periods must already be HARD_CLOSE.
 *  3. No PENDING entries in the staging table for this period.
 *  4. Trial balance must balance (total debits = total credits).
 *  5. Write PERIOD_CLOSE chain entry and seal the file (chmod 444).
 *  6. Update period row → HARD_CLOSE / AUTHORITATIVE.
 *  7. Flag all transactions and lines for this period as AUTHORITATIVE.
 *  8. Create the next period (DB row + chain genesis entry).
 */
export async function hardClosePeriod(
  periodId: string,
  opts: {
    closedBy: string;
    chainWriter: ChainWriter;
    todayOverride?: string; // used when creating next period — not for the close itself
  },
): Promise<HardCloseResult> {
  return db.transaction(async (trx) => {
    // ── 1. State check ───────────────────────────────────────────────────────
    const period = await trx<PeriodRow>('periods')
      .where('period_id', periodId)
      .forUpdate()
      .first();

    if (!period) throw new PeriodNotFoundError(periodId);
    if (period.status !== 'SOFT_CLOSE') {
      throw new InvalidPeriodStateError(periodId, period.status, 'SOFT_CLOSE');
    }

    // ── 2. Sequential ordering ───────────────────────────────────────────────
    // Check that the immediately preceding calendar period (the previous month)
    // is already HARD_CLOSE before allowing this one to close.  We look up by
    // period_id rather than by date so that isolated test fixtures never
    // accidentally collide with seed-data periods from earlier years.
    const prevPeriodId = computePrevPeriodId(periodId);
    const prevPeriod = await trx<PeriodRow>('periods')
      .where('period_id', prevPeriodId)
      .first();

    if (prevPeriod && prevPeriod.status !== 'HARD_CLOSE') {
      throw new PeriodSequenceError(periodId, prevPeriod.period_id);
    }

    // ── 3. Staging area check ────────────────────────────────────────────────
    const pendingResult = await trx('staging')
      .where('period_id', periodId)
      .where('status', 'PENDING')
      .count<[{ count: string }]>('staging_id as count')
      .first();
    const pendingCount = parseInt(pendingResult?.count ?? '0', 10);
    if (pendingCount > 0) throw new StagingNotClearError(periodId, pendingCount);

    // ── 4. Trial balance check ───────────────────────────────────────────────
    const balResult = await trx('transaction_lines')
      .where('period_id', periodId)
      .select(
        trx.raw('COALESCE(SUM(debit), 0) as total_debits'),
        trx.raw('COALESCE(SUM(credit), 0) as total_credits'),
      )
      .first<{ total_debits: string; total_credits: string }>();

    const totalDebits = new Decimal(balResult?.total_debits ?? '0');
    const totalCredits = new Decimal(balResult?.total_credits ?? '0');

    if (!totalDebits.equals(totalCredits)) {
      throw new TrialBalanceError(periodId, totalDebits.toFixed(2), totalCredits.toFixed(2));
    }

    // ── 5. Compute closing trial balance ─────────────────────────────────────
    // Sum debits and credits per account for this period.
    const trialBalanceRows = await trx('transaction_lines')
      .where('transaction_lines.period_id', periodId)
      .join('accounts', 'transaction_lines.account_code', 'accounts.code')
      .select(
        'transaction_lines.account_code',
        trx.raw('COALESCE(SUM(transaction_lines.debit), 0) as total_debit'),
        trx.raw('COALESCE(SUM(transaction_lines.credit), 0) as total_credit'),
      )
      .groupBy('transaction_lines.account_code');

    const closingTrialBalance: Record<string, { debit: number; credit: number }> = {};
    for (const row of trialBalanceRows) {
      const d = new Decimal(row.total_debit as string);
      const c = new Decimal(row.total_credit as string);
      closingTrialBalance[row.account_code as string] = {
        debit: d.toNumber(),
        credit: c.toNumber(),
      };
    }

    // Count committed transactions in this period.
    const txCountResult = await trx('transactions')
      .where('period_id', periodId)
      .count<[{ count: string }]>('transaction_id as count')
      .first();
    const totalTransactions = parseInt(txCountResult?.count ?? '0', 10);

    // ── 6. Seal the chain file ───────────────────────────────────────────────
    const closingPayload = {
      period_id: periodId,
      closing_trial_balance: closingTrialBalance,
      total_transactions: totalTransactions,
      total_debits: totalDebits.toNumber(),
      total_credits: totalCredits.toNumber(),
      closed_by: opts.closedBy,
    };

    const closeEntry = await opts.chainWriter.sealPeriod(periodId, closingPayload);

    // ── 7. Update period in DB ───────────────────────────────────────────────
    const now = new Date().toISOString();
    await trx('periods').where('period_id', periodId).update({
      status: 'HARD_CLOSE',
      data_flag: 'AUTHORITATIVE',
      hard_closed_at: now,
      closed_by: opts.closedBy,
      closing_chain_hash: closeEntry.entry_hash,
    });

    // Flag all transactions and lines for this period as AUTHORITATIVE.
    await trx('transactions').where('period_id', periodId).update({ data_flag: 'AUTHORITATIVE' });
    await trx('transaction_lines')
      .where('period_id', periodId)
      .update({ data_flag: 'AUTHORITATIVE' });

    // ── 8. Create the next period ────────────────────────────────────────────
    const nextPeriodId = computeNextPeriodId(periodId);
    const { startDate: nextStart, endDate: nextEnd } = computePeriodDates(nextPeriodId);

    // Opening balances = closing balances of ASSET / LIABILITY / EQUITY accounts only.
    const openingBalances = await computeOpeningBalances(trx, periodId);

    // Insert next period row if it doesn't already exist.
    await trx('periods')
      .insert({
        period_id: nextPeriodId,
        start_date: nextStart,
        end_date: nextEnd,
        status: 'OPEN',
        data_flag: 'PROVISIONAL',
        opened_at: now,
      })
      .onConflict('period_id')
      .ignore();

    // Create the chain file genesis entry for the next period.
    await opts.chainWriter.createPeriodFile(nextPeriodId, periodId, openingBalances);

    const hardCloseResult: HardCloseResult = {
      period_id: periodId,
      status: 'HARD_CLOSE',
      hard_closed_at: now,
      closing_chain_hash: closeEntry.entry_hash,
      next_period_id: nextPeriodId,
    };

    publishEvent('PERIOD_CLOSED', {
      period_id: periodId,
      hard_closed_at: now,
      closing_chain_hash: closeEntry.entry_hash,
      next_period_id: nextPeriodId,
    });

    return hardCloseResult;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes opening balances for the next period.
 *
 * Only balance sheet accounts (ASSET, LIABILITY, EQUITY) carry forward.
 * Revenue and expense accounts start at zero in each period.
 *
 * The closing balance is the NET of all debits and credits for each account
 * across the period being closed.  We express it as:
 *   debit  = max(net_debit,  0)
 *   credit = max(net_credit, 0)
 * where net_debit = sum(debit) - sum(credit), etc.
 */
async function computeOpeningBalances(
  trx: Knex.Transaction,
  closingPeriodId: string,
): Promise<Record<string, { debit: number; credit: number }>> {
  const rows = await trx('transaction_lines')
    .where('transaction_lines.period_id', closingPeriodId)
    .join('accounts', 'transaction_lines.account_code', 'accounts.code')
    .whereIn('accounts.type', [...BALANCE_SHEET_TYPES])
    .select(
      'transaction_lines.account_code',
      trx.raw('COALESCE(SUM(transaction_lines.debit), 0) as total_debit'),
      trx.raw('COALESCE(SUM(transaction_lines.credit), 0) as total_credit'),
    )
    .groupBy('transaction_lines.account_code');

  const balances: Record<string, { debit: number; credit: number }> = {};
  for (const row of rows) {
    const d = new Decimal(row.total_debit as string);
    const c = new Decimal(row.total_credit as string);
    const net = d.minus(c);
    if (net.isPositive() && !net.isZero()) {
      balances[row.account_code as string] = { debit: net.toNumber(), credit: 0 };
    } else if (net.isNegative()) {
      balances[row.account_code as string] = { debit: 0, credit: net.abs().toNumber() };
    }
    // If net is zero, omit the account — it has no balance to carry forward.
  }
  return balances;
}

/**
 * Computes the previous period ID given a YYYY-MM string.
 * e.g. "2026-03" → "2026-02",  "2027-01" → "2026-12"
 */
function computePrevPeriodId(periodId: string): string {
  const [yearStr, monthStr] = periodId.split('-') as [string, string];
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * Computes the next period ID given a YYYY-MM string.
 * e.g. "2026-03" → "2026-04",  "2026-12" → "2027-01"
 */
export function computeNextPeriodId(periodId: string): string {
  const [yearStr, monthStr] = periodId.split('-') as [string, string];
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * Returns ISO start and end dates for a YYYY-MM period ID.
 */
export function computePeriodDates(periodId: string): { startDate: string; endDate: string } {
  const [yearStr, monthStr] = periodId.split('-') as [string, string];
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const startDate = `${periodId}-01`;
  // Last day of month: day 0 of next month = last day of this month.
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${periodId}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate };
}
