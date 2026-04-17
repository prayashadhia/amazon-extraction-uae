/**
 * agents/agent4-validator.js
 *
 * AGENT 4: VALIDATOR
 *
 * This agent takes the raw extracted rows from Agent 3 and checks them for
 * problems before they are written to the Excel file.
 *
 * What it does:
 *   1. Applies automatic fixes for minor, predictable issues (e.g. null → defaults)
 *   2. Validates each field against rules (e.g. order ID must match the right pattern)
 *   3. Separates rows that are too broken to export (errorRows) from rows that are
 *      good enough to include (validRows)
 *   4. Collects detailed error records for the "Errors" sheet in the export
 *
 * IMPORTANT: The validator NEVER throws. It always returns something.
 * If the input is completely broken, it returns { validRows: [], errorRows: [] }.
 *
 * OUTPUT MESSAGE:
 *   Sends chrome.runtime.sendMessage({ action: 'VALIDATOR_COMPLETE', data: { ... } })
 *   Also returns { validRows, errorRows } directly.
 *
 * Dependencies (already loaded by the time this runs):
 *   window.AmazonExporter.PATTERNS
 */

// Attach to the shared namespace — never overwrite existing parts
window.AmazonExporter = window.AmazonExporter || {};

/**
 * Validates and cleans all extracted rows, separating good rows from broken ones.
 *
 * @param {Object[]} rows - Array of unified item row objects from Agent 3.
 *   Each row has the shape described in the Unified Item Row spec.
 *
 * @returns {{ validRows: Object[], errorRows: Object[] }}
 *   validRows  — rows ready for export (passed validation or were auto-fixed)
 *   errorRows  — error records to include in the "Errors" sheet of the Excel file
 */
