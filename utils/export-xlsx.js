/**
 * utils/export-xlsx.js
 *
 * Turns the scraped Amazon order data into a downloadable Excel file (.xlsx).
 *
 * HOW IT WORKS
 * ------------
 * 1. Receives all scraped rows + any errors from the background service worker.
 * 2. Builds three Excel sheets:
 *    - "Orders"  — one row per item (the main data)
 *    - "Summary" — quick stats (total orders, date range, etc.)
 *    - "Errors"  — any fields that couldn't be read (only included when errors exist)
 * 3. Triggers a browser download of the finished .xlsx file.
 *
 * REQUIREMENTS
 * ------------
 * - SheetJS (window.XLSX) must be loaded before this script runs.
 * - No import/require — plain browser JavaScript only.
 * - Runs as an injected content script inside an Amazon.ae tab.
 *
 * USAGE
 * -----
 *   const result = window.AmazonExporter.exportToExcel({ rows, errors });
 *   // result: { success: true, filename: "amazon-orders-YYYY-MM-DD.xlsx", rowCount: N }
 *   // or on failure: { success: false, error: "description" }
 */

// ─── Namespace setup ────────────────────────────────────────────────────────
// Attach to window.AmazonExporter so other scripts can call us easily.
window.AmazonExporter = window.AmazonExporter || {};

// ─── Constants ──────────────────────────────────────────────────────────────

/** Column headers for the Orders sheet, in display order. */
const ORDERS_HEADERS = [
  'Order ID',
  'Order Date',
  'Item Description',
  'Pack Size',
  'Quantity',
  'Unit Price',
  'Line Total',
  'Payment Method',
  'Shipment Status',
  'Order Type',
  'Seller',
  'Data Source',
];

/**
 * Column widths (in character units) for the Orders sheet.
 * The order matches ORDERS_HEADERS exactly.
 */
const ORDERS_COL_WIDTHS = [
  { wch: 22 }, // Order ID
  { wch: 15 }, // Order Date
  { wch: 50 }, // Item Description
  { wch: 12 }, // Pack Size
  { wch: 10 }, // Quantity
  { wch: 12 }, // Unit Price
  { wch: 12 }, // Line Total
  { wch: 25 }, // Payment Method
  { wch: 22 }, // Shipment Status
  { wch: 15 }, // Order Type
  { wch: 25 }, // Seller
  { wch: 12 }, // Data Source
];

/** Column headers for the Errors sheet. */
const ERRORS_HEADERS = ['Order ID', 'Field', 'Error', 'Raw Value'];

// ─── Helper: format a Date as "DD Month YYYY" ───────────────────────────────

/**
 * Formats a JavaScript Date object into a human-readable string.
 * Example: new Date('2024-03-15') → "15 March 2024"
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateLong(date) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const day   = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year  = date.getFullYear();
  return `${day} ${month} ${year}`;
}

/**
 * Formats a JavaScript Date object as "YYYY-MM-DD".
 * Used for the filename.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateISO(date) {
  const year  = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day   = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─── Helper: derive date range from rows ────────────────────────────────────

/**
 * Scans all rows for their orderDate field and returns the earliest and latest
 * dates as formatted strings.  Dates that can't be parsed are skipped.
 *
 * @param {Object[]} rows - Array of scraped item row objects.
 * @returns {{ earliest: string, latest: string }}
 */
function getDateRange(rows) {
  const timestamps = rows
    .map((r) => (r.orderDate ? new Date(r.orderDate).getTime() : NaN))
    .filter((t) => !isNaN(t));

  if (timestamps.length === 0) {
    return { earliest: 'N/A', latest: 'N/A' };
  }

  const earliestDate = new Date(Math.min(...timestamps));
  const latestDate   = new Date(Math.max(...timestamps));

  return {
    earliest: formatDateLong(earliestDate),
    latest:   formatDateLong(latestDate),
  };
}

// ─── Sheet builders ──────────────────────────────────────────────────────────

/**
 * Builds the "Orders" worksheet — one row per scraped item.
 *
 * @param {Object[]} rows - Array of scraped item row objects.
 * @returns {Object} SheetJS worksheet object
 */
