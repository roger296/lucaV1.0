import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { ChainWriter } from '../chain/writer';
import { config } from '../config';
import { db } from '../db/connection';
import { hardClosePeriod, softClosePeriod } from '../engine/periods';
import { generateFxRevaluations } from '../engine/currency';
import { postTransaction } from '../engine/post';
import { executeYearEndClose } from '../engine/year-end';
import { requirePermission } from './middleware/authorise';

// ---------------------------------------------------------------------------
// periods.ts — Period management endpoints
// ---------------------------------------------------------------------------

export const periodsRouter = Router();

function makeChainWriter(): ChainWriter {
  return new ChainWriter({
    chainDir: config.chainDir,
    getPeriodStatus: async (periodId) => {
      const row = await db('periods')
        .where('period_id', periodId)
        .select('status')
        .first<{ status: string } | undefined>();
      return (row?.status as 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | null) ?? null;
    },
  });
}

/** GET /api/periods */
periodsRouter.get('/', requirePermission('period:view'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db('periods').orderBy('period_id', 'desc');
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/periods/current — most recent OPEN period */
periodsRouter.get('/current', requirePermission('period:view'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await db('periods').where('status', 'OPEN').orderBy('period_id', 'desc').first();
    if (!row) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No open period found' } });
      return;
    }
    res.json({ success: true, data: row });
  } catch (err) {
    next(err);
  }
});

/** POST /api/periods — Open a new period */
periodsRouter.post('/', requirePermission('period:hard_close'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period_id } = req.body as { period_id: string };
    if (!period_id) {
      res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'period_id is required' } });
      return;
    }
    const { openPeriod } = await import('../engine/periods');
    const chainWriter = makeChainWriter();
    const result = await openPeriod(period_id, { chainWriter });
    res.status(result.is_new ? 201 : 200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/periods/:id */
periodsRouter.get('/:id', requirePermission('period:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const row = await db('periods').where('period_id', id).first();
    if (!row) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Period ${id} not found` } });
      return;
    }
    // Include staging count and trial balance for checklist display.
    const staging = await db('staging')
      .where('period_id', id)
      .where('status', 'PENDING')
      .count<[{ count: string }]>('staging_id as count')
      .first();
    const bal = await db('transaction_lines')
      .where('period_id', id)
      .select(
        db.raw('COALESCE(SUM(debit), 0) as total_debits'),
        db.raw('COALESCE(SUM(credit), 0) as total_credits'),
      )
      .first<{ total_debits: string; total_credits: string }>();

    res.json({
      success: true,
      data: {
        ...row,
        pending_staging_count: parseInt(staging?.count ?? '0', 10),
        total_debits: bal?.total_debits ?? '0',
        total_credits: bal?.total_credits ?? '0',
      },
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/periods/:id/soft-close */
periodsRouter.post('/:id/soft-close', requirePermission('period:soft_close'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const today = (req.body as { today?: string }).today;
    const result = await softClosePeriod(id, today);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** POST /api/periods/:id/hard-close */
periodsRouter.post('/:id/hard-close', requirePermission('period:hard_close'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const closedBy =
      ((req.body as Record<string, string>)['closed_by']) ||
      (req.headers['x-user-id'] as string | undefined) ||
      'unknown';
    const result = await hardClosePeriod(id, {
      closedBy,
      chainWriter: makeChainWriter(),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/periods/:id/fx-revaluation
 *
 * Computes FX revaluation adjustments for a period and optionally posts them.
 *
 * Body: { closing_rates: { "USD": "0.79", "EUR": "0.855", ... }, post: true|false }
 * - closing_rates: Map of foreign currency → closing exchange rate (to GBP).
 * - post: if true, immediately post the revaluation journals; if false (default),
 *   return a preview of what would be posted.
 */
periodsRouter.post('/:id/fx-revaluation', requirePermission('period:hard_close'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const periodId = req.params['id'] as string;
    const { closing_rates, post: doPost = false } = req.body as {
      closing_rates: Record<string, string>;
      post?: boolean;
    };

    if (!closing_rates || typeof closing_rates !== 'object' || Object.keys(closing_rates).length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'closing_rates is required and must be a non-empty object' },
      });
      return;
    }

    const period = await db('periods').where('period_id', periodId).first<{ status: string } | undefined>();
    if (!period) {
      res.status(404).json({
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      });
      return;
    }

    const { entries, submissions } = await generateFxRevaluations(periodId, closing_rates);

    if (!doPost) {
      res.json({ success: true, data: { preview: true, entries, submissions } });
      return;
    }

    // Post all revaluation journals.
    const writer = makeChainWriter();
    const results = [];
    for (const sub of submissions) {
      const result = await postTransaction(
        {
          transaction_type: 'FX_REVALUATION' as import('../engine/types').TransactionType,
          date: sub.date,
          period_id: sub.period_id,
          description: sub.description,
          currency: sub.currency,
          exchange_rate: sub.exchange_rate,
          lines: sub.lines as import('../engine/types').JournalLine[],
          idempotency_key: sub.idempotency_key,
          source: sub.source,
        },
        writer,
      );
      results.push(result);
    }

    res.json({
      success: true,
      data: {
        preview: false,
        entries,
        posted: results.length,
        results,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/periods/year-end-close */
periodsRouter.post('/year-end-close', requirePermission('period:hard_close'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { financial_year_end, new_year_first_period } = req.body as {
      financial_year_end: string;
      new_year_first_period: string;
    };
    if (!financial_year_end || !new_year_first_period) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'financial_year_end and new_year_first_period are required' },
      });
      return;
    }
    const result = await executeYearEndClose(financial_year_end, new_year_first_period);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});
