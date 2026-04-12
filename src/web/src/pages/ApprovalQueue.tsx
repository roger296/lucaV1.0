import { useState, useEffect, useCallback } from 'react';
import { useStaging } from '../hooks/useStaging';
import { apiPost } from '../hooks/useApi';
import { TxTypeBadge, StagingStatusBadge } from '../components/StatusBadge';
import { DocumentViewer } from '../components/DocumentViewer';
import type { StagingEntry } from '../types';

function fmt(val: string | number | null | undefined): string {
  if (val == null) return '—';
  const n = parseFloat(String(val));
  return isNaN(n) ? String(val) : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Filter = 'PENDING' | 'ALL';

export function ApprovalQueue() {
  const [filter, setFilter] = useState<Filter>('PENDING');
  const { data: items, loading, error, refetch } = useStaging(filter);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectFor, setShowRejectFor] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const pending = items?.filter((i) => i.status === 'PENDING') ?? [];

  // Keyboard navigation
  const handleApprove = useCallback(
    async (entry: StagingEntry) => {
      setBusy(entry.staging_id);
      setActionMsg(null);
      try {
        await apiPost(`/api/staging/${entry.staging_id}/approve`, {});
        setActionMsg({ type: 'success', text: `${entry.staging_id} approved.` });
        refetch();
      } catch (e) {
        setActionMsg({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(null);
      }
    },
    [refetch],
  );

  const handleReject = useCallback(
    async (entry: StagingEntry, reason: string) => {
      setBusy(entry.staging_id);
      setActionMsg(null);
      try {
        await apiPost(`/api/staging/${entry.staging_id}/reject`, { reason });
        setShowRejectFor(null);
        setRejectReason('');
        setActionMsg({ type: 'success', text: `${entry.staging_id} rejected.` });
        refetch();
      } catch (e) {
        setActionMsg({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(null);
      }
    },
    [refetch],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, (pending.length || 1) - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'a' && pending[selectedIdx]) {
        e.preventDefault();
        void handleApprove(pending[selectedIdx]!);
      } else if (e.key === 'r' && pending[selectedIdx]) {
        e.preventDefault();
        setShowRejectFor(pending[selectedIdx]!.staging_id);
      } else if (e.key === 'Escape') {
        setShowRejectFor(null);
        setRejectReason('');
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, selectedIdx, handleApprove]);

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
          <div className="page-title">Approval Queue</div>
          <div className="page-subtitle">
            Review and approve transactions that exceeded auto-approval thresholds
          </div>
        </div>
        <div className="toolbar">
          <div className="kbd-hint">
            <span className="kbd">↑↓</span> navigate
            <span className="kbd">A</span> approve
            <span className="kbd">R</span> reject
            <span className="kbd">Esc</span> cancel
          </div>
          <button className="btn btn-ghost btn-sm" onClick={refetch}>↺</button>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {(['PENDING', 'ALL'] as Filter[]).map((f) => (
          <button
            key={f}
            className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setFilter(f)}
          >
            {f === 'PENDING' ? `Pending (${pending.length})` : 'All'}
          </button>
        ))}
      </div>

      {actionMsg && (
        <div className={`alert alert-${actionMsg.type} mb-16`}>{actionMsg.text}</div>
      )}
      {error && <div className="alert alert-error mb-16">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="loading">Loading queue…</div>
        ) : !items || items.length === 0 ? (
          <div className="empty">
            {filter === 'PENDING' ? '✓ No pending items — queue is clear' : 'No items found'}
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 24 }}></th>
                  <th>Staging ID</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Reference</th>
                  <th>Description</th>
                  <th>Period</th>
                  <th>Submitted By</th>
                  <th className="num">Amount £</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => {
                  const isSelected = filter === 'PENDING' && idx === selectedIdx;
                  const isExpanded = expanded.has(item.staging_id);
                  const isBusy = busy === item.staging_id;

                  return [
                    <tr
                      key={item.staging_id}
                      style={{
                        background: isSelected ? 'rgba(13, 110, 253, 0.06)' : undefined,
                        outline: isSelected ? '2px solid rgba(13, 110, 253, 0.3)' : undefined,
                        outlineOffset: -2,
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        if (filter === 'PENDING') setSelectedIdx(idx);
                        toggleExpand(item.staging_id);
                      }}
                    >
                      <td style={{ color: '#6c757d', fontSize: 10, textAlign: 'center' }}>
                        {isExpanded ? '▼' : '▶'}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>{item.staging_id}</td>
                      <td>{item.date}</td>
                      <td><TxTypeBadge type={item.transaction_type} /></td>
                      <td className="text-muted">{item.reference ?? '—'}</td>
                      <td
                        style={{
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.description ?? '—'}
                      </td>
                      <td className="mono">{item.period_id}</td>
                      <td className="text-muted">{item.submitted_by ?? '—'}</td>
                      <td className="num">
                        <span className="mono">£{fmt(item.total_amount)}</span>
                      </td>
                      <td><StagingStatusBadge status={item.status} /></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {item.status === 'PENDING' ? (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="btn btn-sm btn-success"
                              disabled={isBusy}
                              onClick={() => void handleApprove(item)}
                              title="Approve (A)"
                            >
                              ✓
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={isBusy}
                              onClick={() => setShowRejectFor(item.staging_id)}
                              title="Reject (R)"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <span className="text-muted" style={{ fontSize: 12 }}>
                            {item.reviewed_by ?? '—'}
                          </span>
                        )}
                      </td>
                    </tr>,

                    // Expanded payload view
                    isExpanded && (
                      <tr key={`exp-${item.staging_id}`} className="expanded-row">
                        <td colSpan={11}>
                          <div className="expand-panel">
                            <PayloadLines payload={item.payload} />
                            <DocumentViewer documents={item.documents} />
                          </div>
                        </td>
                      </tr>
                    ),

                    // Reject reason form
                    showRejectFor === item.staging_id && (
                      <tr key={`rej-${item.staging_id}`} className="expanded-row">
                        <td colSpan={11}>
                          <div className="expand-panel">
                            <div
                              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                            >
                              <input
                                className="form-control"
                                style={{ flex: 1, minWidth: 200 }}
                                placeholder="Rejection reason (optional)"
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void handleReject(item, rejectReason);
                                  if (e.key === 'Escape') { setShowRejectFor(null); setRejectReason(''); }
                                }}
                                autoFocus
                              />
                              <button
                                className="btn btn-sm btn-danger"
                                disabled={isBusy}
                                onClick={() => void handleReject(item, rejectReason)}
                              >
                                Confirm Reject
                              </button>
                              <button
                                className="btn btn-sm btn-ghost"
                                onClick={() => { setShowRejectFor(null); setRejectReason(''); }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PayloadLines({ payload }: { payload: string }) {
  let parsed: { lines?: Array<{ account_code: string; description: string; debit: number; credit: number; cost_centre?: string }> } | null = null;
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return <pre style={{ fontSize: 12, fontFamily: 'monospace' }}>{payload}</pre>;
  }

  if (!parsed?.lines?.length) {
    return <pre style={{ fontSize: 12 }}>{JSON.stringify(parsed, null, 2)}</pre>;
  }

  return (
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
        {parsed.lines.map((line, i) => (
          <tr key={i}>
            <td className="mono">{line.account_code}</td>
            <td>{line.description ?? '—'}</td>
            <td className="text-muted">{line.cost_centre ?? '—'}</td>
            <td className="num debit">{line.debit > 0 ? line.debit.toLocaleString('en-GB', { minimumFractionDigits: 2 }) : ''}</td>
            <td className="num credit">{line.credit > 0 ? line.credit.toLocaleString('en-GB', { minimumFractionDigits: 2 }) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
