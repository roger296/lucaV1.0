// ---------------------------------------------------------------------------
// types.ts — Shared API response types
// ---------------------------------------------------------------------------

export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';
export type DataFlag = 'PROVISIONAL' | 'AUTHORITATIVE';
export type TransactionType =
  | 'MANUAL_JOURNAL'
  | 'CUSTOMER_INVOICE'
  | 'SUPPLIER_INVOICE'
  | 'CUSTOMER_PAYMENT'
  | 'SUPPLIER_PAYMENT'
  | 'PRIOR_PERIOD_ADJUSTMENT';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface Period {
  period_id: string;
  start_date: string;
  end_date: string;
  status: PeriodStatus;
  data_flag: DataFlag;
  opened_at: string;
  soft_closed_at?: string | null;
  hard_closed_at?: string | null;
  closed_by?: string | null;
  closing_chain_hash?: string | null;
}

export interface PeriodDetail extends Period {
  pending_staging_count: number;
  total_debits: string;
  total_credits: string;
}

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  category: string | null;
  active: boolean;
  balance_debit?: string;
  balance_credit?: string;
}

export interface TransactionLine {
  transaction_id: string;
  period_id: string;
  account_code: string;
  description: string | null;
  debit: string;
  credit: string;
  cost_centre: string | null;
  data_flag: DataFlag;
}

export interface Transaction {
  transaction_id: string;
  period_id: string;
  transaction_type: TransactionType;
  reference: string | null;
  date: string;
  currency: string;
  description: string | null;
  status: string;
  data_flag: DataFlag;
  chain_sequence: number | null;
  lines?: TransactionLine[];
  documents?: LinkedDocument[];
}

export interface StagingEntry {
  staging_id: string;
  period_id: string;
  transaction_type: TransactionType;
  reference: string | null;
  date: string;
  currency: string;
  description: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  total_amount: string;
  submitted_by: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  approval_rule_id: number | null;
  payload: string;
  documents?: LinkedDocument[];
}

export interface TrialBalanceLine {
  code: string;
  name: string;
  type: AccountType;
  category: string | null;
  total_debits: string;
  total_credits: string;
}

export interface DashboardData {
  current_period: Period | null;
  pending_approval_count: number;
  recent_transactions: Transaction[];
  trial_balance_summary: { total_debits: string; total_credits: string };
  transaction_counts: Array<{ transaction_type: string; count: string }>;
}

export interface LinkedDocument {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size: number | null;
  document_type: string | null;
  processing_notes: string | null;
  completed_at: string | null;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  total?: number;
}