function buildOrdersSheet(rows) {
  // Start with the header row, then add one data row per item.
  const data = [
    ORDERS_HEADERS,
    ...rows.map((r) => [
      r.orderId           ?? '',
      r.orderDate         ?? '',
      r.itemDescription   ?? '',
      r.packSize          ?? '',
      r.quantity          ?? '',
      r.unitPrice         ?? '',   // kept as number for Excel maths
      r.lineTotal         ?? '',   // kept as number for Excel maths
      r.paymentMethod     ?? '',
      r.shipmentStatus    ?? '',
      r.orderType         ?? '',
      r.seller            ?? '',
      r.dataSource        ?? '',
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Apply column widths so the sheet is readable without manual resizing.
  ws['!cols'] = ORDERS_COL_WIDTHS;

  return ws;
}

/**
 * Builds the "Summary" worksheet — a simple key/value table of statistics.
 *
 * @param {Object[]} rows   - Array of scraped item row objects.
 * @param {Date}     today  - The current date (used for "Scrape Date").
 * @returns {Object} SheetJS worksheet object
 */
function buildSummarySheet(rows, today) {
  // Count unique order IDs.
  const uniqueOrderIds = new Set(rows.map((r) => r.orderId).filter(Boolean));
  const totalOrders    = uniqueOrderIds.size;
  const totalItems     = rows.length;

  const { earliest, latest } = getDateRange(rows);
  const dateRangeStr = earliest === 'N/A' ? 'N/A' : `${earliest} – ${latest}`;

  const data = [
    ['Metric',        'Value'],                          // header row
    ['Total Orders',  totalOrders],
    ['Total Items',   totalItems],
    ['Date Range',    dateRangeStr],
    ['Region',        'Amazon.ae'],
    ['Scrape Date',   formatDateLong(today)],
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Give the two columns a sensible width.
  ws['!cols'] = [{ wch: 18 }, { wch: 50 }];

  return ws;
}

/**
 * Builds the "Errors" worksheet — one row per extraction error.
 * Only call this when there is at least one error.
 *
 * @param {Object[]} errors - Array of { orderId, field, error, rawValue }.
 * @returns {Object} SheetJS worksheet object
 */
function buildErrorsSheet(errors) {
  const data = [
    ERRORS_HEADERS,
    ...errors.map((e) => [
      e.orderId  ?? '',
      e.field    ?? '',
      e.error    ?? '',
      e.rawValue ?? '',
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Column widths for the Errors sheet.
  ws['!cols'] = [
    { wch: 22 }, // Order ID
    { wch: 20 }, // Field
    { wch: 50 }, // Error
    { wch: 40 }, // Raw Value
  ];

  return ws;
}

// ─── Main export function ────────────────────────────────────────────────────

/**
 * exportToExcel(data)
 *
 * Takes all scraped order data and downloads it as a formatted Excel file.
 *
 * @param {Object}   data            - The payload from the background service worker.
 * @param {Object[]} data.rows       - Scraped item rows (one per item, not per order).
 * @param {Object[]} data.errors     - Extraction errors (may be an empty array).
 *
 * @returns {{ success: true,  filename: string, rowCount: number }}
 *       or {{ success: false, error: string }}
 *
 * EXAMPLE
 * -------
 *   const result = window.AmazonExporter.exportToExcel({
 *     rows:   [...],   // from the agent pipeline
 *     errors: [...],   // from agent4-validator
 *   });
 *   console.log(result);
 *   // { success: true, filename: "amazon-orders-2024-03-15.xlsx", rowCount: 42 }
 */
window.AmazonExporter.exportToExcel = function exportToExcel(data) {
  console.log('[AmazonExporter] exportToExcel() called.');

  try {
    // ── 0. Guard: make sure SheetJS is available ─────────────────────────
    if (typeof window.XLSX === 'undefined') {
      const msg = 'SheetJS (window.XLSX) is not loaded. Cannot create Excel file.';
      console.error('[AmazonExporter]', msg);
      return { success: false, error: msg };
    }

    // ── 1. Validate input ─────────────────────────────────────────────────
    const rows   = Array.isArray(data && data.rows)   ? data.rows   : [];
    const errors = Array.isArray(data && data.errors) ? data.errors : [];

    if (rows.length === 0) {
      console.warn('[AmazonExporter] No rows provided — the Excel file will have headers only.');
    }

    console.log(`[AmazonExporter] Building workbook: ${rows.length} item rows, ${errors.length} errors.`);

    // ── 2. Build worksheets ───────────────────────────────────────────────
    const today = new Date();

    const wsOrders  = buildOrdersSheet(rows);
    const wsSummary = buildSummarySheet(rows, today);

    // ── 3. Assemble workbook ──────────────────────────────────────────────
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, wsOrders,  'Orders');
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // Only add the Errors sheet if there is actually something to show.
    if (errors.length > 0) {
      const wsErrors = buildErrorsSheet(errors);
      XLSX.utils.book_append_sheet(wb, wsErrors, 'Errors');
      console.log(`[AmazonExporter] Errors sheet included (${errors.length} rows).`);
    } else {
      console.log('[AmazonExporter] No errors — Errors sheet omitted.');
    }

    // ── 4. Serialise to binary array ──────────────────────────────────────
    const arrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

    // ── 5. Create a downloadable Blob and trigger the save dialog ─────────
    const blob     = new Blob([arrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url      = URL.createObjectURL(blob);
    const filename = `amazon-orders-${formatDateISO(today)}.xlsx`;

    // Create a hidden <a> element, click it, then clean up.
    const anchor        = document.createElement('a');
    anchor.href         = url;
    anchor.download     = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    // Revoke the object URL to free memory (safe to do right after the click
    // because the browser has already queued the download).
    URL.revokeObjectURL(url);

    console.log(`[AmazonExporter] Download triggered: ${filename} (${rows.length} item rows).`);

    // ── 6. Return success payload ─────────────────────────────────────────
    return {
      success:  true,
      filename: filename,
      rowCount: rows.length,
    };

  } catch (err) {
    // Something unexpected went wrong — log it and return a safe error object
    // so the caller can show a friendly message to the user.
    const msg = err && err.message ? err.message : String(err);
    console.error('[AmazonExporter] exportToExcel() failed:', msg);
    return { success: false, error: msg };
  }
};

console.log('[AmazonExporter] export-xlsx.js loaded. Call window.AmazonExporter.exportToExcel(data) to export.');
