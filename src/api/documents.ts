import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import { Router } from 'express';
import { getDocumentById, getDocumentsByTransactionId, getDocumentsByStagingId } from '../engine/document-inbox';

export const documentsRouter = Router();

/** GET /api/documents/by-transaction/:txId — all documents for a committed transaction */
documentsRouter.get(
  '/by-transaction/:txId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docs = await getDocumentsByTransactionId(req.params['txId']!);
      res.json({ success: true, data: docs });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/documents/by-staging/:stagingId — all documents for a staging entry */
documentsRouter.get(
  '/by-staging/:stagingId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docs = await getDocumentsByStagingId(req.params['stagingId']!);
      res.json({ success: true, data: docs });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/documents/:id — single document metadata */
documentsRouter.get(
  '/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await getDocumentById(req.params['id']!);
      if (!doc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Document ${req.params['id']} not found` },
        });
        return;
      }
      res.json({ success: true, data: doc });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/documents/:id/file — stream the actual file to the browser */
documentsRouter.get(
  '/:id/file',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await getDocumentById(req.params['id']!);
      if (!doc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Document ${req.params['id']} not found` },
        });
        return;
      }

      const filePath = doc.original_path;
      if (!fs.existsSync(filePath)) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: `File not found on disk: ${doc.filename}` },
        });
        return;
      }

      const mimeType = doc.mime_type ?? 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
      if (doc.file_size) res.setHeader('Content-Length', doc.file_size);

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', (streamErr) => next(streamErr));
    } catch (err) {
      next(err);
    }
  },
);

export { getDocumentsByTransactionId };
