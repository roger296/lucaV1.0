# General Ledger MCP Tool Reference

This file documents all MCP tools available in the General Ledger system, including Phase 1 tools
(core GL operations) and Phase 2 tools (extended capabilities).

---

## Phase 1 — Core GL Tools

### gl_post_transaction
Submit a financial transaction to the General Ledger for posting.

**Parameters:**
- `transaction_type` (string, required) — e.g. `MANUAL_JOURNAL`, `CUSTOMER_INVOICE`, `SUPPLIER_INVOICE`, `CUSTOMER_PAYMENT`, `SUPPLIER_PAYMENT`, `PRIOR_PERIOD_ADJUSTMENT`
- `description` (string, required) — human-readable description
- `reference` (string, optional) — source document reference (invoice number, etc.)
- `date` (string, required) — ISO 8601 date of the transaction
- `currency` (string, optional) — default `GBP`
- `lines` (array, required for MANUAL_JOURNAL) — each line: `{ account_code, debit, credit, description }`
- `soft_close_override` (boolean, optional) — set `true` to post into a soft-closed period

**Response:** `{ success: true, data: { transaction_id, status, lines } }`

---

### gl_query_journal
Search committed transactions in the General Ledger.

**Parameters:**
- `period_id` (string, optional) — filter by period, e.g. `"2026-03"`
- `account_code` (string, optional) — filter by account
- `transaction_type` (string, optional)
- `date_from` / `date_to` (string, optional) — ISO 8601 date range
- `limit` / `offset` (number, optional) — pagination

**Response:** `{ success: true, data: { transactions: [...], total } }`

---

### gl_get_trial_balance
Get the trial balance for a specific accounting period.

**Parameters:**
- `period_id` (string, required) — e.g. `"2026-03"` or `"current"`

**Response:** `{ success: true, data: { period_id, accounts: [{ code, name, debit, credit }], total_debits, total_credits, balanced } }`

---

### gl_get_account_balance
Get the current balance of a specific general ledger account.

**Parameters:**
- `account_code` (string, required)
- `period_id` (string, optional)

**Response:** `{ success: true, data: { account_code, name, type, debit_total, credit_total, net_balance } }`

---

### gl_list_accounts
List or search the chart of accounts.

