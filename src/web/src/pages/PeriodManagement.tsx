import { useState } from 'react';
import { usePeriods, usePeriod } from '../hooks/usePeriods';
import { apiPost } from '../hooks/useApi';
import { PeriodStatusBadge, DataFlagBadge } from '../components/StatusBadge';
import type { Period } from '../types';

function CheckItem({ pass, label }: { pass: boolean | null; label: string }) {
  return (
    <li className="checklist-item">
      <span className={`check-icon ${pass === null ? 'unknown' : pass ? 'pass' : 'fail'}`}>
        {pass === null ? '?' : pass ? '✓' : '✕'}
      </span>
      <span style={{ color: pass === false ? '#dc3545' : pass === true ? '#198754' : undefined }}>
        {label}
      </span>
    </li>
  );
}

function PeriodDetail({ periodId, onAction }: { periodId: string; onAction: () => void }) {
  const { data: detail, loading, error, refetch } = usePeriod(periodId);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  async function doSoftClose() {
    setBusy(true);
    setActionError('');
    try {
      await apiPost(`/api/periods/${periodId}/soft-close`, {});
      refetch();
      onAction();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doHardClose() {
    setBusy(true);
    setActionError('');
    try {
      await apiPost(`/api/periods/${periodId}/hard-close`, {});
      refetch();
      onAction();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="loading" style={{ padding: 20 }}>Loading…</div>;
  if (error) return <div className="alert alert-error" style={{ margin: 16 }}>{error}</div>;
  if (!detail) return null;

  const totalDr = parseFloat(detail.total_debits);
  const totalCr = parseFloat(detail.total_credits);
  const balanced = Math.abs(totalDr - totalCr) < 0.005;

  const softCloseReady = detail.status === 'OPEN';
  const hardCloseReady =
    detail.status === 'SOFT_CLOSE' &&
    detail.pending_staging_count === 0 &&
    balanced;

  return (
    <div style={{ padding: 20 }}>
      {/* Period details */}
      <div className="grid grid-2" style={{ gap: 20, marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 12, color: '#6c757d', marginBottom: 8, fontWeight: 600 }}>
            Period Details
          </div>
          <table style={{ fontSize: 13 }}>
            <tbody>
              {[
                ['Period ID', <span className="mono">{detail.period_id}</span>],
                ['Start Date', detail.start_date],
                ['End Date', detail.end_date],
                ['Status', <PeriodStatusBadge status={detail.status} />],
                ['Data Flag', <DataFlagBadge flag={detail.data_flag} />],
                ['Opened At', detail.opened_at ? new Date(detail.opened_at).toLocaleString() : '—'],
                ['Soft Closed', detail.soft_closed_at ? new Date(detail.soft_closed_at).toLocaleString() : '—'],
                ['Hard Closed', detail.hard_closed_at ? new Date(detail.hard_closed_at).toLocaleString() : '—'],
                ['Closed By', detail.closed_by ?? '—'],
              ].map(([label, value], i) => (
                <tr key={i}>
                  <td style={{ color: '#6c757d', paddingBottom: 4, paddingRight: 16, whiteSpace: 'nowrap' }}>
                    {label}
                  </td>
                  <td style={{ paddingBottom: 4 }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <div style={{ fontSize: 12, color: '#6c757d', marginBottom: 8, fontWeight: 600 }}>
            Closing Checklist
          </div>
          <ul className="checklist" style={{ marginBottom: 16 }}>
            <CheckItem
              pass={detail.status === 'SOFT_CLOSE' || detail.status === 'HARD_CLOSE'}
              label="Period has been soft-closed"
            />
            <CheckItem
              pass={detail.pending_staging_count === 0}
              label={
                detail.pending_staging_count === 0
                  ? 'Staging area is clear (0 pending)'
                  : `Staging area has ${detail.pending_staging_count} pending item(s)`
              }
            />
            <CheckItem
              pass={balanced}
              label={
                balanced
                  ? `Trial balance is balanced (£${parseFloat(detail.total_debits).toLocaleString('en-GB', { minimumFractionDigits: 2 })})`
                  : `Trial balance is OUT OF BALANCE — Debits: £${totalDr.toFixed(2)}, Credits: £${totalCr.toFixed(2)}`
              }
            />
            <CheckItem
              pass={detail.status === 'HARD_CLOSE' ? true : null}
              label="Previous periods are all hard-closed"
            />
          </ul>

          {actionError && (
            <div className="alert alert-error mb-8" style={{ fontSize: 13 }}>
              {actionError}
            </div>
          )}

          {detail.status === 'OPEN' && (
            <button
              className="btn btn-warning"
              onClick={() => void doSoftClose()}
              disabled={busy || !softCloseReady}
            >
              {busy ? 'Processing…' : 'Soft Close Period'}
            </button>
          )}

          {detail.status === 'SOFT_CLOSE' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-danger"
                onClick={() => void doHardClose()}
                disabled={busy || !hardCloseReady}
                title={hardCloseReady ? '' : 'Resolve checklist issues first'}
              >
                {busy ? 'Processing…' : 'Hard Close Period'}
              </button>
              {!hardCloseReady && (
                <span style={{ fontSize: 12, color: '#6c757d', alignSelf: 'center' }}>
                  Resolve checklist issues first
                </span>
              )}
            </div>
          )}

          {detail.status === 'HARD_CLOSE' && (
            <div className="alert alert-success" style={{ fontSize: 13 }}>
              ✓ Period is hard-closed and immutable
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PeriodManagement() {
  const { data: periods, loading, error, refetch } = usePeriods();
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Set<string>>(new Set());
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [newPeriodId, setNewPeriodId] = useState('');
  const [openModalBusy, setOpenModalBusy] = useState(false);
  const [openModalError, setOpenModalError] = useState('');

  function toggleDetail(id: string) {
    setExpandedDetail((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectedPeriod(id);
  }

  function getDefaultNewPeriodId(): string {
    if (!periods || periods.length === 0) {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    // Find the latest period_id and suggest the next month
    const latest = [...periods].sort((a: Period, b: Period) => b.period_id.localeCompare(a.period_id))[0] as Period;
    const [yearStr, monthStr] = latest.period_id.split('-') as [string, string];
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (month === 12) return `${year + 1}-01`;
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  }

  function openModal() {
    setNewPeriodId(getDefaultNewPeriodId());
    setOpenModalError('');
    setShowOpenModal(true);
  }

  async function doOpenPeriod() {
    setOpenModalBusy(true);
    setOpenModalError('');
    try {
      await apiPost('/api/periods', { period_id: newPeriodId });
      setShowOpenModal(false);
      refetch();
    } catch (e) {
      setOpenModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpenModalBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Period Management</div>
          <div className="page-subtitle">
            Open, soft-close, and hard-close accounting periods
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={openModal}>+ Open Period</button>
          <button className="btn btn-ghost btn-sm" onClick={refetch}>↺ Refresh</button>
        </div>
      </div>

      {showOpenModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowOpenModal(false); }}
        >
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, minWidth: 320, boxShadow: '0 4px 24px rgba(0,0,0,0.18)' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Open Accounting Period</div>
            <label style={{ display: 'block', fontSize: 13, color: '#6c757d', marginBottom: 4 }}>
              Period (YYYY-MM)
            </label>
            <input
              type="text"
              className="form-control"
              value={newPeriodId}
              onChange={(e) => setNewPeriodId(e.target.value)}
              placeholder="e.g. 2026-04"
              style={{ width: '100%', marginBottom: 16, padding: '8px 10px', border: '1px solid #ced4da', borderRadius: 4, fontSize: 14 }}
              disabled={openModalBusy}
            />
            {openModalError && (
              <div className="alert alert-error" style={{ fontSize: 13, marginBottom: 12 }}>
                {openModalError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowOpenModal(false)}
                disabled={openModalBusy}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void doOpenPeriod()}
                disabled={openModalBusy || !newPeriodId}
              >
                {openModalBusy ? 'Opening…' : 'Open Period'}
              </button>
            </div>
          </div>
        </div>
      )}


      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="loading">Loading periods…</div>
        ) : !periods?.length ? (
          <div className="empty">No periods found</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 24 }}></th>
                  <th>Period</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Status</th>
                  <th>Data Flag</th>
                  <th>Opened</th>
                  <th>Closed By</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period: Period) => {
                  const isExpanded = expandedDetail.has(period.period_id);
                  return [
                    <tr
                      key={period.period_id}
                      style={{ cursor: 'pointer', fontWeight: period.status === 'OPEN' ? 600 : undefined }}
                      onClick={() => toggleDetail(period.period_id)}
                    >
                      <td style={{ color: '#6c757d', fontSize: 10, textAlign: 'center' }}>
                        {isExpanded ? '▼' : '▶'}
                      </td>
                      <td className="mono">{period.period_id}</td>
                      <td>{period.start_date}</td>
                      <td>{period.end_date}</td>
                      <td><PeriodStatusBadge status={period.status} /></td>
                      <td><DataFlagBadge flag={period.data_flag} /></td>
                      <td style={{ fontSize: 12, color: '#6c757d' }}>
                        {period.opened_at ? new Date(period.opened_at).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: '#6c757d' }}>
                        {period.closed_by ?? '—'}
                      </td>
                    </tr>,

                    isExpanded && (
                      <tr key={`detail-${period.period_id}`} className="expanded-row">
                        <td colSpan={8} style={{ padding: 0 }}>
                          <PeriodDetail
                            periodId={period.period_id}
                            onAction={refetch}
                          />
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

      <div className="alert alert-info mt-16" style={{ fontSize: 13 }}>
        <strong>Period lifecycle:</strong> OPEN → Soft Close → Hard Close (one-way, irreversible).
        Hard-closing seals the chain file and marks all transactions as Authoritative.
        Prior period adjustments must be posted to the current open period.
      </div>
    </div>
  );
}
