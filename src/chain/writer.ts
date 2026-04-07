import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { computeEntryHash } from './hash';
import { buildMerkleTree } from './merkle';
import { ChainReader } from './reader';
import type { ChainEntry, EntryType, GenesisPayload, PeriodStatus } from './types';
import {
  ChainFileExistsError,
  ChainFileNotFoundError,
  PeriodClosedError,
  PeriodSoftClosedError,
} from './types';

// ---------------------------------------------------------------------------
// Per-period write mutex
// ---------------------------------------------------------------------------

/**
 * Promise-based non-reentrant mutex. Only one caller at a time holds the lock
 * for a given period's chain file, serialising concurrent write requests.
 */
class Mutex {
  private _locked = false;
  private readonly _queue: Array<() => void> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve(() => this._release());
      } else {
        // Queue a callback that will hand the (already-held) lock to this
        // waiter when the current holder calls release().
        this._queue.push(() => {
          resolve(() => this._release());
        });
      }
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next !== undefined) {
      // Transfer the lock directly to the next waiter — _locked stays true.
      next();
    } else {
      this._locked = false;
    }
  }
}

// ---------------------------------------------------------------------------
// ChainWriter
// ---------------------------------------------------------------------------

export interface ChainWriterOptions {
  /**
   * Directory where chain files are stored for this tenant.
   * e.g. "chains/default" — files are named `{period_id}.chain.jsonl`.
   */
  chainDir: string;

  /**
   * Returns the current DB status of a period, or null if not found.
   *
   * Injected so that unit tests can mock it without a real database.
   * In production, supply a function that queries the `periods` table.
   *
   * Defaults to always returning 'OPEN' (convenient for tests / bootstrapping).
   */
  getPeriodStatus?: (periodId: string) => Promise<PeriodStatus | null>;
}

export class ChainWriter {
  private readonly chainDir: string;
  private readonly reader: ChainReader;
  private readonly getPeriodStatus: (periodId: string) => Promise<PeriodStatus | null>;
  private readonly mutexes = new Map<string, Mutex>();

  constructor(options: ChainWriterOptions) {
    this.chainDir = options.chainDir;
    this.reader = new ChainReader(options.chainDir);
    this.getPeriodStatus = options.getPeriodStatus ?? (() => Promise.resolve('OPEN' as const));
  }

  private getFilePath(periodId: string): string {
    return path.join(this.chainDir, `${periodId}.chain.jsonl`);
  }

  private getMutex(periodId: string): Mutex {
    let m = this.mutexes.get(periodId);
    if (m === undefined) {
      m = new Mutex();
      this.mutexes.set(periodId, m);
    }
    return m;
  }

