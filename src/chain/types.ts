// ---------------------------------------------------------------------------
// Chain file data structures and error classes
// ---------------------------------------------------------------------------

export type EntryType = 'TRANSACTION' | 'PERIOD_CLOSE' | 'GENESIS';

export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';

/**
 * A single record in a period's chain file.
 *
 * Fields are ordered to match the canonical serialisation used for hashing.
 * Do not reorder them without updating the hash computation tests.
 */
export interface ChainEntry {
  sequence: number;           // 1-based, increments by 1, no gaps
  timestamp: string;          // UTC ISO 8601 commit timestamp
  previous_hash: string;      // entry_hash of the preceding entry, or "GENESIS"
  entry_hash: string;         // SHA-256 of the canonical form of this entry
  type: EntryType;
  merkle_index: number | null; // 0-based position in the Merkle tree; null for GENESIS/PERIOD_CLOSE
  payload: Record<string, unknown>;
}

/** Payload for the first entry in a period's chain file. */
export interface GenesisPayload {
  period_id: string;
  previous_period_id: string | null;
  previous_period_closing_hash: string | null;
  opening_balances: Record<string, { debit: number; credit: number }>;
  open_mode?: 'GENESIS' | 'SEQUENTIAL' | 'INDEPENDENT';
}

/** Payload for the final entry in a period's chain file. */
export interface PeriodClosePayload {
  period_id: string;
  closing_trial_balance: Record<string, { debit: number; credit: number }>;
  total_transactions: number;
  total_debits: number;
  total_credits: number;
  closed_by: string;
}

export interface ChainVerifyResult {
  valid: boolean;
  entries: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class PeriodClosedError extends Error {
  readonly periodId: string;
  constructor(periodId: string) {
    super(`Period ${periodId} is closed. No further postings are accepted.`);
    this.name = 'PeriodClosedError';
    this.periodId = periodId;
  }
}

export class PeriodSoftClosedError extends Error {
  readonly periodId: string;
  constructor(periodId: string) {
    super(
      `Period ${periodId} is in soft close. Only postings with soft_close_override are accepted.`,
    );
    this.name = 'PeriodSoftClosedError';
    this.periodId = periodId;
  }
}

export class ChainFileExistsError extends Error {
  readonly periodId: string;
  constructor(periodId: string) {
    super(`Chain file for period ${periodId} already exists.`);
    this.name = 'ChainFileExistsError';
    this.periodId = periodId;
  }
}

export class ChainFileNotFoundError extends Error {
  readonly periodId: string;
  constructor(periodId: string) {
    super(
      `Chain file for period ${periodId} does not exist. Call createPeriodFile to initialise the period.`,
    );
    this.name = 'ChainFileNotFoundError';
    this.periodId = periodId;
  }
}

export class ChainIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainIntegrityError';
  }
}