**Parameters:**
- `type` (string, optional) — `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `EXPENSE`
- `active` (boolean, optional)
- `search` (string, optional) — name/code search

**Response:** `{ success: true, data: { accounts: [{ code, name, type, category, active }] } }`

---

### gl_get_period_status
Check the status of an accounting period.

**Parameters:**
- `period_id` (string, required)

**Response:** `{ success: true, data: { period_id, status, start_date, end_date, data_flag } }`

---

### gl_approve_transaction
Approve a transaction pending in the approval queue.

**Parameters:**
- `staging_id` (string, required)
- `approved_by` (string, required)
- `notes` (string, optional)

**Response:** `{ success: true, data: { transaction_id, status: 'COMMITTED' } }`

---

### gl_reject_transaction
Reject a transaction pending in the approval queue.

**Parameters:**
- `staging_id` (string, required)
- `rejected_by` (string, required)
- `reason` (string, required)

**Response:** `{ success: true, data: { staging_id, status: 'REJECTED' } }`

---

### gl_verify_chain
Verify the integrity of the hash chain for a specific accounting period.

**Parameters:**
- `period_id` (string, required)

**Response:** `{ success: true, data: { valid: boolean, entries: number, error?: string } }`

---

## Phase 2 — Extended Capabilities

---

## Period Management

### `gl_open_period`

**Purpose:** Open a new accounting period. Multiple periods can be open simultaneously — this is normal during month-end close when the previous month is still being finalised while the new month's operational transactions need to flow.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `period_id` | string | Yes | The period to open (YYYY-MM format, e.g. `2026-04`) |

**Response:**

| Field | Description |
|---|---|
| `period_id` | The opened period |
| `status` | Always `OPEN` |
| `start_date` | First day of the month |
| `end_date` | Last day of the month |
| `opened_at` | Timestamp |
| `is_new` | `true` if newly created, `false` if it already existed |

**Errors:**
- If the period exists and is `HARD_CLOSE`, returns an error — sealed periods cannot be reopened.
- Invalid `period_id` format returns a validation error.

---

### gl_soft_close_period
Transition an accounting period from OPEN to SOFT_CLOSE. After soft-close, all new transactions
for this period require approval. The period's end date must have passed.

**Parameters:**
- `period_id` (string, required) — e.g. `"2026-03"`

**Example:**
```json
{
  "period_id": "2026-03"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "period_id": "2026-03",
    "status": "SOFT_CLOSE",
    "soft_closed_at": "2026-04-01T09:00:00.000Z"
  }
}
```

---

### gl_hard_close_period
Permanently seal an accounting period. Writes a PERIOD_CLOSE entry to the hash chain, seals
the chain file as read-only, and opens the next period. The period must be SOFT_CLOSE with no
pending approvals and a balanced trial balance. Sequential ordering is enforced — you cannot
close March before February.

**Parameters:**
- `period_id` (string, required) — e.g. `"2026-03"`
- `closed_by` (string, required) — user identity performing the close

**Example:**
```json
{
  "period_id": "2026-03",
  "closed_by": "finance.controller@company.com"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "period_id": "2026-03",
    "status": "HARD_CLOSE",
    "hard_closed_at": "2026-04-02T10:30:00.000Z",
    "closing_chain_hash": "a1b2c3d4...(64-char hex)",
    "next_period_id": "2026-04"
  }
}
```

**Errors to handle:**
- `InvalidPeriodStateError` — period is not SOFT_CLOSE
- `PeriodSequenceError` — previous period is not yet closed
- `StagingNotClearError` — pending transactions remain
- `TrialBalanceError` — debits do not equal credits

---

## Account Management

### gl_create_account
Create a new account in the chart of accounts. Use standard numbering: 1xxx for assets, 2xxx
for liabilities, 3xxx for equity, 4xxx for revenue, 5xxx-6xxx for expenses.

**Parameters:**
- `code` (string, required) — unique account code, e.g. `"6250"`
- `name` (string, required) — account name
- `type` (string, required) — `ASSET` | `LIABILITY` | `EQUITY` | `REVENUE` | `EXPENSE`
- `category` (string, optional) — e.g. `CURRENT_ASSET`, `OVERHEADS`, `DIRECT_COSTS`

**Example:**
```json
{
  "code": "6250",
  "name": "Staff Training",
  "type": "EXPENSE",
  "category": "OVERHEADS"
}
```

**Response:** Created account row — `{ code, name, type, category, active: true, created_at }`

---

### gl_update_account
Update an existing account in the chart of accounts. Can change name, category, or active status.
Cannot change the account code or type.

**Parameters:**
- `code` (string, required) — account to update
- `name` (string, optional) — new name
- `category` (string, optional) — new category
- `active` (boolean, optional) — set `false` to deactivate

**Example:**
```json
{
  "code": "6250",
  "name": "Staff Training and Development",
  "active": true
}
```

**Response:** Updated account row.

---

## Query Tools

### gl_get_transaction
Retrieve a single transaction by ID with all its posting lines.

**Parameters:**
- `transaction_id` (string, required) — e.g. `"TXN-2026-03-00001"`

**Example:**
```json
{
  "transaction_id": "TXN-2026-03-00001"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transaction_id": "TXN-2026-03-00001",
    "transaction_type": "CUSTOMER_INVOICE",
    "date": "2026-03-04",
    "description": "Sale of widgets",
    "status": "COMMITTED",
    "lines": [
      { "account_code": "1100", "debit": 1200.00, "credit": 0 },
      { "account_code": "4000", "debit": 0, "credit": 1000.00 },
      { "account_code": "2100", "debit": 0, "credit": 200.00 }
    ]
  }
}
```

---

### gl_get_account_ledger
Get all transactions hitting a specific account with a running balance. This is the detailed
account ledger view.

**Parameters:**
- `account_code` (string, required) — e.g. `"1000"`
- `period_id` (string, optional) — filter to a specific period
- `date_from` (string, optional) — ISO 8601 date
- `date_to` (string, optional) — ISO 8601 date

**Example:**
```json
{
  "account_code": "1000",
  "period_id": "2026-03"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "account_code": "1000",
    "account_name": "Bank Current Account",
    "entries": [
      {
        "transaction_id": "TXN-2026-03-00001",
        "date": "2026-03-04",
        "description": "...",
        "debit": 0,
        "credit": 500.00,
        "running_balance": 14920.50
      }
    ],
    "total_debits": 5000.00,
    "total_credits": 3200.00,
    "closing_balance": 1800.00
  }
}
```

---

### gl_get_dashboard_summary
Get key metrics for a morning briefing: current period, pending approvals, recent transactions,
trial balance summary.

**Parameters:**
- `period_id` (string, optional) — defaults to current open period

**Example:**
```json
{
  "period_id": "2026-04"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "current_period": { "period_id": "2026-04", "status": "OPEN" },
    "pending_approvals": 3,
    "recent_transactions": [...],
    "trial_balance_totals": {
      "total_debits": 145200.00,
      "total_credits": 145200.00,
      "balanced": true
    }
  }
}
```

---

### gl_bulk_post_transactions
Post multiple transactions in a single call. Useful for migration, month-end batch processing,
and importing data from other systems.

**Parameters:**
- `transactions` (array, required) — array of transaction objects (same shape as `gl_post_transaction`)
- `stop_on_error` (boolean, optional) — default `false`; if `true`, stops at first failure

**Example:**
```json
{
  "transactions": [
    { "transaction_type": "CUSTOMER_INVOICE", "date": "2026-04-01", "description": "...", "lines": [...] },
    { "transaction_type": "SUPPLIER_INVOICE", "date": "2026-04-01", "description": "...", "lines": [...] }
  ],
  "stop_on_error": false
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 2,
    "posted": 2,
    "staged": 0,
    "errors": 0,
    "results": [
      { "index": 0, "transaction_id": "TXN-2026-04-00001", "status": "COMMITTED" },
      { "index": 1, "transaction_id": "TXN-2026-04-00002", "status": "PENDING" }
    ]
  }
}
```

---

## Bank Reconciliation Tools

### gl_register_bank_account
Register a bank account and link it to a GL account code. This enables bank statement import
and reconciliation for that account.

**Parameters:**
- `id` (string, required) — unique identifier for the bank account, e.g. `"BANK-001"`
- `account_code` (string, required) — the GL account to link to, e.g. `"1000"`
- `bank_name` (string, required) — e.g. `"Barclays"`
- `account_name` (string, required) — e.g. `"Business Current Account"`
- `sort_code` (string, optional) — e.g. `"20-00-00"`
- `account_number` (string, optional) — e.g. `"12345678"`
- `iban` (string, optional)
- `currency` (string, optional) — default `"GBP"`

**Example:**
```json
{
  "id": "BANK-001",
  "account_code": "1000",
  "bank_name": "Barclays",
  "account_name": "Business Current Account",
  "sort_code": "20-00-00",
  "account_number": "12345678",
  "currency": "GBP"
}
```

**Response:** The created bank account row.

---

### gl_import_bank_statement
Import a bank statement into the system. Supports CSV (with configurable column mapping) and
JSON formats. Automatically detects and skips duplicate lines.

**Parameters:**
- `bank_account_id` (string, required) — registered bank account ID
- `format` (string, required) — `"CSV"` or `"JSON"`
- `csv_content` (string, optional) — raw CSV text (required for CSV format)
- `column_mapping` (object, optional) — maps CSV headers to fields: `{ date, description, debit, credit, reference, balance }`
- `lines` (array, optional) — pre-parsed lines (required for JSON format)

**Example (CSV):**
```json
{
  "bank_account_id": "BANK-001",
  "format": "CSV",
  "csv_content": "Date,Description,Debit,Credit,Balance\n04/03/2026,BACS PAYMENT,500.00,,14920.50",
  "column_mapping": {
    "date": "Date",
    "description": "Description",
    "debit": "Debit",
    "credit": "Credit",
    "balance": "Balance"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "batch_id": "STMT-BATCH-001",
    "imported_lines": 42,
    "duplicate_lines": 3
  }
}
```

---

### gl_reconcile_bank_account
Run automatic matching for all unmatched bank statement lines against GL transactions. Uses
reference, amount, and date matching strategies.

**Parameters:**
- `bank_account_id` (string, required)
- `date_from` (string, optional) — ISO 8601 date
- `date_to` (string, optional) — ISO 8601 date
- `auto_confirm_high_confidence` (boolean, optional) — if `true`, automatically confirms matches
  with confidence >= 95%

**Example:**
```json
{
  "bank_account_id": "BANK-001",
  "auto_confirm_high_confidence": true
}
```

**Response:** `ReconciliationResult` — counts of matched/unmatched lines, details of each suggested match.

---

### gl_confirm_bank_match
Confirm a suggested bank statement match. Marks the statement line as CONFIRMED.

**Parameters:**
- `statement_line_id` (string, required)
- `transaction_id` (string, required) — the GL transaction this line matches
- `notes` (string, optional)

**Example:**
```json
{
  "statement_line_id": "STMT-LINE-0042",
  "transaction_id": "TXN-2026-03-00019",
  "notes": "Matched manually — reference format differs"
}
```

**Response:** `{ confirmed: true }`

---

### gl_post_and_match_bank_line
Create a new GL transaction from an unmatched bank line and mark it as reconciled.
Useful for bank charges, direct debits, and other items that have no existing GL transaction.

**Parameters:**
- `statement_line_id` (string, required)
- `transaction_type` (string, required) — e.g. `"BANK_PAYMENT"`, `"BANK_RECEIPT"`
- `description` (string, required)
- `account_code` (string, optional) — GL account to post to (other side from bank)
- `counterparty` (object, optional) — `{ name, reference }`

**Example:**
```json
{
  "statement_line_id": "STMT-LINE-0051",
  "transaction_type": "BANK_PAYMENT",
  "description": "Barclays bank charges March 2026",
  "account_code": "7100"
}
```

**Response:** `{ transaction_id: "TXN-2026-03-00055", match_status: "CONFIRMED" }`

---

### gl_exclude_bank_line
Exclude a bank statement line from reconciliation. Use for internal transfers already recorded
elsewhere, or items deliberately not posted to the GL.

**Parameters:**
- `statement_line_id` (string, required)
- `reason` (string, required) — explanation for the exclusion

**Example:**
```json
{
  "statement_line_id": "STMT-LINE-0060",
  "reason": "Internal transfer between current and deposit accounts — already recorded as TRANSFER"
}
```

**Response:** `{ excluded: true }`

---

### gl_get_reconciliation_status
Get the reconciliation status summary for a bank account: matched, confirmed, excluded, and
unmatched counts; GL balance vs statement balance; difference.

**Parameters:**
- `bank_account_id` (string, required)
- `date_from` (string, optional) — ISO 8601 date
- `date_to` (string, optional) — ISO 8601 date

**Example:**
```json
{
  "bank_account_id": "BANK-001",
  "date_from": "2026-03-01",
  "date_to": "2026-03-31"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total_lines": 84,
    "matched": 71,
    "confirmed": 65,
    "excluded": 3,
    "unmatched": 10,
    "gl_balance": 18750.50,
    "statement_balance": 18750.50,
    "difference": 0.00
  }
}
```

---

## Document Inbox Tools

### gl_configure_inbox
Configure the document inbox watch directory and settings.

**Parameters:**
- `watch_directory` (string, required) — absolute path to the folder to watch
- `archive_directory` (string, optional) — where processed documents are moved
- `allowed_extensions` (array, optional) — default `[".pdf", ".jpg", ".png"]`
- `max_file_size_mb` (number, optional) — default `10`

**Example:**
```json
{
  "watch_directory": "/data/inbox",
  "archive_directory": "/data/archive",
  "allowed_extensions": [".pdf", ".jpg", ".png", ".jpeg"],
  "max_file_size_mb": 25
}
```

**Response:** `void` (success/error only)

---

### gl_scan_inbox
Scan the inbox directory for new documents and add them to the processing queue.

**Parameters:** none

**Example:**
```json
{}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "new_files": 5,
    "total_pending": 8,
    "directory": "/data/inbox"
  }
}
```

---

### gl_get_pending_documents
Get a list of pending documents waiting to be processed.

**Parameters:**
- `limit` (number, optional) — maximum number of documents to return

**Example:**
```json
{
  "limit": 20
}
```

**Response:** Array of `InboxDocument` — `{ id, filename, path, status, size_bytes, detected_at }`

---

### gl_complete_document_processing
Mark a document as successfully processed and record what was done with it.

**Parameters:**
- `document_id` (string, required)
- `document_type` (string, required) — e.g. `"SUPPLIER_INVOICE"`, `"BANK_STATEMENT"`
- `transaction_id` (string, optional) — the GL transaction created from this document
- `staging_id` (string, optional) — if the transaction went to staging
- `extracted_data` (object, optional) — key-value map of data extracted from the document
- `processing_notes` (string, required) — brief description of what was done

**Example:**
```json
{
  "document_id": "DOC-0042",
  "document_type": "SUPPLIER_INVOICE",
  "transaction_id": "TXN-2026-04-00005",
  "extracted_data": {
    "supplier": "Acme Corp",
    "invoice_number": "INV-001",
    "amount": 1200.00
  },
  "processing_notes": "Supplier invoice — posted to 6400 Office Supplies"
}
```

**Response:** `void`

---

### gl_fail_document_processing
Mark a document as failed to process, recording the error message.

**Parameters:**
- `document_id` (string, required)
- `error_message` (string, required) — description of why processing failed

**Example:**
```json
{
  "document_id": "DOC-0043",
  "error_message": "Could not extract data — image too blurry to read"
}
```

**Response:** `void`

---

### gl_get_inbox_status
Get a summary of the inbox status: counts by status, watch directory, and active state.

**Parameters:** none

**Example:**
```json
{}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "counts": {
      "pending": 3,
      "processing": 0,
      "completed": 127,
      "failed": 2
    },
    "watch_directory": "/data/inbox",
    "active": true
  }
}
```

---

## Setup Tools

### gl_get_setup_status
Check whether the General Ledger has been configured: business profile, chart of accounts,
opening balances, and current period.

**Parameters:** none

**Example:**
```json
{}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "is_configured": true,
    "has_business_profile": true,
    "has_chart_of_accounts": true,
    "has_opening_balances": true,
    "current_period": "2026-04"
  }
}
```

---

### gl_import_chart_of_accounts
Import a chart of accounts from a CSV export of Xero, Sage, QuickBooks, or a generic format.
Creates new accounts and updates existing ones.

**Parameters:**
- `csv_content` (string, required) — raw CSV text
- `source_system` (string, required) — `"XERO"` | `"SAGE"` | `"QUICKBOOKS"` | `"GENERIC"`
- `replace_existing` (boolean, optional) — if `true`, deactivates accounts not in the import

**Example:**
```json
{
  "csv_content": "Code,Name,Type\n1000,Bank,ASSET\n4000,Sales,REVENUE",
  "source_system": "XERO",
  "replace_existing": false
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "imported": 45,
    "updated": 3,
    "deactivated": 0,
    "errors": []
  }
}
```

---

### gl_post_opening_balances
Post opening balances as a manual journal to initialise the General Ledger. Debits must equal
credits.

**Parameters:**
- `balances` (array, required) — `[{ account_code, debit, credit }]`
- `effective_date` (string, required) — ISO 8601 date of the opening balance
- `description` (string, optional) — default: `"Opening balances"`

**Example:**
```json
{
  "balances": [
    { "account_code": "1000", "debit": 15420.50, "credit": 0 },
    { "account_code": "1100", "debit": 8200.00, "credit": 0 },
    { "account_code": "2000", "debit": 0, "credit": 3150.00 },
    { "account_code": "3100", "debit": 0, "credit": 20470.50 }
  ],
  "effective_date": "2026-03-31",
  "description": "Opening balances as at 31 March 2026"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transaction_id": "TXN-2026-04-00001",
    "total_debits": 23620.50,
    "total_credits": 23620.50
  }
}
```

---

### gl_save_business_profile
Save or update the business profile (company name, VAT registration, financial year end,
territory, etc.).

**Parameters:**
- `company_name` (string, required)
- `base_currency` (string, optional) — default `"GBP"`
- `financial_year_start_month` (number, optional) — 1-12, e.g. `4` for April
- `vat_registered` (boolean, optional)
- `vat_number` (string, optional) — e.g. `"GB123456789"`
- `vat_scheme` (string, optional) — `"STANDARD"` | `"FLAT_RATE"` | `"CASH_ACCOUNTING"`
- `company_number` (string, optional) — Companies House number
- `registered_address` (object, optional)
- `industry` (string, optional)
- `territory` (string, optional) — e.g. `"GB"`, `"IE"`, `"US"`

**Example:**
```json
{
  "company_name": "Acme Ltd",
  "base_currency": "GBP",
  "financial_year_start_month": 4,
  "vat_registered": true,
  "vat_number": "GB123456789",
  "vat_scheme": "STANDARD",
  "company_number": "12345678",
  "territory": "GB"
}
```

**Response:** `void`

---

## Batch/Scheduled Run Tools

### gl_start_batch_run
Start a new batch run. Call this at the beginning of each scheduled or manual batch session.
Returns the `batch_id` to use for subsequent task recording.

**Parameters:**
- `run_type` (string, optional) — e.g. `"OVERNIGHT"`, `"MANUAL"`, `"SCHEDULED"`

**Example:**
```json
{
  "run_type": "OVERNIGHT"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "batch_id": "BATCH-2026-04-04-001",
    "status": "RUNNING",
    "started_at": "2026-04-04T02:00:01.000Z"
  }
}
```

---

### gl_record_batch_task
Record the completion of a task within a batch run. Call this after each major step (scan_inbox,
process_documents, bank_reconciliation, etc.).

**Parameters:**
- `batch_id` (string, required) — from `gl_start_batch_run`
- `task` (string, required) — task name, e.g. `"scan_inbox"`, `"process_documents"`, `"bank_reconciliation"`
- `status` (string, required) — `"SUCCESS"` | `"FAILED"` | `"SKIPPED"`
- `details` (object, required) — free-form summary of what happened

**Example:**
```json
{
  "batch_id": "BATCH-2026-04-04-001",
  "task": "scan_inbox",
  "status": "SUCCESS",
  "details": {
    "new_files": 5,
    "total_pending": 8
  }
}
```

**Response:** `{ recorded: true }`

---

### gl_complete_batch_run
Mark a batch run as complete with a summary. Call this at the end of every batch session,
even if some tasks failed.

**Parameters:**
- `batch_id` (string, required)
- `summary` (string, required) — human-readable summary of the run
- `status` (string, optional) — `"SUCCESS"` | `"PARTIAL"` | `"FAILED"` — defaults to `"SUCCESS"`

**Example:**
```json
{
  "batch_id": "BATCH-2026-04-04-001",
  "summary": "Processed 5 inbox documents, reconciled 42 bank lines, 3 items need attention.",
  "status": "PARTIAL"
}
```

**Response:** `{ completed: true }`

---

### gl_get_latest_batch_run
Get the most recent batch run and its results. Use this at the start of a session to see what
happened during the last overnight run.

**Parameters:** none

**Example:**
```json
{}
```

**Response:** `BatchRun` object — `{ batch_id, run_type, status, started_at, completed_at, tasks: [...], summary }`.
If no batch run exists: returns a `NOT_FOUND` error.

---

## Additional Phase 2 Tools

### gl_get_profit_and_loss
Get the Profit and Loss report for an accounting period.

**Parameters:**
- `period_id` (string, required)

**Response:** P&L report — revenue accounts, expense accounts, gross profit, net profit.

---

### gl_get_balance_sheet
Get the Balance Sheet as at a specific period or date.

**Parameters:**
- `period_id` (string, required)

**Response:** Balance sheet — assets, liabilities, equity.

---

### gl_get_aged_debtors
Get the aged debtors report showing outstanding customer balances by age.

**Parameters:**
- `period_id` (string, optional)
- `as_at_date` (string, optional)

**Response:** Aged debtors by 0-30, 31-60, 61-90, 90+ days.

---

### gl_get_aged_creditors
Get the aged creditors report showing outstanding supplier balances by age.

**Parameters:** Same as `gl_get_aged_debtors`.

---

### gl_get_vat_return
Get the VAT return figures for a quarterly period.

**Parameters:**
- `period_id` (string, required)

**Response:** VAT boxes 1-9 in HMRC MTD format.

---

### gl_year_end_close
Execute year-end closing entries to transfer P&L balances to Retained Earnings.

**Parameters:**
- `period_id` (string, required) — the final period of the financial year
- `closed_by` (string, required)

**Response:** Year-end journal transaction ID and summary.

---

### gl_verify_chain_sequence
Verify the hash chain integrity across multiple consecutive accounting periods, including
cross-period links.

**Parameters:**
- `from_period_id` (string, required)
- `to_period_id` (string, required)

**Response:** `{ valid: boolean, periods_checked: number, error?: string }`

---

### gl_recover_missing_transactions
Detect chain entries that are missing from the database mirror and replay them. Run after a
crash or unexpected shutdown.

**Parameters:**
- `period_id` (string, required)

**Response:** `{ entries_scanned, entries_recovered, errors }`

---

### gl_add_exchange_rate / gl_get_exchange_rate
Add or look up exchange rates for FX transactions.

**Parameters (add):** `{ currency_from, currency_to, rate, effective_date }`
**Parameters (get):** `{ currency_from, currency_to, date }`