  private async fileExists(periodId: string): Promise<boolean> {
    try {
      await fs.access(this.getFilePath(periodId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Crash recovery: if the last line of the file is not valid JSON (e.g. the
   * process crashed mid-write before fsync completed), truncate it so the
   * chain file is left in a consistent state.
   */
  private async cleanupIncompleteLastLine(filePath: string): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return; // File doesn't exist or can't be read — nothing to clean up.
    }

    if (!content) return;

    // Split on newlines; the trailing \n produces an empty last element.
    const lines = content.split('\n');
    const nonEmpty = lines.filter((l) => l.trim() !== '');
    if (nonEmpty.length === 0) return;

    const lastLine = nonEmpty[nonEmpty.length - 1];
    if (lastLine === undefined) return;

    try {
      JSON.parse(lastLine);
      // Last line is valid JSON — no truncation needed.
    } catch {
      // Last line is corrupted. Rewrite the file with only the valid lines.
      const validLines = nonEmpty.slice(0, -1);
      const truncated = validLines.length > 0 ? validLines.join('\n') + '\n' : '';
      await fs.writeFile(filePath, truncated, 'utf8');
    }
  }

  /**
   * Core append logic — NOT mutex-protected, NOT status-checked.
   * All public methods that write entries acquire the mutex themselves.
   */
  private async _writeEntry(
    periodId: string,
    type: EntryType,
    payload: Record<string, unknown>,
  ): Promise<ChainEntry> {
    const filePath = this.getFilePath(periodId);

    await this.cleanupIncompleteLastLine(filePath);

    const lastEntry = await this.reader.getLastEntry(periodId);

    if (lastEntry === null) {
      // File exists but has no valid entries — inconsistent state.
      throw new Error(
        `Chain file for ${periodId} exists but contains no valid entries. ` +
          `Re-initialise with createPeriodFile.`,
      );
    }

    // For TRANSACTION entries, compute the 0-based merkle_index by counting
    // all existing TRANSACTION entries in this period's chain file.
    let merkleIndex: number | null = null;
    if (type === 'TRANSACTION') {
      const existingEntries = await this.reader.readAllEntries(periodId);
      merkleIndex = existingEntries.filter((e) => e.type === 'TRANSACTION').length;
    }

    const entry: ChainEntry = {
      sequence: lastEntry.sequence + 1,
      timestamp: new Date().toISOString(),
      previous_hash: lastEntry.entry_hash,
      entry_hash: '',
      type,
      merkle_index: merkleIndex,
      payload,
    };
    entry.entry_hash = computeEntryHash(entry);

    const line = JSON.stringify(entry) + '\n';
    const fd = await fs.open(filePath, 'a');
    try {
      await fd.write(line);
      await fd.sync(); // fsync — ensures the write is durable on disk.
    } finally {
      await fd.close();
    }

    return entry;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Appends a new entry to the chain file for the given period.
   *
   * Acquires the per-period write lock, checks the period status, then
   * delegates to _writeEntry.
   *
   * @throws PeriodClosedError       – period is HARD_CLOSE
   * @throws PeriodSoftClosedError   – period is SOFT_CLOSE and no override
   * @throws ChainFileNotFoundError  – chain file does not exist
   */
  async appendEntry(
    periodId: string,
    type: EntryType,
    payload: Record<string, unknown>,
    options?: { softCloseOverride?: boolean },
  ): Promise<ChainEntry> {
    const release = await this.getMutex(periodId).acquire();
    try {
      const status = await this.getPeriodStatus(periodId);
      if (status === 'HARD_CLOSE') {
        throw new PeriodClosedError(periodId);
      }
      if (status === 'SOFT_CLOSE' && !options?.softCloseOverride) {
        throw new PeriodSoftClosedError(periodId);
      }

      if (!(await this.fileExists(periodId))) {
        throw new ChainFileNotFoundError(periodId);
      }

      return await this._writeEntry(periodId, type, payload);
    } finally {
      release();
    }
  }

  /**
   * Creates a new chain file for a period with a GENESIS entry that links
   * back to the previous period's closing hash.
   *
   * @throws ChainFileExistsError – file already exists
   */
  async createPeriodFile(
    periodId: string,
    previousPeriodId: string | null,
    openingBalances: Record<string, { debit: number; credit: number }>,
  ): Promise<ChainEntry> {
    const filePath = this.getFilePath(periodId);

    if (await this.fileExists(periodId)) {
      throw new ChainFileExistsError(periodId);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Determine the previous_hash for the genesis entry.
    let previousHash: string;
    let previousPeriodClosingHash: string | null = null;

    if (previousPeriodId !== null) {
      const prevLast = await this.reader.getLastEntry(previousPeriodId);
      if (prevLast === null || prevLast.type !== 'PERIOD_CLOSE') {
        throw new Error(
          `Cannot create period ${periodId}: previous period ${previousPeriodId} ` +
            `does not end with a PERIOD_CLOSE entry.`,
        );
      }
      previousHash = prevLast.entry_hash;
      previousPeriodClosingHash = prevLast.entry_hash;
    } else {
      // First period ever — the literal string "GENESIS".
      previousHash = 'GENESIS';
    }

    const genesisPayload: GenesisPayload = {
      period_id: periodId,
      previous_period_id: previousPeriodId,
      previous_period_closing_hash: previousPeriodClosingHash,
      opening_balances: openingBalances,
      open_mode: previousPeriodId === null && Object.keys(openingBalances).length === 0
        ? 'INDEPENDENT'
        : previousPeriodId === null
          ? 'GENESIS'
          : 'SEQUENTIAL',
    };

    const entry: ChainEntry = {
      sequence: 1,
      timestamp: new Date().toISOString(),
      previous_hash: previousHash,
      entry_hash: '',
      type: 'GENESIS',
      merkle_index: null,
      payload: genesisPayload as unknown as Record<string, unknown>,
    };
    entry.entry_hash = computeEntryHash(entry);

    // 'wx' flag: fail if the file already exists (belt-and-braces).
    const fd = await fs.open(filePath, 'wx');
    try {
      await fd.write(JSON.stringify(entry) + '\n');
      await fd.sync();
    } finally {
      await fd.close();
    }

    return entry;
  }

  /**
   * Writes the PERIOD_CLOSE entry and makes the chain file read-only at the
   * OS level so no further writes can be appended.
   *
   * After this call, the file is chmod 0o444.  Any subsequent write attempt
   * (at the OS level) will fail with EACCES, providing a belt-and-braces
   * safeguard in addition to the period-status check in appendEntry.
   *
   * @throws ChainFileNotFoundError – chain file does not exist
   */
  async sealPeriod(
    periodId: string,
    closingPayload: Record<string, unknown>,
  ): Promise<ChainEntry> {
    const release = await this.getMutex(periodId).acquire();
    try {
      if (!(await this.fileExists(periodId))) {
        throw new ChainFileNotFoundError(periodId);
      }

      // Compute Merkle root from all TRANSACTION entries in this period.
      const allEntries = await this.reader.readAllEntries(periodId);
      const txHashes = allEntries
        .filter((e) => e.type === 'TRANSACTION')
        .map((e) => e.entry_hash);
      const merkleRoot = buildMerkleTree(txHashes);

      const enrichedPayload = {
        ...closingPayload,
        merkle_root: merkleRoot,
      };

      const entry = await this._writeEntry(periodId, 'PERIOD_CLOSE', enrichedPayload);

      // Make the file read-only at the OS level.
      await fs.chmod(this.getFilePath(periodId), 0o444);

      return entry;
    } finally {
      release();
    }
  }
}