function runValidator(rows) {
  const LOG = '[AmazonExporter Agent4]';

  // ──────────────────────────────────────────────────────────────────────────
  // Safety check: if input is not an array, return empty results immediately.
  // This protects against being called with bad data from the background worker.
  // ──────────────────────────────────────────────────────────────────────────
  if (!Array.isArray(rows)) {
    console.error(`${LOG} runValidator called with non-array input:`, typeof rows);
    return { validRows: [], errorRows: [] };
  }

  console.log(`${LOG} Validating ${rows.length} extracted row(s)...`);

  // ─── Constants ────────────────────────────────────────────────────────────
  // These are the accepted values for certain fields
  const VALID_ORDER_TYPES  = ['Amazon Now', 'Regular Amazon', 'Lulu'];
  const VALID_DATA_SOURCES = ['API', 'DOM', 'List page'];

  // Order IDs must follow the pattern: 3 digits - 7 digits - 7 digits
  // Examples: "404-5826165-9042763", "171-8280466-8238758"
  const ORDER_ID_REGEX = /^\d{3}-\d{7}-\d{7}$/;

  // Maximum sensible values — anything above these is suspicious
  const MAX_UNIT_PRICE = 50000;    // AED 50,000 — catching runaway prices
  const MAX_QUANTITY   = 999;      // More than 999 of one item is unusual

  // Today's date — used to catch order dates in the future (data corruption sign)
  const TODAY = new Date();
  TODAY.setHours(23, 59, 59, 999); // End of today

  // ─── Accumulators ─────────────────────────────────────────────────────────
  const validRows = [];    // Rows that pass (or were auto-fixed)
  const errorRows = [];    // Error objects for the Errors sheet
  let   warnCount = 0;     // Rows with warnings (kept but flagged)
  let   failCount = 0;     // Rows removed from validRows due to fatal errors

  // ─── Helper: record an error ───────────────────────────────────────────────
  /**
   * Adds an error record to the errorRows array.
   * Does NOT automatically remove the row from validRows — callers do that.
   *
   * @param {string} orderId   - The order this error belongs to
   * @param {string} field     - Which field failed (e.g. 'quantity', 'unitPrice')
   * @param {string} error     - Human-readable description of the problem
   * @param {*}      rawValue  - The actual bad value (will be converted to string)
   */
  function addError(orderId, field, error, rawValue) {
    errorRows.push({
      orderId:  String(orderId  || ''),
      field:    String(field    || ''),
      error:    String(error    || ''),
      rawValue: String(rawValue === null || rawValue === undefined ? '' : rawValue)
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PROCESS EACH ROW
  // ──────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];

    // ── Handle rows marked as failed by Agent 3 ──────────────────────────────
    // Agent 3 sets _failed = true when both primary and fallback extraction failed.
    // These are recorded as errors but never added to validRows.
    if (raw._failed === true) {
      addError(
        raw.orderId || `row_${i}`,
        'extraction',
        `Extraction completely failed: ${raw._error || 'unknown error'}`,
        raw._error || ''
      );
      failCount++;
      continue;   // Skip to next row — do not add to validRows
    }

    // ── Make a working copy so we can modify it without touching the original ─
    const row = Object.assign({}, raw);

    // Track whether this row should be EXCLUDED from validRows (fatal error)
    let isFatal = false;

    // ─────────────────────────────────────────────────────────────────────────
    // AUTO-FIXES: apply silently before validation
    // These correct predictable minor issues that do not need user attention.
    // ─────────────────────────────────────────────────────────────────────────

    // Fix: null/undefined packSize → empty string
    if (row.packSize === null || row.packSize === undefined) {
      row.packSize = '';
    }

    // Fix: null/undefined seller → 'N/A'
    if (row.seller === null || row.seller === undefined || row.seller === '') {
      row.seller = 'N/A';
    }

    // Fix: null/undefined dataSource → 'DOM'
    if (row.dataSource === null || row.dataSource === undefined || row.dataSource === '') {
      row.dataSource = 'DOM';
    }

    // Fix: quantity null, undefined, or 0 → 1
    // (We always assume at least 1 unit was ordered — except for cancelled
    // orders, which legitimately have quantity 0 and no items shipped.)
    if ((!row.quantity || row.quantity === 0) && !row._cancelled) {
      if (row.quantity !== undefined) {
        // Only log if the field was present but wrong (not missing entirely)
        console.warn(
          `${LOG} Auto-fixed quantity for order ${row.orderId}: ` +
          `${row.quantity} → 1`
        );
        addError(
          row.orderId,
          'quantity',
          `Quantity was ${row.quantity} — auto-corrected to 1`,
          row.quantity
        );
        warnCount++;
      }
      row.quantity = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VALIDATION RULES
    // Run each rule. Fatal failures set isFatal = true so the row is excluded.
    // Warnings record an error but keep the row.
    // ─────────────────────────────────────────────────────────────────────────

    // ── RULE 1: orderId must match the standard pattern ───────────────────────
    // Format: 3 digits - 7 digits - 7 digits  (e.g. "171-8280466-8238758")
    const orderId = String(row.orderId || '').trim();
    if (!ORDER_ID_REGEX.test(orderId)) {
      addError(
        orderId || `row_${i}`,
        'orderId',
        `Order ID "${orderId}" does not match the expected format (e.g. 171-1234567-8901234)`,
        orderId
      );
      failCount++;
      isFatal = true;   // Cannot use a row with an invalid order ID
    }

    // ── RULE 2: orderDate must be a parseable date, not in the future ─────────
    if (!isFatal) {
      const dateStr  = String(row.orderDate || '').trim();
      const dateObj  = new Date(dateStr);
      const isValid  = dateStr.length > 0 && !isNaN(dateObj.getTime());

      if (!isValid) {
        // Date is unparseable — warn but keep the row
        addError(
          row.orderId,
          'orderDate',
          `Order date "${dateStr}" could not be parsed as a valid date`,
          dateStr
        );
        warnCount++;
        // Mark the row with a flag for the export to display
        row._dateWarning = true;
      } else if (dateObj > TODAY) {
        // Date is in the future — suspicious, flag it
        addError(
          row.orderId,
          'orderDate',
          `Order date "${dateStr}" is in the future (today is ${TODAY.toISOString().slice(0, 10)})`,
          dateStr
        );
        warnCount++;
        row._dateWarning = true;
      }
    }

    // ── RULE 3: itemDescription must be non-empty and longer than 3 characters ─
    if (!isFatal && !row._cancelled) {
      const desc = String(row.itemDescription || '').trim();
      if (desc.length === 0 || desc.length <= 3) {
        addError(
          row.orderId,
          'itemDescription',
          `Item description is missing or too short (got: "${desc}")`,
          desc
        );
        failCount++;
        isFatal = true;   // A row with no description is not useful to export
      }
    }

    // ── RULE 4: quantity must be a positive integer between 1 and 999 ──────────
    if (!isFatal && !row._cancelled) {
      const qty = row.quantity;   // Already auto-fixed to at least 1 above

      if (!Number.isInteger(qty)) {
        // Quantity should always be a whole number — try to round it
        const rounded = Math.round(qty);
        console.warn(`${LOG} Quantity for order ${row.orderId} is not an integer (${qty}) — rounding to ${rounded}`);
        addError(
          row.orderId,
          'quantity',
          `Quantity ${qty} is not a whole number — rounded to ${rounded}`,
          qty
        );
        warnCount++;
        row.quantity = rounded > 0 ? rounded : 1;
      } else if (qty < 1) {
        // Below 1 — fix to 1 (should have been caught by auto-fix above, but just in case)
        addError(
          row.orderId,
          'quantity',
          `Quantity ${qty} is less than 1 — auto-corrected to 1`,
          qty
        );
        warnCount++;
        row.quantity = 1;
      } else if (qty > MAX_QUANTITY) {
        // Unusually large quantity — flag it but keep the row
        addError(
          row.orderId,
          'quantity',
          `Quantity ${qty} is unusually high (over ${MAX_QUANTITY}) — please verify`,
          qty
        );
        warnCount++;
        row._quantityWarning = true;
      }
    }

    // ── RULE 5: unitPrice must be a positive number, not over AED 50,000 ──────
    if (!isFatal && !row._cancelled) {
      const price = row.unitPrice;

      if (price === null || price === undefined || typeof price !== 'number' || isNaN(price)) {
        // Price is missing or not a number — this row cannot be exported reliably
        addError(
          row.orderId,
          'unitPrice',
          `Unit price is missing or not a valid number (got: ${price})`,
          price
        );
        failCount++;
        isFatal = true;
      } else if (price < 0) {
        // Negative price — clearly wrong
        addError(
          row.orderId,
          'unitPrice',
          `Unit price is negative (${price}) — this is not valid`,
          price
        );
        failCount++;
        isFatal = true;
      } else if (price > MAX_UNIT_PRICE) {
        // Very high price — warn but keep the row (could be a luxury item)
        addError(
          row.orderId,
          'unitPrice',
          `Unit price AED ${price} is unusually high (over AED ${MAX_UNIT_PRICE}) — please verify`,
          price
        );
        warnCount++;
        row._priceWarning = true;
      }
    }

    // ── RULE 6: lineTotal should be approximately unitPrice × quantity ─────────
    // We allow up to AED 0.50 difference to account for rounding during extraction.
    if (!isFatal && typeof row.unitPrice === 'number' && typeof row.lineTotal === 'number') {
      const expectedTotal = parseFloat((row.unitPrice * row.quantity).toFixed(2));
      const actualTotal   = row.lineTotal;
      const difference    = Math.abs(expectedTotal - actualTotal);

      // AED 0.50 tolerance covers minor floating-point and rounding differences
      if (difference > 0.50) {
        addError(
          row.orderId,
          'lineTotal',
          `Line total AED ${actualTotal} does not match unit price × quantity ` +
          `(${row.unitPrice} × ${row.quantity} = AED ${expectedTotal}, ` +
          `difference: AED ${difference.toFixed(2)})`,
          actualTotal
        );
        warnCount++;
        row._totalWarning = true;
        // Keep the row — the discrepancy might be due to a discount or rounding
      }
    }

    // ── RULE 7: paymentMethod should be non-empty (except cancelled orders) ────
    if (!isFatal) {
      const payment       = String(row.paymentMethod || '').trim();
      const isCancelled   = String(row.shipmentStatus || '').toLowerCase().includes('cancel');

      if (payment.length === 0 && !isCancelled) {
        addError(
          row.orderId,
          'paymentMethod',
          'Payment method is empty (and order is not marked as cancelled)',
          payment
        );
        warnCount++;
        row._paymentWarning = true;
        // Keep the row — missing payment method is annoying but not fatal
      }
    }

    // ── RULE 8: orderType must be one of the three recognised types ────────────
    if (!isFatal) {
      const orderType = String(row.orderType || '').trim();
      if (!VALID_ORDER_TYPES.includes(orderType)) {
        addError(
          row.orderId,
          'orderType',
          `Unknown order type "${orderType}" — expected one of: ${VALID_ORDER_TYPES.join(', ')}`,
          orderType
        );
        warnCount++;
        row._typeWarning = true;
        // Keep the row — unexpected type is unusual but the data may still be valid
      }
    }

    // ── RULE 9: dataSource must be 'API' or 'DOM' ──────────────────────────────
    if (!isFatal) {
      const source = String(row.dataSource || '').trim();
      if (!VALID_DATA_SOURCES.includes(source)) {
        addError(
          row.orderId,
          'dataSource',
          `Unknown data source "${source}" — expected 'API' or 'DOM'`,
          source
        );
        warnCount++;
        row._sourceWarning = true;
        // Keep the row — wrong source tag doesn't make the data invalid
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FINAL DECISION: add the row to validRows or discard it
    // ─────────────────────────────────────────────────────────────────────────
    if (!isFatal) {
      validRows.push(row);
    }
    // If isFatal is true, the row is already counted in failCount and its error
    // is already in errorRows. We simply don't push it to validRows.
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STATS: summarise the results for logging and the VALIDATOR_COMPLETE message
  // ──────────────────────────────────────────────────────────────────────────
  const stats = {
    total:   rows.length,       // Total rows received
    passed:  validRows.length,  // Rows that made it through (includes warned rows)
    warned:  warnCount,         // Rows with non-fatal warnings
    failed:  failCount          // Rows that were removed due to fatal errors
  };

  console.log(
    `${LOG} Validation complete. ` +
    `Total: ${stats.total} | Passed: ${stats.passed} | ` +
    `Warnings: ${stats.warned} | Failed: ${stats.failed} | ` +
    `Error records: ${errorRows.length}`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // SEND MESSAGE: notify the background service worker that validation is done
  // ──────────────────────────────────────────────────────────────────────────
  try {
    chrome.runtime.sendMessage({
      action: 'VALIDATOR_COMPLETE',
      data: {
        validRows: validRows,
        errorRows: errorRows,
        stats:     stats
      }
    });
  } catch (msgErr) {
    // sendMessage can fail if the extension context was invalidated
    // (e.g. the extension was reloaded while this script was running).
    // This is not critical — we still return the data to the direct caller.
    console.warn(`${LOG} Could not send VALIDATOR_COMPLETE message: ${msgErr.message}`);
  }

  // Also return directly so callers can use the result synchronously
  return {
    validRows: validRows,
    errorRows: errorRows
  };
}

// Expose the function on the shared namespace so other scripts can call it directly
window.AmazonExporter.runValidator = runValidator;
