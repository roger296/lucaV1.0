import Decimal from 'decimal.js';
import { db } from '../db/connection';

// ---------------------------------------------------------------------------
// reports.ts — report calculation functions shared by REST API and MCP tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profit and Loss
// ---------------------------------------------------------------------------

export interface PnlAccount {
  code: string;
  name: string;
  category: string | null;
  balance: string;
}

export interface PnlSection {
  accounts: PnlAccount[];
  total: string;
}

export interface ProfitAndLossResult {
  period_id: string;
  from_date: string | null;
  to_date: string | null;
  sections: {
    revenue: PnlSection;
    direct_costs: PnlSection;
    overheads: PnlSection;
    finance_costs: PnlSection;
  };
  total_revenue: string;
  total_direct_costs: string;
  gross_profit: string;
  total_overheads: string;
  total_finance_costs: string;
  total_expenses: string;
  net_profit: string;
}

export async function getProfitAndLoss(opts: {
  period_id: string;
  from_date?: string;
  to_date?: string;
}): Promise<ProfitAndLossResult> {
  // When a date range is provided, the transactions.date filters below
  // select across periods — so we must NOT also restrict to a single
  // transaction_lines.period_id, which would neutralise the date range.
  // When no date range is given, fall back to the single-period filter
  // so callers still get "just this period" behaviour by default.
  let q = db('transaction_lines')
    .join('accounts', 'transaction_lines.account_code', 'accounts.code')
    .join('transactions', 'transaction_lines.transaction_id', 'transactions.transaction_id')
    .whereIn('accounts.type', ['REVENUE', 'EXPENSE'])
    .modify((qb) => {
      if (!opts.from_date && !opts.to_date) {
        qb.where('transaction_lines.period_id', opts.period_id);
      }
    })
    .select(
      'accounts.code',
      'accounts.name',
      'accounts.type',
      'accounts.category',
      db.raw('COALESCE(SUM(transaction_lines.debit), 0) as total_debits'),
      db.raw('COALESCE(SUM(transaction_lines.credit), 0) as total_credits'),
    )
    .groupBy('accounts.code', 'accounts.name', 'accounts.type', 'accounts.category')
    .orderBy('accounts.code');

  if (opts.from_date) {
    q = q.where('transactions.date', '>=', opts.from_date);
  }
  if (opts.to_date) {
    q = q.where('transactions.date', '<=', opts.to_date);
  }

  const rows = await q as Array<{
    code: string;
    name: string;
    type: string;
    category: string | null;
    total_debits: string;
    total_credits: string;
  }>;

  const revenue: PnlAccount[] = [];
  const direct_costs: PnlAccount[] = [];
  const overheads: PnlAccount[] = [];
  const finance_costs: PnlAccount[] = [];

  for (const row of rows) {
    const d = new Decimal(row.total_debits);
    const c = new Decimal(row.total_credits);

    let balance: Decimal;
    if (row.type === 'REVENUE') {
      // Natural credit balance — credits minus debits = positive income
      balance = c.minus(d);
    } else {
      // EXPENSE — natural debit balance — debits minus credits = positive expense
      balance = d.minus(c);
    }

    const account: PnlAccount = { code: row.code, name: row.name, category: row.category, balance: balance.toFixed(2) };

    if (row.type === 'REVENUE') {
      revenue.push(account);
    } else if (row.category === 'DIRECT_COSTS') {
      direct_costs.push(account);
    } else if (row.category === 'FINANCE_COSTS') {
      finance_costs.push(account);
    } else {
      overheads.push(account);
    }
  }

  const sumSection = (accounts: PnlAccount[]) =>
    accounts.reduce((s, a) => s.plus(a.balance), new Decimal(0));

  const totalRevenue = sumSection(revenue);
  const totalDirectCosts = sumSection(direct_costs);
  const totalOverheads = sumSection(overheads);
  const totalFinanceCosts = sumSection(finance_costs);
  const totalExpenses = totalDirectCosts.plus(totalOverheads).plus(totalFinanceCosts);
  const grossProfit = totalRevenue.minus(totalDirectCosts);
  const netProfit = totalRevenue.minus(totalExpenses);

  return {
    period_id: opts.period_id,
    from_date: opts.from_date ?? null,
    to_date: opts.to_date ?? null,
    sections: {
      revenue: { accounts: revenue, total: totalRevenue.toFixed(2) },
      direct_costs: { accounts: direct_costs, total: totalDirectCosts.toFixed(2) },
      overheads: { accounts: overheads, total: totalOverheads.toFixed(2) },
      finance_costs: { accounts: finance_costs, total: totalFinanceCosts.toFixed(2) },
    },
    total_revenue: totalRevenue.toFixed(2),
    total_direct_costs: totalDirectCosts.toFixed(2),
    gross_profit: grossProfit.toFixed(2),
    total_overheads: totalOverheads.toFixed(2),
    total_finance_costs: totalFinanceCosts.toFixed(2),
    total_expenses: totalExpenses.toFixed(2),
    net_profit: netProfit.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Balance Sheet
// ---------------------------------------------------------------------------

export interface BalanceSheetAccount {
  code: string;
  name: string;
  category: string | null;
  balance: string;
}

export interface BalanceSheetSection {
  accounts: BalanceSheetAccount[];
  total: string;
}

export interface BalanceSheetResult {
  as_at: string;
  sections: {
    current_assets: BalanceSheetSection;
    fixed_assets: BalanceSheetSection;
    current_liabilities: BalanceSheetSection;
    equity: BalanceSheetSection;
  };
  total_assets: string;
  total_liabilities: string;
  total_equity: string;
  balanced: boolean;
}

export async function getBalanceSheet(opts: {
  period_id?: string;
  as_at_date?: string;
}): Promise<BalanceSheetResult> {
  let q = db('transaction_lines')
    .join('accounts', 'transaction_lines.account_code', 'accounts.code')
    .whereIn('accounts.type', ['ASSET', 'LIABILITY', 'EQUITY'])
    .select(
      'accounts.code',
      'accounts.name',
      'accounts.type',
      'accounts.category',
      db.raw('COALESCE(SUM(transaction_lines.debit), 0) as total_debits'),
      db.raw('COALESCE(SUM(transaction_lines.credit), 0) as total_credits'),
    )
    .groupBy('accounts.code', 'accounts.name', 'accounts.type', 'accounts.category')
    .orderBy('accounts.code');

  if (opts.as_at_date) {
    q = q
      .join('transactions', 'transaction_lines.transaction_id', 'transactions.transaction_id')
      .where('transactions.date', '<=', opts.as_at_date);
  } else if (opts.period_id) {
    // Cumulative: all periods up to and including the requested one
    q = q.where('transaction_lines.period_id', '<=', opts.period_id);
  }

  const rows = await q as Array<{
    code: string;
    name: string;
    type: string;
    category: string | null;
    total_debits: string;
    total_credits: string;
  }>;

  const current_assets: BalanceSheetAccount[] = [];
  const fixed_assets: BalanceSheetAccount[] = [];
  const current_liabilities: BalanceSheetAccount[] = [];
  const equity: BalanceSheetAccount[] = [];

  for (const row of rows) {
    const d = new Decimal(row.total_debits);
    const c = new Decimal(row.total_credits);

    let balance: Decimal;
    if (row.type === 'ASSET') {
      // Natural debit balance
      balance = d.minus(c);
    } else {
      // LIABILITY / EQUITY — natural credit balance
      balance = c.minus(d);
    }

    const account: BalanceSheetAccount = {
      code: row.code,
      name: row.name,
      category: row.category,
      balance: balance.toFixed(2),
    };

    if (row.type === 'ASSET' && row.category === 'FIXED_ASSET') {
      fixed_assets.push(account);
    } else if (row.type === 'ASSET') {
      current_assets.push(account);
    } else if (row.type === 'LIABILITY') {
      current_liabilities.push(account);
    } else {
      equity.push(account);
    }
  }

  const sumSection = (accounts: BalanceSheetAccount[]) =>
    accounts.reduce((s, a) => s.plus(a.balance), new Decimal(0));

  const totalCurrentAssets = sumSection(current_assets);
  const totalFixedAssets = sumSection(fixed_assets);
  const totalAssets = totalCurrentAssets.plus(totalFixedAssets);
  const totalLiabilities = sumSection(current_liabilities);
  const totalEquity = sumSection(equity);

  return {
    as_at: opts.as_at_date ?? opts.period_id ?? '',
    sections: {
      current_assets: { accounts: current_assets, total: totalCurrentAssets.toFixed(2) },
      fixed_assets: { accounts: fixed_assets, total: totalFixedAssets.toFixed(2) },
      current_liabilities: { accounts: current_liabilities, total: totalLiabilities.toFixed(2) },
      equity: { accounts: equity, total: totalEquity.toFixed(2) },
    },
    total_assets: totalAssets.toFixed(2),
    total_liabilities: totalLiabilities.toFixed(2),
    total_equity: totalEquity.toFixed(2),
    balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
  };
}

// ---------------------------------------------------------------------------
// Aged debtors / creditors helpers
// ---------------------------------------------------------------------------

interface AgeingBuckets {
  current: Decimal;  // 0–30 days from report date
  days_30: Decimal;  // 31–60 days
  days_60: Decimal;  // 61–90 days
  days_90: Decimal;  // never used directly — see days_90_plus
  days_90_plus: Decimal;
}

function ageAmount(amount: Decimal, transactionDate: string, reportDate: string): AgeingBuckets {
  const txDate = new Date(transactionDate);
  const repDate = new Date(reportDate);
  const diffDays = Math.floor((repDate.getTime() - txDate.getTime()) / 86400000);

  const buckets: AgeingBuckets = {
    current: new Decimal(0),
    days_30: new Decimal(0),
    days_60: new Decimal(0),
    days_90: new Decimal(0),
    days_90_plus: new Decimal(0),
  };

  if (diffDays <= 30) {
    buckets.current = amount;
  } else if (diffDays <= 60) {
    buckets.days_30 = amount;
  } else if (diffDays <= 90) {
    buckets.days_60 = amount;
  } else {
    buckets.days_90_plus = amount;
  }

  return buckets;
}

function addBuckets(a: AgeingBuckets, b: AgeingBuckets): AgeingBuckets {
  return {
    current: a.current.plus(b.current),
    days_30: a.days_30.plus(b.days_30),
    days_60: a.days_60.plus(b.days_60),
    days_90: a.days_90.plus(b.days_90),
    days_90_plus: a.days_90_plus.plus(b.days_90_plus),
  };
}

function zeroBuckets(): AgeingBuckets {
  return { current: new Decimal(0), days_30: new Decimal(0), days_60: new Decimal(0), days_90: new Decimal(0), days_90_plus: new Decimal(0) };
}

async function buildAgedReport(opts: {
  accountCode: string;
  accountName: string;
  debitTypes: string[];    // transaction types that increase the balance
  creditTypes: string[];   // transaction types that decrease the balance
  balanceSide: 'DEBIT' | 'CREDIT'; // which side of the account represents the outstanding balance
  as_at_date: string;
}): Promise<{
  as_at_date: string;
  account_code: string;
  account_name: string;
  total_outstanding: string;
  ageing: { current: string; days_30: string; days_60: string; days_90: string; days_90_plus: string };
  counterparties: Array<{
    trading_account_id: string | null;
    contact_id: string | null;
    total: string;
    current: string;
    days_30: string;
    days_60: string;
    days_90: string;
    days_90_plus: string;
  }>;
}> {
  // Get all invoice-type transactions (creating the balance)
  const invoiceRows = await db('transactions')
    .join('transaction_lines', 'transactions.transaction_id', 'transaction_lines.transaction_id')
    .whereIn('transactions.transaction_type', opts.debitTypes)
    .where('transaction_lines.account_code', opts.accountCode)
    .where('transactions.date', '<=', opts.as_at_date)
    .select(
      'transactions.transaction_id',
      'transactions.date',
      'transactions.counterparty_trading_account_id',
      'transactions.counterparty_contact_id',
      db.raw('COALESCE(transaction_lines.debit, 0) as debit'),
      db.raw('COALESCE(transaction_lines.credit, 0) as credit'),
    );

  // Get all payment/credit-note transactions (reducing the balance)
  const paymentRows = await db('transactions')
    .join('transaction_lines', 'transactions.transaction_id', 'transaction_lines.transaction_id')
    .whereIn('transactions.transaction_type', opts.creditTypes)
    .where('transaction_lines.account_code', opts.accountCode)
    .where('transactions.date', '<=', opts.as_at_date)
    .select(
      'transactions.transaction_id',
      'transactions.date',
      'transactions.counterparty_trading_account_id',
      'transactions.counterparty_contact_id',
      db.raw('COALESCE(transaction_lines.debit, 0) as debit'),
      db.raw('COALESCE(transaction_lines.credit, 0) as credit'),
    );

  // Group by counterparty
  type CounterpartyKey = string;
  const counterpartyMap = new Map<CounterpartyKey, {
    trading_account_id: string | null;
    contact_id: string | null;
    totalDebit: Decimal;
    totalCredit: Decimal;
    buckets: AgeingBuckets;
    invoiceDates: Array<{ amount: Decimal; date: string }>;
  }>();

  const getKey = (row: { counterparty_trading_account_id: string | null; counterparty_contact_id: string | null }) =>
    `${row.counterparty_trading_account_id ?? ''}|${row.counterparty_contact_id ?? ''}`;

  for (const row of invoiceRows) {
    const key = getKey(row as { counterparty_trading_account_id: string | null; counterparty_contact_id: string | null });
    if (!counterpartyMap.has(key)) {
      counterpartyMap.set(key, {
        trading_account_id: (row as { counterparty_trading_account_id: string | null }).counterparty_trading_account_id,
        contact_id: (row as { counterparty_contact_id: string | null }).counterparty_contact_id,
        totalDebit: new Decimal(0),
        totalCredit: new Decimal(0),
        buckets: zeroBuckets(),
        invoiceDates: [],
      });
    }
    const entry = counterpartyMap.get(key)!;
    // For debtors (DEBIT side): invoices debit account 1100 — amount = debit
    // For creditors (CREDIT side): invoices credit account 2000 — amount = credit
    const d = new Decimal((row as { debit: string }).debit);
    const c = new Decimal((row as { credit: string }).credit);
    const amount = opts.balanceSide === 'DEBIT' ? d : c;
    if (amount.greaterThan(0)) {
      entry.totalDebit = entry.totalDebit.plus(amount);
      entry.invoiceDates.push({ amount, date: (row as { date: string }).date });
    }
  }

  for (const row of paymentRows) {
    const key = getKey(row as { counterparty_trading_account_id: string | null; counterparty_contact_id: string | null });
    if (!counterpartyMap.has(key)) {
      counterpartyMap.set(key, {
        trading_account_id: (row as { counterparty_trading_account_id: string | null }).counterparty_trading_account_id,
        contact_id: (row as { counterparty_contact_id: string | null }).counterparty_contact_id,
        totalDebit: new Decimal(0),
        totalCredit: new Decimal(0),
        buckets: zeroBuckets(),
        invoiceDates: [],
      });
    }
    const entry = counterpartyMap.get(key)!;
    // For debtors: payments credit account 1100 — credit reduces the debit balance
    // For creditors: payments debit account 2000 — debit reduces the credit balance
    const d = new Decimal((row as { debit: string }).debit);
    const c = new Decimal((row as { credit: string }).credit);
    const reduceAmount = opts.balanceSide === 'DEBIT' ? c : d;
    entry.totalCredit = entry.totalCredit.plus(reduceAmount);
  }

  // Build aged buckets per counterparty
  const counterparties: Array<{
    trading_account_id: string | null;
    contact_id: string | null;
    total: string;
    current: string;
    days_30: string;
    days_60: string;
    days_90: string;
    days_90_plus: string;
  }> = [];

  let grandTotal = new Decimal(0);
  let grandBuckets = zeroBuckets();

  for (const [, entry] of counterpartyMap) {
    const netBalance = entry.totalDebit.minus(entry.totalCredit);
    if (netBalance.lessThanOrEqualTo(0)) continue; // fully paid

    // Age by invoice dates (oldest first)
    let remaining = netBalance;
    let buckets = zeroBuckets();

    // Sort invoices oldest first
    const sorted = [...entry.invoiceDates].sort((a, b) => a.date.localeCompare(b.date));
    for (const inv of sorted) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const aged = Decimal.min(inv.amount, remaining);
      const b = ageAmount(aged, inv.date, opts.as_at_date);
      buckets = addBuckets(buckets, b);
      remaining = remaining.minus(aged);
    }
    // Any remaining (unmatched) goes to current
    if (remaining.greaterThan(0)) {
      buckets.current = buckets.current.plus(remaining);
    }

    grandTotal = grandTotal.plus(netBalance);
    grandBuckets = addBuckets(grandBuckets, buckets);

    counterparties.push({
      trading_account_id: entry.trading_account_id,
      contact_id: entry.contact_id,
      total: netBalance.toFixed(2),
      current: buckets.current.toFixed(2),
      days_30: buckets.days_30.toFixed(2),
      days_60: buckets.days_60.toFixed(2),
      days_90: buckets.days_90.toFixed(2),
      days_90_plus: buckets.days_90_plus.toFixed(2),
    });
  }

  return {
    as_at_date: opts.as_at_date,
    account_code: opts.accountCode,
    account_name: opts.accountName,
    total_outstanding: grandTotal.toFixed(2),
    ageing: {
      current: grandBuckets.current.toFixed(2),
      days_30: grandBuckets.days_30.toFixed(2),
      days_60: grandBuckets.days_60.toFixed(2),
      days_90: grandBuckets.days_90.toFixed(2),
      days_90_plus: grandBuckets.days_90_plus.toFixed(2),
    },
    counterparties,
  };
}

// ---------------------------------------------------------------------------
// Aged Debtors
// ---------------------------------------------------------------------------

export async function getAgedDebtors(opts: { as_at_date?: string }) {
  const reportDate = opts.as_at_date ?? new Date().toISOString().slice(0, 10);
  return buildAgedReport({
    accountCode: '1100',
    accountName: 'Trade Debtors',
    debitTypes: ['CUSTOMER_INVOICE'],
    creditTypes: ['CUSTOMER_PAYMENT', 'CUSTOMER_CREDIT_NOTE', 'BAD_DEBT_WRITE_OFF'],
    balanceSide: 'DEBIT',
    as_at_date: reportDate,
  });
}

// ---------------------------------------------------------------------------
// Aged Creditors
// ---------------------------------------------------------------------------

export async function getAgedCreditors(opts: { as_at_date?: string }) {
  const reportDate = opts.as_at_date ?? new Date().toISOString().slice(0, 10);
  return buildAgedReport({
    accountCode: '2000',
    accountName: 'Trade Creditors',
    debitTypes: ['SUPPLIER_INVOICE'],
    creditTypes: ['SUPPLIER_PAYMENT', 'SUPPLIER_CREDIT_NOTE'],
    balanceSide: 'CREDIT',
    as_at_date: reportDate,
  });
}

// ---------------------------------------------------------------------------
// Account Ledger
// ---------------------------------------------------------------------------

export interface AccountLedgerEntry {
  transaction_id: string;
  date: string;
  transaction_type: string;
  reference: string | null;
  description: string | null;
  line_description: string | null;
  debit: string;
  credit: string;
  running_balance: string;
}

export interface AccountLedgerResult {
  account_code: string;
  account_name: string;
  account_type: string;
  period_id?: string;
  date_from?: string;
  date_to?: string;
  entries: AccountLedgerEntry[];
  total_debits: string;
  total_credits: string;
  closing_balance: string;
}

export async function getAccountLedger(params: {
  account_code: string;
  period_id?: string;
  date_from?: string;
  date_to?: string;
}): Promise<AccountLedgerResult> {
  const { account_code, period_id, date_from, date_to } = params;

  // Verify account exists
  const account = await db('accounts').where('code', account_code).first<{ code: string; name: string; type: string }>();
  if (!account) {
    throw new Error(`Account '${account_code}' not found`);
  }

  // Build query
  let query = db('transaction_lines')
    .join('transactions', 'transaction_lines.transaction_id', 'transactions.transaction_id')
    .where('transaction_lines.account_code', account_code)
    .where('transactions.status', 'COMMITTED')
    .select(
      'transactions.transaction_id',
      'transactions.date',
      'transactions.transaction_type',
      'transactions.reference',
      'transactions.description',
      'transaction_lines.description as line_description',
      'transaction_lines.debit',
      'transaction_lines.credit',
    )
    .orderBy('transactions.date', 'asc')
    .orderBy('transactions.transaction_id', 'asc');

  if (period_id) query = query.where('transactions.period_id', period_id);
  if (date_from) query = query.where('transactions.date', '>=', date_from);
  if (date_to) query = query.where('transactions.date', '<=', date_to);

  const rows = await query;

  // Calculate running balance
  // ASSET + EXPENSE: debit increases, credit decreases
  // LIABILITY + EQUITY + REVENUE: credit increases, debit decreases
  const creditNormal = ['LIABILITY', 'EQUITY', 'REVENUE'].includes(account.type);

  let runningBalance = new Decimal(0);
  let totalDebits = new Decimal(0);
  let totalCredits = new Decimal(0);

  const entries: AccountLedgerEntry[] = rows.map((row: Record<string, unknown>) => {
    const debit = new Decimal(row['debit'] as string);
    const credit = new Decimal(row['credit'] as string);
    totalDebits = totalDebits.plus(debit);
    totalCredits = totalCredits.plus(credit);

    if (creditNormal) {
      runningBalance = runningBalance.plus(credit).minus(debit);
    } else {
      runningBalance = runningBalance.plus(debit).minus(credit);
    }

    return {
      transaction_id: row['transaction_id'] as string,
      date: row['date'] as string,
      transaction_type: row['transaction_type'] as string,
      reference: row['reference'] as string | null,
      description: row['description'] as string | null,
      line_description: row['line_description'] as string | null,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      running_balance: runningBalance.toFixed(2),
    };
  });

  return {
    account_code,
    account_name: account.name,
    account_type: account.type,
    period_id,
    date_from,
    date_to,
    entries,
    total_debits: totalDebits.toFixed(2),
    total_credits: totalCredits.toFixed(2),
    closing_balance: runningBalance.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Dashboard Summary
// ---------------------------------------------------------------------------

export async function getDashboardSummary(params: { period_id?: string }): Promise<Record<string, unknown>> {
  // Get current open period if not specified
  let periodId = params.period_id;
  if (!periodId) {
    const currentPeriod = await db('periods').where('status', 'OPEN').orderBy('period_id', 'desc').first<{ period_id: string }>();
    periodId = currentPeriod?.period_id ?? undefined;
  }

  const [pendingApprovals, recentTransactions, trialBalanceSummary, periodInfo] = await Promise.all([
    // Pending approvals count
    db('staging').where('status', 'PENDING').count<[{ count: string }]>('staging_id as count').first(),

    // Recent committed transactions (last 10)
    db('transactions')
      .where('status', 'COMMITTED')
      .modify((q) => { if (periodId) q.where('period_id', periodId); })
      .orderBy('date', 'desc')
      .orderBy('transaction_id', 'desc')
      .limit(10)
      .select('transaction_id', 'transaction_type', 'date', 'reference', 'description', 'currency'),

    // Trial balance totals for the period
    periodId
      ? db('transaction_lines')
          .join('transactions', 'transaction_lines.transaction_id', 'transactions.transaction_id')
          .where('transactions.period_id', periodId)
          .where('transactions.status', 'COMMITTED')
          .select(
            db.raw('COALESCE(SUM(transaction_lines.debit), 0) as total_debits'),
            db.raw('COALESCE(SUM(transaction_lines.credit), 0) as total_credits'),
          )
          .first<{ total_debits: string; total_credits: string }>()
      : Promise.resolve(null),

    // Period info
    periodId
      ? db('periods').where('period_id', periodId).first<{ period_id: string; status: string; data_flag: string }>()
      : Promise.resolve(null),
  ]);

  const totalDebits = new Decimal(trialBalanceSummary?.total_debits ?? '0');
  const totalCredits = new Decimal(trialBalanceSummary?.total_credits ?? '0');

  return {
    current_period: periodId ?? null,
    period_status: periodInfo?.status ?? null,
    pending_approvals: parseInt(pendingApprovals?.count ?? '0', 10),
    recent_transactions: recentTransactions,
    trial_balance_summary: {
      period_id: periodId ?? null,
      total_debits: totalDebits.toFixed(2),
      total_credits: totalCredits.toFixed(2),
      balanced: totalDebits.equals(totalCredits),
    },
  };
}

// ---------------------------------------------------------------------------
// VAT Return
// ---------------------------------------------------------------------------

export interface VatReturnResult {
  quarter_end: string;
  periods_covered: string[];
  boxes: {
    box_1: string;
    box_2: string;
    box_3: string;
    box_4: string;
    box_5: string;
    box_6: string;
    box_7: string;
    box_8: string;
    box_9: string;
  };
}

export async function getVatReturn(opts: { quarter_end: string }): Promise<VatReturnResult> {
  // Compute the three periods in the quarter
  const [yearStr, monthStr] = opts.quarter_end.split('-') as [string, string];
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const periodIds: string[] = [];
  for (let i = 2; i >= 0; i--) {
    let m = month - i;
    let y = year;
    if (m <= 0) { m += 12; y -= 1; }
    periodIds.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  // Box 1 — VAT Output: sum of credits to account 2100 across the quarter
  const vatOutputRow = await db('transaction_lines')
    .whereIn('period_id', periodIds)
    .where('account_code', '2100')
    .select(db.raw('COALESCE(SUM(credit), 0) as total_credits'), db.raw('COALESCE(SUM(debit), 0) as total_debits'))
    .first<{ total_credits: string; total_debits: string }>();

  // Box 4 — VAT Input: sum of debits to account 1200 across the quarter
  const vatInputRow = await db('transaction_lines')
    .whereIn('period_id', periodIds)
    .where('account_code', '1200')
    .select(db.raw('COALESCE(SUM(debit), 0) as total_debits'), db.raw('COALESCE(SUM(credit), 0) as total_credits'))
    .first<{ total_debits: string; total_credits: string }>();

  // Box 6 — Total sales ex-VAT: sum of credits to REVENUE accounts
  const revenueRow = await db('transaction_lines')
    .join('accounts', 'transaction_lines.account_code', 'accounts.code')
    .whereIn('transaction_lines.period_id', periodIds)
    .where('accounts.type', 'REVENUE')
    .select(db.raw('COALESCE(SUM(transaction_lines.credit), 0) as total_credits'), db.raw('COALESCE(SUM(transaction_lines.debit), 0) as total_debits'))
    .first<{ total_credits: string; total_debits: string }>();

  // Box 7 — Total purchases ex-VAT: sum of debits to EXPENSE accounts
  const expenseRow = await db('transaction_lines')
    .join('accounts', 'transaction_lines.account_code', 'accounts.code')
    .whereIn('transaction_lines.period_id', periodIds)
    .where('accounts.type', 'EXPENSE')
    .select(db.raw('COALESCE(SUM(transaction_lines.debit), 0) as total_debits'), db.raw('COALESCE(SUM(transaction_lines.credit), 0) as total_credits'))
    .first<{ total_debits: string; total_credits: string }>();

  const box1 = new Decimal(vatOutputRow?.total_credits ?? 0).minus(vatOutputRow?.total_debits ?? 0);
  const box2 = new Decimal(0);
  const box3 = box1.plus(box2);
  const box4 = new Decimal(vatInputRow?.total_debits ?? 0).minus(vatInputRow?.total_credits ?? 0);
  const box5 = box3.minus(box4);
  const box6 = new Decimal(revenueRow?.total_credits ?? 0).minus(revenueRow?.total_debits ?? 0);
  const box7 = new Decimal(expenseRow?.total_debits ?? 0).minus(expenseRow?.total_credits ?? 0);
  const box8 = new Decimal(0);
  const box9 = new Decimal(0);

  return {
    quarter_end: opts.quarter_end,
    periods_covered: periodIds,
    boxes: {
      box_1: box1.toFixed(2),
      box_2: box2.toFixed(2),
      box_3: box3.toFixed(2),
      box_4: box4.toFixed(2),
      box_5: box5.toFixed(2),
      box_6: box6.toFixed(2),
      box_7: box7.toFixed(2),
      box_8: box8.toFixed(2),
      box_9: box9.toFixed(2),
    },
  };
}
