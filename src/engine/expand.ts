import Decimal from 'decimal.js';
import type { Knex } from 'knex';
import type { MappingRow, PostingLine, TransactionSubmission } from './types';
import { PostingEngineError } from './types';
import type { TaxCode } from './types';

// ---------------------------------------------------------------------------
// expand.ts — expand human-friendly transaction types into posting lines
// ---------------------------------------------------------------------------

/**
 * Maps a tax code to its VAT rate.
 * For codes with no VAT (OUTSIDE_SCOPE, EXEMPT, ZERO_RATED), returns 0.
 */
function vatRateForTaxCode(taxCode: TaxCode | undefined): Decimal {
  switch (taxCode) {
    case 'STANDARD_VAT_20':
    case undefined:
      return new Decimal('0.20');
    case 'REDUCED_VAT_5':
      return new Decimal('0.05');
    case 'ZERO_RATED':
    case 'EXEMPT':
    case 'OUTSIDE_SCOPE':
      return new Decimal('0');
    case 'REVERSE_CHARGE':
    case 'POSTPONED_VAT':
      return new Decimal('0.20');
    default:
      return new Decimal('0.20');
  }
}

/**
 * Computes net and VAT amounts from a gross (VAT-inclusive) amount.
 *
 * gross = net + VAT = net * (1 + rate)
 * net   = gross / (1 + rate)
 * vat   = gross - net
 *
 * Both values are rounded to 2 decimal places (half-even / banker's rounding).
 */
export function splitGrossAmount(gross: Decimal, taxCode?: TaxCode): { net: Decimal; vat: Decimal } {
  const rate = vatRateForTaxCode(taxCode);
  if (rate.isZero()) {
    return { net: gross, vat: new Decimal(0) };
  }
  const divisor = new Decimal(1).plus(rate);
  const net = gross.div(divisor).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
  const vat = gross.minus(net);
  return { net, vat };
}

/**
 * Fetches the active account mappings for a transaction type from the database.
 */
export async function fetchMappings(
  trx: Knex | Knex.Transaction,
  transactionType: string,
): Promise<MappingRow[]> {
  const rows = await trx<MappingRow>('transaction_type_mappings')
    .where('transaction_type', transactionType)
    .where('active', true)
    .select('transaction_type', 'line_role', 'account_code', 'direction', 'description');

  if (rows.length === 0) {
    throw new PostingEngineError(
      `No active account mappings found for transaction type: ${transactionType}`,
    );
  }

  return rows;
}

/**
 * Expands a submission's `amount` field into posting lines using the
 * account mappings from the database.
 *
 * CUSTOMER_INVOICE / SUPPLIER_INVOICE / credit note types:
 *   The `amount` is the gross (VAT-inclusive) amount.
 *   VAT is computed using the tax_code (defaults to 20% standard rate).
 *   For OUTSIDE_SCOPE / EXEMPT / ZERO_RATED, no VAT line is generated.
 *
 * CUSTOMER_PAYMENT / SUPPLIER_PAYMENT:
 *   The `amount` is the full payment amount (no VAT split).
 *   Each mapped line uses the full amount.
 *
 * Line roles determine which direction (DEBIT/CREDIT) each account receives.
 * For VAT-bearing types, roles 'VAT_OUTPUT' and 'VAT_INPUT' receive the VAT
 * amount; the non-VAT debit/credit roles receive the net (REVENUE/EXPENSE) or
 * gross (DEBTORS/CREDITORS) amounts according to standard accounting.
 *
 * DEBTORS / CREDITORS = gross (full invoice amount inc. VAT)
 * REVENUE / EXPENSE   = net
 * VAT_OUTPUT / VAT_INPUT = VAT portion (omitted when vat is zero)
 */
export function expandToPostingLines(
  submission: TransactionSubmission,
  mappings: MappingRow[],
): PostingLine[] {
  const grossAmount = new Decimal(submission.amount!);
  const { transaction_type, tax_code, account_code } = submission;

  const isVatBearing =
    transaction_type === 'CUSTOMER_INVOICE' ||
    transaction_type === 'SUPPLIER_INVOICE' ||
    transaction_type === 'CUSTOMER_CREDIT_NOTE' ||
    transaction_type === 'SUPPLIER_CREDIT_NOTE';

  const { net, vat } = isVatBearing
    ? splitGrossAmount(grossAmount, tax_code)
    : { net: grossAmount, vat: new Decimal(0) };

  const lines: PostingLine[] = [];

  for (const mapping of mappings) {
    let lineAmount: Decimal;

    if (isVatBearing) {
      if (mapping.line_role === 'DEBTORS' || mapping.line_role === 'CREDITORS') {
        lineAmount = grossAmount;
      } else if (mapping.line_role === 'VAT_OUTPUT' || mapping.line_role === 'VAT_INPUT') {
        if (vat.isZero()) continue;   // omit VAT line when no VAT applies
        lineAmount = vat;
      } else {
        lineAmount = net;
      }
    } else {
      lineAmount = grossAmount;
    }

    // Override EXPENSE or REVENUE account when account_code is provided
    let effectiveAccountCode = mapping.account_code;
    if (account_code && (mapping.line_role === 'EXPENSE' || mapping.line_role === 'REVENUE')) {
      effectiveAccountCode = account_code;
    }

    const amount = lineAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toNumber();

    lines.push({
      account_code: effectiveAccountCode,
      description: mapping.description ?? `${transaction_type} — ${mapping.line_role}`,
      debit: mapping.direction === 'DEBIT' ? amount : 0,
      credit: mapping.direction === 'CREDIT' ? amount : 0,
    });
  }

  return lines;
}
