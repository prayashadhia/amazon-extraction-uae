/**
 * extractors/order-date.js
 *
 * Extracts the order placement date from an order card on the orders list page.
 *
 * Amazon.ae shows dates in formats like:
 *   "13 April 2026"   (long format — most common)
 *   "13th April 2026" (with ordinal suffix)
 *   "13 Apr 2026"     (short month name)
 *
 * Returns the date as an ISO string: "YYYY-MM-DD" (e.g. "2026-04-13").
 * This format is easy to sort and import into Excel.
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Extracts the order date from an order card element OR a raw string.
 *
 * @param {Element|string} source - An order card element, or a raw date string
 *   (e.g. "14th April 2026 07:27 AM" from the Amazon Now API)
 * @returns {string|null} ISO date string "YYYY-MM-DD", or null if parsing fails
 */
window.AmazonExporter.extractors.extractOrderDate = function extractOrderDate(source) {
  // Guard: nothing to parse without a source
  if (!source) return null;

  const PATTERNS = window.AmazonExporter.PATTERNS;
  const { safeText } = window.AmazonExporter.domHelpers;

  // Accept either a DOM element or a raw string (from the API).
  const fullText = (typeof source === 'string') ? source : safeText(source);

  // ── Try long format: "13th April 2026" or "13 April 2026" ─────────────────
  // This regex captures: day (1-2 digits), optional ordinal suffix, month name, 4-digit year
  let match = fullText.match(PATTERNS.date.longFormatRegex);

  // ── Try short format: "13 Apr 2026" ──────────────────────────────────────
  // Fallback if the long format didn't match
  if (!match) {
    match = fullText.match(PATTERNS.date.shortFormatRegex);
  }

  if (!match) {
    console.warn('[AmazonExporter] extractOrderDate: No date pattern found in element text');
    return null;
  }

  // match[1] = day number (e.g. "13")
  // match[2] = month name (e.g. "April" or "Apr")
  // match[3] = year (e.g. "2026")
  const day       = parseInt(match[1], 10);
  const monthName = match[2].toLowerCase();
  const year      = parseInt(match[3], 10);

  // Convert month name to a number using the PATTERNS lookup table
  const monthNum = PATTERNS.date.months[monthName];

  if (!monthNum) {
    console.warn(`[AmazonExporter] extractOrderDate: Unrecognised month name "${match[2]}"`);
    return null;
  }

  // Validate the parsed values are sensible
  if (isNaN(day) || isNaN(year) || day < 1 || day > 31 || year < 2000) {
    console.warn(`[AmazonExporter] extractOrderDate: Parsed date values out of range (day=${day}, year=${year})`);
    return null;
  }

  // Format as "YYYY-MM-DD" with zero-padded month and day
  // e.g. day=3, month=4, year=2026  →  "2026-04-03"
  const mm = String(monthNum).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return `${year}-${mm}-${dd}`;
};
