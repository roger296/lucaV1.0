# General Ledger — Workflow Reference

This file documents the step-by-step workflows for recurring accounting operations.

---

## Bank Reconciliation Workflow

Use this workflow when the user wants to reconcile a bank account against their GL.

Trigger phrases: "reconcile the bank", "import bank statement", "match bank transactions",
"bank statements", "bank rec", "do the bank".

### Step 1 — Get the bank statement

Ask the user for their bank statement:

> "To reconcile the bank, I'll need your bank statement. You can either:
> 1. **Upload the CSV** from your online banking (most banks offer a CSV export)
> 2. **Paste the data** directly if it's a short list
>
> Which bank account are we reconciling, and for what period?"

Establish:
- Which bank account (check registered accounts with `gl_get_reconciliation_status` if needed)
- The date range

### Step 2 — Register the bank account (if not already done)

If the bank account isn't yet registered, call `gl_register_bank_account`:

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

### Step 3 — Import the bank statement

Call `gl_import_bank_statement` with the correct column mapping for the bank's CSV format.

Common UK bank CSV formats:
- **Barclays**: Date, Description, Amount (positive = credit, negative = debit), Balance
- **HSBC**: Date, Type, Description, Paid in, Paid out, Balance
- **Lloyds**: Transaction Date, Transaction Type, Sort Code, Account Number, Transaction Description, Debit Amount, Credit Amount, Balance

```json
{
  "bank_account_id": "BANK-001",
  "format": "CSV",
  "csv_content": "...",
  "column_mapping": {
    "date": "Date",
    "description": "Description",
    "debit": "Paid out",
    "credit": "Paid in",
    "balance": "Balance"
  }
}
```

Report to the user: "Imported [N] lines from your statement. [M] were duplicates and skipped."

### Step 4 — Run automatic matching

Call `gl_reconcile_bank_account` with `auto_confirm_high_confidence: true`:

```json
{
  "bank_account_id": "BANK-001",
  "auto_confirm_high_confidence": true
}
```

Report the results:

> "I matched **[X] of [Y] transactions** automatically.
> - [N] were confirmed automatically (high confidence)
> - [M] have suggested matches that need your confirmation
> - [P] are unmatched items — I'll need your help with these"

### Step 5 — Walk through suggested matches

For each MATCHED item (suggested but not yet confirmed), show the statement line and the
suggested GL transaction side by side:

> "**Bank statement line**: 15 Mar 2026 — BACS JOHNSON SUPPLIES LTD — £1,450.00
> **Suggested GL match**: TXN-2026-03-00019 — Supplier Payment — Johnson Supplies Ltd — £1,450.00
>
> Does this look correct? (yes/no)"

If yes, call `gl_confirm_bank_match`:
```json
{
  "statement_line_id": "STMT-LINE-0042",
  "transaction_id": "TXN-2026-03-00019"
}
```

### Step 6 — Handle unmatched items

For each UNMATCHED statement line, ask what it is:

> "**Unmatched item**: 28 Mar 2026 — DD BARCLAYS BANK CHARGES — £24.50
> What is this? Common options:
> 1. Bank charges — I'll post it to 7100 Bank Charges
> 2. Direct debit for a supplier bill — tell me which one
> 3. Internal transfer — I'll exclude it"

Based on their answer:
- Post a new transaction and match: use `gl_post_and_match_bank_line`
- Exclude: use `gl_exclude_bank_line`

### Step 7 — Confirm reconciliation is complete

Call `gl_get_reconciliation_status` to confirm everything is resolved:

```json
{
  "bank_account_id": "BANK-001",
  "date_from": "2026-03-01",
  "date_to": "2026-03-31"
}
```

If `difference` is 0.00 and `unmatched` is 0, the reconciliation is complete:

> "Bank reconciliation complete for March 2026.
> - GL balance: £18,750.50
> - Statement balance: £18,750.50
> - Difference: £0.00
>
> All [N] transactions are matched and confirmed."

If there is still a difference, work through it with the user — common causes are:
- Transactions posted to the wrong date (different period)
- Missing transactions not yet posted
- Timing differences (cheques not yet cleared)

---

## Document Processing Workflow (Batch Mode)

Use this workflow during scheduled overnight batch processing or when the user asks to
"process the inbox".

Trigger phrases: "process the inbox", "process new documents", "run document processing".

### Step 1 — Scan for new documents

```json
gl_scan_inbox: {}
```

Report: "Found [N] new documents in the inbox. There are [M] documents total pending processing."

### Step 2 — Get the list of pending documents

```json
gl_get_pending_documents: { "limit": 50 }
```

### Step 3 — Process each document

For each document in the list:

1. **Read the file** using the Read tool (supports PDF, images, spreadsheets)
2. **Identify the document type** — is it a supplier invoice, customer invoice, bank statement,
   expense receipt, payroll summary, or something else?
