/**
 * extractors/price.js
 *
 * Extracts the UNIT PRICE and LINE TOTAL for a single item.
 *
 * Works with TWO input types (dual-path):
 *
 *   API path (Amazon Now orders):
 *     Source is a plain object from getOrderDetails.orderItems[].
 *     Uses the `totalOfferPrice.amount` field — this is the actual price paid
 *     per unit (after any discounts). Line total = unit price × quantity.
 *
 *   DOM path (Regular Amazon + Lulu print pages):
 *     Source is a DOM element (a product row).
 *     Amazon print pages show TWO price elements per item:
 *       First  = unit price  (price for one unit)
 *       Second = line total  (unit price × quantity)
 *     If quantity is 1, both values will be identical.
 *     Lulu pages show only ONE price (the line total).
 *
 * Returns: { unitPrice: number, lineTotal: number }
 *   Both values are plain numbers (e.g. 45.00), NOT strings.
 *   Returns { unitPrice: null, lineTotal: null } if no prices are found.
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Extracts unit price and line total from an API item object or DOM element.
 *
 * @param {Object|Element} source
 *   - API: a plain object from orderItems[] (has totalOfferPrice, quantity, etc.)
 *   - DOM: a DOM element representing the product row on a print page
 * @returns {{ unitPrice: number|null, lineTotal: number|null }}
 */
window.AmazonExporter.extractors.extractPrices = function extractPrices(source) {
  // Guard: nothing to work with
  if (!source) return { unitPrice: null, lineTotal: null };

  const { parseAEPrice } = window.AmazonExporter.domHelpers;
  const PATTERNS = window.AmazonExporter.PATTERNS;

  // ── API path: source is a plain JavaScript object ─────────────────────────
  // The Amazon Now API provides structured price data — no parsing needed.
  if (source.totalOfferPrice !== undefined || source.buyingPrice !== undefined) {
    try {
      let unitPrice = null;

      // Prefer totalOfferPrice (actual price paid, after discounts)
      if (source.totalOfferPrice && typeof source.totalOfferPrice.amount === 'number') {
        unitPrice = source.totalOfferPrice.amount;
      }
      // Fall back to buyingPrice if totalOfferPrice is missing
      else if (source.buyingPrice && typeof source.buyingPrice.amount === 'number') {
        unitPrice = source.buyingPrice.amount;
      }

      if (unitPrice === null) {
        return { unitPrice: null, lineTotal: null };
      }

      // Line total = unit price × quantity
      // quantity defaults to 1 if not available
      const quantity  = (typeof source.quantity === 'number' && source.quantity > 0)
                        ? source.quantity
                        : 1;
      const lineTotal = parseFloat((unitPrice * quantity).toFixed(2));

      return { unitPrice, lineTotal };

    } catch (err) {
      console.warn('[AmazonExporter] extractPrices: API path error', err);
      return { unitPrice: null, lineTotal: null };
    }
  }

  // ── DOM path: source is a DOM Element ─────────────────────────────────────
  // We scan every text node in the row for AED price patterns.
  // The FIRST price found = unit price; the SECOND = line total.
  if (!(source instanceof Element || source.nodeType === 1)) {
    console.warn('[AmazonExporter] extractPrices: Input is neither API object nor DOM element');
    return { unitPrice: null, lineTotal: null };
  }

  try {
    const prices = [];

    // Use a TreeWalker to visit every text node inside the row element
    const walker = document.createTreeWalker(
      source,
      NodeFilter.SHOW_TEXT,
      null
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent || '';

      // Check if this text node contains an AED price
      const match = text.match(PATTERNS.price.aedPriceRegex);
      if (match) {
        // parseAEPrice handles commas, currency codes, whitespace
        const parsed = parseAEPrice(text);
        if (parsed !== null && parsed >= 0) {
          prices.push(parsed);
          // We only need at most 2 prices (unit + line total)
          if (prices.length === 2) break;
        }
      }
    }

    // Interpret the collected prices
    if (prices.length === 0) {
      // No prices found anywhere in the row
      return { unitPrice: null, lineTotal: null };
    }

    if (prices.length === 1) {
      // Only one price (e.g. Lulu pages only show line total)
      // Use it for both — quantity.js will derive from context
      return { unitPrice: prices[0], lineTotal: prices[0] };
    }

    // Two prices found: first = unit price, second = line total
    return { unitPrice: prices[0], lineTotal: prices[1] };

  } catch (err) {
    console.warn('[AmazonExporter] extractPrices: DOM path error', err);
    return { unitPrice: null, lineTotal: null };
  }
};
