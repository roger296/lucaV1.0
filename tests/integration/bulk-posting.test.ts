/**
 * Integration tests for gl_bulk_post_transactions and POST /api/transactions/bulk (Phase 2, Prompt 4).
 */
import request from 'supertest';
import { db } from '../../src/db/connection';
import { app } from '../../src/server';
import { handleBulkPostTransactions } from '../../src/mcp/tools';

const API_KEY = 'dev';
const AUTH = { 'X-API-Key': API_KEY };
const TEST_PERIOD = '2076-03';
const CHAIN_DIR = 'chains/default';

async function cleanupPeriod(pid: string): Promise<void> {
  await db('transaction_lines').whereIn('transaction_id', db('transactions').where('period_id', pid).select('transaction_id')).del();
  await db('transactions').where('period_id', pid).del();
  await db('staging').where('period_id', pid).del();
  await db('periods').where('period_id', pid).del();
}

beforeAll(async () => {
  await cleanupPeriod(TEST_PERIOD);

  await db('periods').insert({
    period_id: TEST_PERIOD,
    start_date: '2076-03-01',
    end_date: '2076-03-31',
    status: 'OPEN',
    data_flag: 'PROVISIONAL',
    opened_at: new Date().toISOString(),
  });

  const { ChainWriter } = await import('../../src/chain/writer');
  const writer = new ChainWriter({
    chainDir: CHAIN_DIR,
    getPeriodStatus: async (pid: string) => {
      const row = await db('periods').where('period_id', pid).select('status').first<{ status: string }>();
      return (row?.status as 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | null) ?? null;
    },
  });
  await writer.createPeriodFile(TEST_PERIOD, null, {});
});

afterAll(async () => {
  await cleanupPeriod(TEST_PERIOD);
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const fp = path.join(CHAIN_DIR, `${TEST_PERIOD}.chain.jsonl`);
  try { await fs.chmod(fp, 0o644); } catch { /**/ }
  try { await fs.unlink(fp); } catch { /**/ }
});

describe('gl_bulk_post_transactions MCP tool', () => {
  it('posts 3 transactions and returns summary', async () => {
    const result = await handleBulkPostTransactions({
      transactions: [
        { transaction_type: 'CUSTOMER_INVOICE', date: '2076-03-05', period_id: TEST_PERIOD, amount: 1200 },
        { transaction_type: 'SUPPLIER_INVOICE', date: '2076-03-06', period_id: TEST_PERIOD, amount: 600 },
        { transaction_type: 'CUSTOMER_PAYMENT', date: '2076-03-07', period_id: TEST_PERIOD, amount: 500 },
      ],
      stop_on_error: false,
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text) as { total: number; errors: number; results: unknown[] };
    expect(data.total).toBe(3);
    expect(data.errors).toBe(0);
    expect(data.results).toHaveLength(3);
  });

  it('continues after error when stop_on_error is false', async () => {
    const result = await handleBulkPostTransactions({
      transactions: [
        { transaction_type: 'CUSTOMER_PAYMENT', date: '2076-03-08', period_id: TEST_PERIOD, amount: 100 }, // valid
        { transaction_type: 'MANUAL_JOURNAL', date: 'not-a-date', period_id: TEST_PERIOD, lines: [
          { account_code: '1000', description: 'x', debit: 100, credit: 0 },
          { account_code: '3000', description: 'y', debit: 0, credit: 100 },
        ]}, // invalid date
        { transaction_type: 'CUSTOMER_PAYMENT', date: '2076-03-09', period_id: TEST_PERIOD, amount: 200 }, // valid
      ],
      stop_on_error: false,
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text) as { total: number; errors: number; results: Array<{ status: string }> };
    expect(data.total).toBe(3);
    expect(data.errors).toBe(1);
    // First and last should succeed, middle should error
    expect(data.results[1]).toHaveProperty('status', 'ERROR');
  });

  it('should handle transactions passed as JSON strings', async () => {
    const stringifiedTxns = [
      JSON.stringify({
        transaction_type: 'CUSTOMER_INVOICE',
        date: '2076-03-20',
        period_id: TEST_PERIOD,
        reference: 'STRING-TEST-001',
        description: 'Test — string element',
        amount: 10.00,
      }),
    ];
    const result = await handleBulkPostTransactions({ transactions: stringifiedTxns });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text) as { total: number; errors: number; results: Array<{ status: string }> };
    expect(data.total).toBe(1);
    expect(data.errors).toBe(0);
    expect(data.results[0]).toHaveProperty('status', 'COMMITTED');
  });

  it('stops at first error when stop_on_error is true', async () => {
    const result = await handleBulkPostTransactions({
      transactions: [
        { transaction_type: 'CUSTOMER_PAYMENT', date: '2076-03-10', period_id: TEST_PERIOD, amount: 50 }, // valid
        { transaction_type: 'MANUAL_JOURNAL', date: 'BAD', period_id: TEST_PERIOD, lines: [] }, // invalid
        { transaction_type: 'CUSTOMER_PAYMENT', date: '2076-03-11', period_id: TEST_PERIOD, amount: 75 }, // never reached
      ],
      stop_on_error: true,
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text) as { results: unknown[] };
    // Should have at most 2 results (index 0 success + index 1 error), index 2 never attempted
    expect(data.results.length).toBeLessThanOrEqual(2);
  });
});

describe('POST /api/transactions/bulk REST endpoint', () => {
  it('bulk posts 3 transactions via REST', async () => {
    const res = await request(app)
      .post('/api/transactions/bulk')
      .set(AUTH)
      .send({
        transactions: [
          { transaction_type: 'CUSTOMER_INVOICE', date: '2076-03-12', period_id: TEST_PERIOD, amount: 800 },
          { transaction_type: 'SUPPLIER_PAYMENT', date: '2076-03-13', period_id: TEST_PERIOD, amount: 300 },
          { transaction_type: 'CUSTOMER_PAYMENT', date: '2076-03-14', period_id: TEST_PERIOD, amount: 450 },
        ],
        stop_on_error: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.errors).toBe(0);
  });

  it('returns 400 for empty transactions array', async () => {
    const res = await request(app)
      .post('/api/transactions/bulk')
      .set(AUTH)
      .send({ transactions: [] });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/transactions/bulk')
      .send({ transactions: [{ transaction_type: 'CUSTOMER_PAYMENT', date: '2076-03-15', period_id: TEST_PERIOD, amount: 100 }] });
    expect(res.status).toBe(401);
  });
});
