/**
 * extractors/order-id.js
 *
 * Extracts the Amazon order ID from an order card element on the orders list page.
 *
 * Amazon order IDs always follow the pattern: 3 digits - 7 digits - 7 digits
 * Example: "404-5826165-9042763" or "171-8280466-8238758"
 *
 * Three strategies are tried in order:
 *   1. Look for the dedicated ".yohtmlc-order-id" element (the most reliable way)
 *   2. Look for a "data-order-id" attribute on the card itself
 *   3. Search all text in the card for the order ID pattern (most resilient fallback)
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Extracts the order ID from an order card DOM element.
 *
 * @param {Element} element - An order card element from the Amazon orders list page
 * @returns {string|null} The order ID string (e.g. "404-5826165-9042763"), or null if not found
 */
window.AmazonExporter.extractors.extractOrderId = function extractOrderId(element) {
  // Guard: if no element was passed in, return null immediately
  if (!element) return null;

  const PATTERNS = window.AmazonExporter.PATTERNS;

  // ── Strategy 1: Dedicated order ID element ────────────────────────────────
  // Amazon places the order ID in an element with the class .yohtmlc-order-id
  // This is the most direct way and works on most pages.
  try {
    const idEl = element.querySelector('.yohtmlc-order-id');
    if (idEl) {
      const { safeText } = window.AmazonExporter.domHelpers;
      // The text might be "Order #404-5826165-9042763" or just "404-5826165-9042763"
      // Run it through the regex to extract just the ID portion
      const match = safeText(idEl).match(PATTERNS.orderIdRegex);
      if (match) return match[1];
    }
  } catch (err) {
    console.warn('[AmazonExporter] extractOrderId: Strategy 1 (querySelector) failed', err);
  }

  // ── Strategy 2: data-order-id attribute on the card element ───────────────
  // Some card variants store the order ID directly as an HTML data attribute.
  try {
    const attrValue = element.dataset && element.dataset.orderId;
    if (attrValue) {
      const match = attrValue.match(PATTERNS.orderIdRegex);
      if (match) return match[1];
    }
  } catch (err) {
    console.warn('[AmazonExporter] extractOrderId: Strategy 2 (dataset) failed', err);
  }

  // ── Strategy 3: Regex scan on all text inside the card ────────────────────
  // If the above two fail (e.g. Amazon changes its class names), we fall back
  // to scanning the entire text content of the card for the order ID pattern.
  try {
    const fullText = element.innerText || element.textContent || '';
    const match = fullText.match(PATTERNS.orderIdRegex);
    if (match) return match[1];
  } catch (err) {
    console.warn('[AmazonExporter] extractOrderId: Strategy 3 (regex scan) failed', err);
  }

  // All strategies exhausted — order ID not found
  console.warn('[AmazonExporter] extractOrderId: Could not find order ID in element', element);
  return null;
};
