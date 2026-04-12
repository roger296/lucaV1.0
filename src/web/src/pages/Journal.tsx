import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { usePeriods } from '../hooks/usePeriods';
import { TxTypeBadge, DataFlagBadge } from '../components/StatusBadge';
import { DocumentViewer } from '../components/DocumentViewer';
import type { Transaction, TransactionLine } from '../types';

const TX_TYPES = [
  'MANUAL_JOURNAL',
  'CUSTOMER_INVOICE',
  'SUPPLIER_INVOICE',
  'CUSTOMER_PAYMENT',
  'SUPPLIER_PAYMENT',
  'PRIOR_PERIOD_ADJUSTMENT',
];

function fmt(val: string | number | null | undefined): string {
  if (val == null || val === '0' || val === '0.00') return '';
  const n = parseFloat(String(val));
  return isNaN(n) ? String(val) : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ExpandedLines({ txId }: { txId: string }) {
  const { data: tx, loading, error } = useApi<Transaction>(`/api/transactions/${txId}`);

  if (loading) return (
    <tr className="expanded-row">
      <td colSpan={8}><div className="loading" style={{ padding: 16 }}>Loading lines…</div></td>
    </tr>
  );
  if (error) return (
    <tr className="expanded-row">
      <td colSpan={8}><div className="alert alert-error" style={{ margin: 12 }}>{error}</div></td>
    </tr>
  );
  if (!tx?.lines?.length) return null;

  return (
    <tr className="expanded-row">
      <td colSpan={8}>
        <div className="expand-panel">
          <table style={{ fontSize: 12.5 }}>
            <thead>
              <tr>
                <th>Account</th>
                <th>Description</th>
                <th>Cost Centre</th>
                <th className="num">Debit £</th>
                <th className="num">Credit £</th>
              </tr>
            </thead>
            <tbody>
              {tx.lines.map((line: TransactionLine, i: number) => (
                <tr key={i}>
                  <td className="mono">{line.account_code}</td>
                  <td>{line.description ?? '—'}</td>
                  <td className="text-muted">{line.cost_centre ?? '—'}</td>
                  <td className="num debit">{fmt(line.debit)}</td>
                  <td className="num credit">{fmt(line.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <DocumentViewer documents={tx.documents} />
        </div>
      </td>
    </tr>
  );
}

export function Journal() {
  const { data: periods } = usePeriods();
  const [periodId, setPeriodId] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (periodId) params.set('period_id', periodId);
  if (type) params.set('type', type);
  if (search) params.set('search', search);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const { data: transactions, loading, error, refetch } = useApi<Transaction[]>(
    `/api/transactions?${params.toString()}`,
  );

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Journal</div>
          <div className="page-subtitle">All committed transactions</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={refetch}>↺ Refresh</button>
      </div>

      {/* Filters */}
      <div className="card mb-16">
        <div className="card-body" style={{ paddingTop: 12, paddingBottom: 12 }}>
          <div className="form-row">
            <select
              className="form-control"
              value={periodId}
              onChange={(e) => { setPeriodId(e.target.value); setOffset(0); }}
            >
              <option value="">All periods</option>
              {periods?.map((p) => (
                <option key={p.period_id} value={p.period_id}>{p.period_id}</option>
              ))}
            </select>

            <select
              className="form-control"
              value={type}
              onChange={(e) => { setType(e.target.value); setOffset(0); }}
            >
              <option value="">All types</option>
              {TX_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>

            <input
              className="form-control"
              style={{ flex: 1, minWidth: 180 }}
              type="text"
              placeholder="Search reference, description, ID…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { setSearch(searchInput); setOffset(0); }
              }}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setSearch(searchInput); setOffset(0); }}
            >
              Search
            </button>
            {(periodId || type || search) && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setPeriodId(''); setType(''); setSearch(''); setSearchInput(''); setOffset(0);
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <div className="table-wrapper">
          {loading ? (
            <div className="loading">Loading transactions…</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 24 }}></th>
                  <th>Transaction ID</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Reference</th>
                  <th>Description</th>
                  <th>Period</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {!transactions || transactions.length === 0 ? (
                  <tr><td colSpan={8} className="empty">No transactions found</td></tr>
                ) : (
                  transactions.flatMap((tx) => {
                    const isExpanded = expanded.has(tx.transaction_id);
                    return [
                      <tr
                        key={tx.transaction_id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => toggleExpand(tx.transaction_id)}
                      >
                        <td style={{ color: '#6c757d', fontSize: 10, textAlign: 'center' }}>
                          {isExpanded ? '▼' : '▶'}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{tx.transaction_id}</td>
                        <td>{tx.date}</td>
                        <td><TxTypeBadge type={tx.transaction_type} /></td>
                        <td className="text-muted">{tx.reference ?? '—'}</td>
                        <td
                          style={{
                            maxWidth: 250,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {tx.description ?? '—'}
                        </td>
                        <td className="mono">{tx.period_id}</td>
                        <td><DataFlagBadge flag={tx.data_flag} /></td>
                      </tr>,
                      isExpanded ? <ExpandedLines key={`exp-${tx.transaction_id}`} txId={tx.transaction_id} /> : null,
                    ];
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        <div
          className="card-body"
          style={{
            paddingTop: 10,
            paddingBottom: 10,
            borderTop: '1px solid #e9ecef',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <button
            className="btn btn-ghost btn-sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            ← Prev
          </button>
          <span className="text-muted" style={{ fontSize: 13 }}>
            Showing {offset + 1}–{offset + (transactions?.length ?? 0)}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!transactions || transactions.length < limit}
            onClick={() => setOffset(offset + limit)}
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