3. **Extract key data**:
   - Supplier/customer name
   - Document number
   - Date
   - Amount (net, VAT, gross)
   - What was bought/sold

4. **Post the transaction** using `gl_post_transaction` or the appropriate transaction type

5. **Mark as complete** using `gl_complete_document_processing`:
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
  "processing_notes": "Supplier invoice from Acme Corp — posted to 6400 Office Supplies"
}
```

If a document cannot be read or classified, call `gl_fail_document_processing`:
```json
{
  "document_id": "DOC-0043",
  "error_message": "Image too blurry to extract data — manual review required"
}
```

### Step 4 — Report results

After processing all documents, provide a summary:

> "Document processing complete:
> - [N] documents processed successfully
> - [M] transactions posted
> - [P] documents failed — need manual review:
>   - [filename] — [reason]"

---

## Morning Briefing Workflow

Use this workflow at the start of the working day or when the user asks for a status update.

Trigger phrases: "morning briefing", "what happened overnight", "overnight run results",
"what's the status", "good morning Luca", "wake up Luca".

### Step 1 — Get dashboard summary

```json
gl_get_dashboard_summary: {}
```

This gives: current period, pending approvals, recent transactions, trial balance totals.

### Step 2 — Check overnight batch results

```json
gl_get_latest_batch_run: {}
```

If a batch run completed overnight, report what was done. If no batch run exists, note that
overnight processing hasn't been set up.

### Step 3 — Check bank reconciliation status

For each registered bank account, call `gl_get_reconciliation_status`:

```json
{
  "bank_account_id": "BANK-001",
  "date_from": "2026-04-01"
}
```

### Step 4 — Deliver the briefing

Deliver a concise morning briefing:

> "**Good morning! Here's your financial summary for [date]:**
>
> **Cash position**
> - Bank (1000): £[balance]
> - [other accounts if relevant]
>
> **Approvals pending**: [N] transactions waiting for approval
> [If N > 0: "The oldest has been waiting [X] days — would you like to review them now?"]
>
> **Overnight processing** [if batch ran]:
> - Inbox: [N] documents processed, [M] failed
> - Bank matching: [N] lines matched automatically
> - Any issues: [list problems if any]
>
> **Bank reconciliation**:
> - [Account name]: [matched/total] matched, [N] unmatched
>
> **Anything that needs attention today**:
> [List any items requiring action — failed documents, unmatched bank lines, large pending approvals, etc.]"

Keep the briefing concise. If everything is clear, say so — don't pad it out.

---

## Period Closing Workflow

Use this workflow when the user wants to close an accounting period.

Trigger phrases: "close the month", "close [month] [year]", "month-end close", "period close",
"soft close", "hard close".

### Step 1 — Establish which period and what type of close

Ask: "Are you doing a soft close (locking the period for routine postings but allowing
adjustments) or a hard close (permanently sealing the period)?"

Explain the difference if needed:
> "A **soft close** prevents routine transactions from going in without approval — useful when
> you're doing month-end and want to control what comes in. An accountant can still post
> adjustments.
>
> A **hard close** permanently seals the period — the hash chain is sealed and no further
> postings are possible. This is the final step once you're happy with the numbers."

### Step 2 — Check the pre-conditions

Before closing, verify the period is ready:
1. Call `gl_get_period_status` to confirm the period exists and check its status.
   - If the period does not exist — call `gl_open_period` to create it, then proceed. This is normal when the calendar has moved to a new month but the period hasn't been opened yet.
2. Call `gl_get_trial_balance` — confirm it balances
3. Call `gl_get_dashboard_summary` — check pending approvals
4. If there are pending approvals, ask the user if they want to review them now

### Step 3 — Soft close

```json
gl_soft_close_period: { "period_id": "2026-03" }
```

Confirm: "Period 2026-03 is now soft-closed. New transactions will go to approval status.
Accountants can still post adjustments with override."

### Step 4 — Hard close (when ready)

Only proceed when the user explicitly wants to permanently close the period.

```json
gl_hard_close_period: {
  "period_id": "2026-03",
  "closed_by": "finance.controller@company.com"
}
```

Confirm: "Period 2026-03 has been permanently closed. The chain file is sealed.
Period 2026-04 is now open."

If the hard close fails, explain the reason and what needs to be resolved:
- `PeriodSequenceError` — the previous period must be closed first
- `StagingNotClearError` — there are still pending transactions to approve/reject
- `TrialBalanceError` — the trial balance does not balance (investigate immediately)

---

## Setup Redirect

When the user is asking about initial setup, configuration, or migration, redirect them to
the `luca-setup` skill:

Trigger phrases: "set up", "configure", "migrate from", "starting fresh", "chart of accounts
import", "opening balances".

> "For initial setup and configuration, let me switch to setup mode — I'll guide you through
> getting the GL configured for your business."

Use `gl_get_setup_status` first to understand what's already done, then follow the luca-setup
skill workflow.
