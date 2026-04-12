import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { db } from '../db/connection';
import { commitStagedTransaction } from '../engine/post';
import { requirePermission } from './middleware/authorise';

// ---------------------------------------------------------------------------
// staging.ts — Approval queue endpoints
// ---------------------------------------------------------------------------

export const stagingRouter = Router();

/** GET /api/staging?status=PENDING */
stagingRouter.get('/', requirePermission('transaction:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 'PENDING', period_id } = req.query as Record<string, string | undefined>;

    let query = db('staging').orderBy('submitted_at', 'asc');
    if (status !== 'ALL') query = query.where('status', status);
    if (period_id) query = query.where('period_id', period_id);

    const rows = await query;

    // Attach documents to each staging entry
    const stagingIds = rows.map((r: { staging_id: string }) => r.staging_id);
    const allDocs = stagingIds.length > 0
      ? await db('inbox_documents')
          .whereIn('assigned_staging_id', stagingIds)
          .select('id', 'filename', 'mime_type', 'document_type', 'file_size', 'completed_at', 'assigned_staging_id')
          .orderBy('completed_at', 'desc')
      : [];

    const docsByStagingId = new Map<string, typeof allDocs>();
    for (const doc of allDocs) {
      const sid = (doc as { assigned_staging_id: string }).assigned_staging_id;
      if (!docsByStagingId.has(sid)) docsByStagingId.set(sid, []);
      docsByStagingId.get(sid)!.push(doc);
    }

    const enrichedRows = rows.map((r: { staging_id: string }) => ({
      ...r,
      documents: docsByStagingId.get(r.staging_id) ?? [],
    }));

    res.json({ success: true, data: enrichedRows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/staging/:id/approve */
stagingRouter.post('/:id/approve', requirePermission('transaction:approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const approvedBy = (req.headers['x-user-id'] as string | undefined) ?? 'unknown';
    const result = await commitStagedTransaction(id, approvedBy);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** POST /api/staging/:id/reject */
stagingRouter.post('/:id/reject', requirePermission('transaction:reject'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const rejectedBy = (req.headers['x-user-id'] as string | undefined) ?? 'unknown';
    const { reason } = req.body as { reason?: string };

    const count = await db('staging')
      .where('staging_id', id)
      .where('status', 'PENDING')
      .update({
        status: 'REJECTED',
        reviewed_at: new Date().toISOString(),
        reviewed_by: reason ? `${rejectedBy}: ${reason}` : rejectedBy,
      });

    if (count === 0) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Staging entry ${id} not found or not PENDING` },
      });
      return;
    }

    const row = await db('staging').where('staging_id', id).first();
    res.json({ success: true, data: row });
  } catch (err) {
    next(err);
  }
});
