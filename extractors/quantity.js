/**
 * extractors/quantity.js
 *
 * Determines the quantity ordered for a single item.
 *
 * Quantity is handled DIFFERENTLY depending on the order source:
 *
 *   API path (Amazon Now):
 *     The JSON response includes an explicit `quantity` field. No calculation needed.
 *
 *   Lulu DOM path:
 *     The Lulu printable page has a proper table with a "Quantity" column.
 *     We read the cell at column index 2 (0-based) from the table row.
 *
 *   Regular Amazon DOM path:
 *     The print summary page does NOT show quantity explicitly.
 *     Instead, Amazon shows two prices per item: unit price and line total.
 *     We derive quantity by dividing: quantity = lineTotal / unitPrice
 *     If both prices are identical, quantity = 1.
 *
 * Always returns an integer ≥ 1. Never returns 0 or negative numbers.
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Determines the item quantity from any of three input types.
 *
 * @param {Object|Element} source - One of:
 *   - API object: has a numeric `.quantity` property (Amazon Now JSON)
 *   - TR element: a <tr> table row from the Lulu printable page
 *   - Price object: a plain object with `.unitPrice` and `.lineTotal` (Regular Amazon)
 * @returns {number} Integer quantity, minimum 1
 */
window.AmazonExporter.extractors.extractQuantity = function extractQuantity(source) {
  // Guard: default to 1 if nothing passed in
  if (!source) return 1;

  // ── API path: explicit quantity field ──────────────────────────────────────
  // Amazon Now JSON always provides an explicit quantity number.
  // We detect this path by checking if source.quantity is a number.
  if (typeof source.quantity === 'number') {
    const qty = Math.round(source.quantity);
    return qty > 0 ? qty : 1;
  }

  // ── Lulu DOM path: table row element ──────────────────────────────────────
  // The Lulu printable page uses an HTML table. Each item is a <tr> row.
  // Column layout (0-based index):
  //   0 = image
  //   1 = item name
  //   2 = quantity   ← we want this one
  //   3 = weight (always empty)
  //   4 = line total
  //
  // We detect this path by checking if the input is an HTML element (TR).
  if (source instanceof Element || source.nodeType === 1) {
    try {
      const cells = source.querySelectorAll('td');
      if (cells.length >= 3) {
        const qtyText = (cells[2].innerText || cells[2].textContent || '').trim();
        const parsed  = parseInt(qtyText, 10);
        if (!isNaN(parsed) && parsed > 0) {
          return parsed;
        }
      }
      // Quantity column was empty or unreadable — default to 1
      return 1;
    } catch (err) {
      console.warn('[AmazonExporter] extractQuantity: Lulu table row parsing failed', err);
      return 1;
    }
  }

  // ── Regular Amazon DOM path: derive from price comparison ─────────────────
  // When we have a { unitPrice, lineTotal } object, quantity is calculated as
  // lineTotal / unitPrice. If prices are equal (or nearly equal), quantity = 1.
  if (source.unitPrice !== undefined || source.lineTotal !== undefined) {
    const unitPrice = source.unitPrice;
    const lineTotal = source.lineTotal;

    // Cannot calculate without valid prices
    if (!unitPrice || unitPrice === 0 || unitPrice === null) return 1;
    if (!lineTotal || lineTotal === null) return 1;

    // If both prices are equal, the item was bought as a single unit
    if (unitPrice === lineTotal) return 1;

    // Divide line total by unit price to get quantity
    const computed = lineTotal / unitPrice;
    const rounded  = Math.round(computed);

    // Check how far the result is from a clean integer
    // A large remainder suggests a data issue (e.g. prices from different items
    // were accidentally paired together)
    const deviation = Math.abs(computed - rounded);
    if (deviation > 0.05) {
      console.warn(
        `[AmazonExporter] extractQuantity: Quantity calculation has high deviation ` +
        `(lineTotal=${lineTotal}, unitPrice=${unitPrice}, computed=${computed.toFixed(4)}). ` +
        `Using rounded value: ${rounded}`
      );
    }

    // Never return less than 1
    return rounded > 0 ? rounded : 1;
  }

  // Unrecognised input — safe default
  console.warn('[AmazonExporter] extractQuantity: Could not determine path from source', source);
  return 1;
};
