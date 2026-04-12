import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/connection';

export interface InboxDocument {
  id: string;
  filename: string;
  original_path: string;
  mime_type: string | null;
  file_size: number | null;
  status: string;
  document_type: string | null;
  assigned_transaction_id: string | null;
  assigned_staging_id: string | null;
  processing_notes: string | null;
  error_message: string | null;
  processed_by: string | null;
  extracted_data: Record<string, unknown> | null;
  detected_at: string;
  processing_started_at: string | null;
  completed_at: string | null;
}

export interface InboxStatus {
  pending: number;
  processing: number;
  processed: number;
  failed: number;
  skipped: number;
  total: number;
  watch_directory: string | null;
  is_active: boolean;
}

export interface ScanResult {
  new_files: number;
  total_pending: number;
  directory: string;
}

export interface InboxConfigRow {
  id: number;
  watch_directory: string;
  archive_directory: string | null;
  is_active: boolean;
  allowed_extensions: string[] | string;
  max_file_size_mb: number;
}

export async function configureInbox(params: {
  watch_directory: string;
  archive_directory?: string;
  allowed_extensions?: string[];
  max_file_size_mb?: number;
}): Promise<void> {
  const existing = await db('inbox_config').where('id', 1).first();
  const now = new Date().toISOString();

  if (existing) {
    const updates: Record<string, unknown> = { watch_directory: params.watch_directory, updated_at: now };
    if (params.archive_directory !== undefined) updates['archive_directory'] = params.archive_directory;
    if (params.allowed_extensions !== undefined) updates['allowed_extensions'] = JSON.stringify(params.allowed_extensions);
    if (params.max_file_size_mb !== undefined) updates['max_file_size_mb'] = params.max_file_size_mb;
    await db('inbox_config').where('id', 1).update(updates);
  } else {
    await db('inbox_config').insert({
      id: 1,
      watch_directory: params.watch_directory,
      archive_directory: params.archive_directory ?? null,
      is_active: true,
      allowed_extensions: JSON.stringify(params.allowed_extensions ?? ['.pdf', '.jpg', '.jpeg', '.png', '.csv', '.xlsx']),
      max_file_size_mb: params.max_file_size_mb ?? 25,
      created_at: now,
      updated_at: now,
    });
  }
}

export async function scanInbox(): Promise<ScanResult> {
  const config = await db('inbox_config').where('id', 1).first<InboxConfigRow>();
  if (!config || !config.is_active) {
    return { new_files: 0, total_pending: 0, directory: config?.watch_directory ?? '' };
  }

  const allowedExts: string[] = typeof config.allowed_extensions === 'string'
    ? JSON.parse(config.allowed_extensions)
    : config.allowed_extensions;

  let files: string[] = [];
  try {
    files = fs.readdirSync(config.watch_directory);
  } catch {
    return { new_files: 0, total_pending: 0, directory: config.watch_directory };
  }

  const filteredFiles = files.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return allowedExts.includes(ext);
  });

  let newFiles = 0;
  for (const filename of filteredFiles) {
    const fullPath = path.join(config.watch_directory, filename);
    const existing = await db('inbox_documents')
      .where('filename', filename)
      .where('original_path', fullPath)
      .first();
    if (!existing) {
      let fileSize: number | null = null;
      try {
        const stat = fs.statSync(fullPath);
        fileSize = stat.size;
      } catch { /**/ }

      await db('inbox_documents').insert({
        filename,
        original_path: fullPath,
        file_size: fileSize,
        status: 'PENDING',
        detected_at: new Date().toISOString(),
      });
      newFiles++;
    }
  }

  const totalPending = await db('inbox_documents')
    .where('status', 'PENDING')
    .count<[{ count: string }]>('id as count')
    .first();

  return {
    new_files: newFiles,
    total_pending: parseInt(totalPending?.count ?? '0', 10),
    directory: config.watch_directory,
  };
}

export async function getPendingDocuments(limit = 20): Promise<InboxDocument[]> {
  return db('inbox_documents').where('status', 'PENDING').orderBy('detected_at', 'asc').limit(limit);
}

export async function startProcessing(documentId: string, processedBy: string): Promise<void> {
  await db('inbox_documents').where('id', documentId).update({
    status: 'PROCESSING',
    processed_by: processedBy,
    processing_started_at: new Date().toISOString(),
  });
}

export async function completeProcessing(params: {
  document_id: string;
  document_type: string;
  transaction_id?: string;
  staging_id?: string;
  extracted_data?: Record<string, unknown>;
  processing_notes: string;
}): Promise<void> {
  await db('inbox_documents').where('id', params.document_id).update({
    status: 'PROCESSED',
    document_type: params.document_type,
    assigned_transaction_id: params.transaction_id ?? null,
    assigned_staging_id: params.staging_id ?? null,
    extracted_data: params.extracted_data ? JSON.stringify(params.extracted_data) : null,
    processing_notes: params.processing_notes,
    completed_at: new Date().toISOString(),
  });
}

export async function failProcessing(params: {
  document_id: string;
  error_message: string;
}): Promise<void> {
  await db('inbox_documents').where('id', params.document_id).update({
    status: 'FAILED',
    error_message: params.error_message,
    completed_at: new Date().toISOString(),
  });
}

export async function skipDocument(params: {
  document_id: string;
  reason: string;
}): Promise<void> {
  await db('inbox_documents').where('id', params.document_id).update({
    status: 'SKIPPED',
    processing_notes: params.reason,
    completed_at: new Date().toISOString(),
  });
}

export async function getInboxStatus(): Promise<InboxStatus> {
  const config = await db('inbox_config').where('id', 1).first<InboxConfigRow>();
  const counts = await db('inbox_documents')
    .select('status')
    .count<Array<{ status: string; count: string }>>('id as count')
    .groupBy('status');

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of counts) {
    const n = parseInt(row.count, 10);
    byStatus[row.status] = n;
    total += n;
  }

  return {
    pending: byStatus['PENDING'] ?? 0,
    processing: byStatus['PROCESSING'] ?? 0,
    processed: byStatus['PROCESSED'] ?? 0,
    failed: byStatus['FAILED'] ?? 0,
    skipped: byStatus['SKIPPED'] ?? 0,
    total,
    watch_directory: config?.watch_directory ?? null,
    is_active: config?.is_active ?? false,
  };
}

/**
 * Returns all PROCESSED documents linked to a given transaction ID.
 * Used by the API to show source documents on the Journal page.
 */
export async function getDocumentsByTransactionId(
  transactionId: string,
): Promise<InboxDocument[]> {
  return db('inbox_documents')
    .where('assigned_transaction_id', transactionId)
    .where('status', 'PROCESSED')
    .orderBy('completed_at', 'desc');
}

/**
 * Returns all documents linked to a given staging entry ID.
 * Used by the API to show source documents on the Approval Queue page.
 */
export async function getDocumentsByStagingId(
  stagingId: string,
): Promise<InboxDocument[]> {
  return db('inbox_documents')
    .where('assigned_staging_id', stagingId)
    .orderBy('completed_at', 'desc');
}

/**
 * Returns a single document by its ID (any status).
 */
export async function getDocumentById(
  documentId: string,
): Promise<InboxDocument | undefined> {
  return db('inbox_documents').where('id', documentId).first();
}
