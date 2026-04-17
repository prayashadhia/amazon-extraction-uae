/**
 * extractors/order-type.js
 *
 * Detects the ORDER TYPE from an order card on the orders list page.
 *
 * IMPORTANT: Order ID prefixes (404, 171) are NOT reliable for type detection.
 *   - A 404-prefix order can be Regular Amazon OR Lulu
 *   - A 171-prefix order can be Regular Amazon OR Amazon Now
 * Type MUST be determined by looking at the badge/logo on the order card.
 *
 * Returns one of three string values:
 *   'AMAZON_NOW' — delivered by Amazon Now (quick-commerce)
 *   'LULU'       — delivered by LuLu hypermarket
 *   'REGULAR'    — standard Amazon order (default)
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Determines the order type from an order card element.
 *
 * @param {Element} element - An order card element from the Amazon orders list page
 * @returns {'AMAZON_NOW'|'LULU'|'REGULAR'} The detected order type
 */
window.AmazonExporter.extractors.extractOrderType = function extractOrderType(element) {
  // Guard: if nothing was passed in, assume regular
  if (!element) return 'REGULAR';

  const PATTERNS = window.AmazonExporter.PATTERNS;

  // ── Check for Amazon Now badge ────────────────────────────────────────────
  // Amazon Now orders show a specific brand image with a known alt text.
  // This is the most reliable signal available on the orders list page.
  try {
    const nowBadge = element.querySelector(PATTERNS.ordersList.amazonNowBadge);
    if (nowBadge) return 'AMAZON_NOW';
  } catch (err) {
    console.warn('[AmazonExporter] extractOrderType: Amazon Now badge check failed', err);
  }

  // ── Check for LuLu badge or heading text ─────────────────────────────────
  // Lulu orders have a green/red Lulu logo image at the bottom of the card.
  // Additionally, the heading text may say "LuLu delivery".
  try {
    // Check 1: look for the Lulu brand image by its alt text
    const luluBadge = element.querySelector(PATTERNS.ordersList.luluBadge);
    if (luluBadge) return 'LULU';

    // Check 2: look for any img whose alt text contains "LuLu" (case-sensitive match)
    const allImages = element.querySelectorAll('img[alt]');
    for (const img of allImages) {
      if (img.alt.includes('LuLu')) return 'LULU';
    }

    // Check 3: look for the "LuLu delivery" heading text anywhere in the card
    const { safeText } = window.AmazonExporter.domHelpers;
    if (safeText(element).includes(PATTERNS.ordersList.luluHeadingText)) return 'LULU';
  } catch (err) {
    console.warn('[AmazonExporter] extractOrderType: LuLu badge check failed', err);
  }

  // ── Default: Regular Amazon order ────────────────────────────────────────
  // No special badge found — treat as a standard Amazon order.
  return 'REGULAR';
};
