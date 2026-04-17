/**
 * extractors/shipment-status.js
 *
 * Extracts the delivery / shipment status for an order or shipment group.
 *
 * Works with TWO input types (dual-path):
 *
 *   API path (Amazon Now orders):
 *     Source is the `milestoneData` object from getOrderDetails API.
 *     It contains an `orderStatusEnum` string like "DELIVERED" or "CANCELLED".
 *     These are mapped to human-readable labels.
 *
 *   DOM path (Regular Amazon + Lulu print pages):
 *     Source is a DOM element (the print page container or a shipment group).
 *     The page uses headings (h1–h5) or bold text to show the delivery status,
 *     e.g. "Delivered on 11 April at 2:54 PM" or "Order canceled".
 *     We find the first heading that contains a known status keyword.
 *
 * Returns a string status label, or 'Unknown' if nothing is found.
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Extracts the shipment/delivery status from API milestone data or a DOM element.
 *
 * @param {Object|Element} source
 *   - API: a `milestoneData` object with `.orderStatusEnum` string
 *   - DOM: a DOM Element or Document representing the print page (or a shipment section)
 * @returns {string} Status label (e.g. "Delivered", "Cancelled"), or 'Unknown'
 */
window.AmazonExporter.extractors.extractShipmentStatus = function extractShipmentStatus(source) {
  // Guard
  if (!source) return 'Unknown';

  const PATTERNS           = window.AmazonExporter.PATTERNS;
  const { normalizeWhitespace } = window.AmazonExporter.domHelpers;

  // ── API path: source has orderStatusEnum ─────────────────────────────────
  // Amazon Now API returns a machine-readable status code. Map it to a friendly label.
  if (typeof source.orderStatusEnum === 'string') {
    // Use the statusMap from patterns.js
    const statusMap = PATTERNS.nowApi.statusMap;
    const enumValue = source.orderStatusEnum;

    if (statusMap[enumValue]) {
      return statusMap[enumValue];
    }

    // Status code not in our map — return the raw value as a fallback
    // (still useful for the user rather than "Unknown")
    console.warn(`[AmazonExporter] extractShipmentStatus: Unrecognised API status "${enumValue}"`);
    return enumValue;
  }

  // ── DOM path: source is a DOM Element or Document ─────────────────────────
  // Amazon print pages show delivery status in heading elements (h1–h5) or bold text.
  // Example: <h3>Delivered on 11 April at 2:54 PM</h3>
  //          <h3>Order canceled</h3>
  if (source instanceof Element || source instanceof Document || source.nodeType) {
    const root = (source instanceof Document) ? source.documentElement : source;

    const statusKeywords = PATTERNS.printPage.statusKeywords;

    // ── Strategy 1: Check all heading elements (h1–h5) ────────────────────
    // Delivery statuses are almost always in heading tags on print pages
    try {
      const headings = root.querySelectorAll('h1, h2, h3, h4, h5');
      for (const heading of headings) {
        const text = normalizeWhitespace(heading.innerText || heading.textContent || '');
        if (text.length === 0) continue;

        const textLower = text.toLowerCase();
        // Check if this heading contains any of the known status keywords
        const matched = statusKeywords.some(keyword => textLower.includes(keyword.toLowerCase()));
        if (matched) return text;
      }
    } catch (err) {
      console.warn('[AmazonExporter] extractShipmentStatus: Heading search failed', err);
    }

    // ── Strategy 2: Check bold and strong elements ─────────────────────────
    // Some page layouts use <b> or <strong> instead of headings for status text
    try {
      const boldEls = root.querySelectorAll('b, strong');
      for (const el of boldEls) {
        const text = normalizeWhitespace(el.innerText || el.textContent || '');
        if (text.length === 0) continue;

        const textLower = text.toLowerCase();
        const matched   = statusKeywords.some(keyword => textLower.includes(keyword.toLowerCase()));
        if (matched) return text;
      }
    } catch (err) {
      console.warn('[AmazonExporter] extractShipmentStatus: Bold element search failed', err);
    }

    // ── Strategy 3: Scan ALL text nodes for status keywords ───────────────
    // Last resort: walk every text node and look for a status keyword match.
    // This handles unusual layouts where status is in a plain <div> or <span>.
    try {
      // Skip text nodes inside <script>/<style>/<noscript>. Lulu's UFPO printable
      // page embeds a `milestone-constants` state blob containing literal
      // "DELIVERED":"DELIVERED" strings that would otherwise match status keywords.
      const ownerDoc = root.ownerDocument || document;
      const walker = ownerDoc.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const tag = node.parentNode && node.parentNode.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let textNode;
      while ((textNode = walker.nextNode())) {
        const text      = normalizeWhitespace(textNode.textContent || '');
        if (text.length < 4) continue;  // Skip very short text nodes

        const textLower = text.toLowerCase();
        const matched   = statusKeywords.some(keyword => textLower.includes(keyword.toLowerCase()));
        if (matched) return text;
      }
    } catch (err) {
      console.warn('[AmazonExporter] extractShipmentStatus: Text node scan failed', err);
    }
  }

  // Could not determine status
  return 'Unknown';
};

/**
 * Normalizes a free-form status string to one of five canonical values:
 *   'Delivered' | 'Cancelled' | 'Returned' | 'Refunded' | 'In-progress' | 'Unknown'
 *
 * Keyword rules (checked in priority order — terminal states first):
 *   - "cancel"           → Cancelled   (e.g. "Order canceled", "Cancelled")
 *   - "return window"    → Delivered   (window-closed means it was delivered)
 *   - "return"           → Returned    (e.g. "Return complete", "Return received")
 *   - "refund"           → Refunded    (e.g. "Refund issued", "Refunded (1)")
 *   - "delivered"        → Delivered   (past tense — "Delivered on 12 March")
 *   - "out for deliv"    → In-progress (Out for delivery)
 *   - "in transit"       → In-progress
 *   - "arriv"            → In-progress (Arriving / Arrives)
 *   - "preparing"        → In-progress
 *   - "shipped"          → In-progress
 *   - "packed"           → In-progress
 *   - "dispatch"         → In-progress (Dispatched / Not yet dispatched)
 *   - "confirm"          → In-progress (Confirmed)
 *   - "placed"           → In-progress (Order placed)
 *   - "ordered"          → In-progress
 *   - "processing"       → In-progress
 *   - "pending"          → In-progress
 *   - "scheduled"        → In-progress
 *   - anything else      → Unknown
 *
 * The past-tense "delivered" check is deliberate so strings like
 * "Out for delivery" (present progressive) do NOT collapse to "Delivered" —
 * they fall through to the in-flight rules below.
 *
 * @param {string} raw   Free-form status text from a list page, print page, or API.
 * @returns {string}     One of the canonical values listed above.
 */
window.AmazonExporter.extractors.normalizeShipmentStatus = function normalizeShipmentStatus(raw) {
  if (!raw) return 'Unknown';
  const s = String(raw).toLowerCase().trim();
  if (!s) return 'Unknown';

  // Terminal states (most specific first)
  if (s.includes('cancel'))        return 'Cancelled';
  if (s.includes('return window')) return 'Delivered';
  if (s.includes('return'))        return 'Returned';
  if (s.includes('refund'))        return 'Refunded';
  if (s.includes('delivered'))     return 'Delivered';

  // In-flight states
  if (s.includes('out for deliv')) return 'In-progress';
  if (s.includes('in transit'))    return 'In-progress';
  if (s.includes('arriv'))         return 'In-progress';
  if (s.includes('preparing'))     return 'In-progress';
  if (s.includes('shipped'))       return 'In-progress';
  if (s.includes('packed'))        return 'In-progress';
  if (s.includes('dispatch'))      return 'In-progress';
  if (s.includes('confirm'))       return 'In-progress';
  if (s.includes('placed'))        return 'In-progress';
  // Intentionally NOT matching bare "ordered" — it would catch date labels
  // like "Ordered on Wednesday, 9 July 2025" that Lulu cards render in the
  // secondary-text slot. Real API statuses use "PLACED"/"Order placed".
  if (s.includes('processing'))    return 'In-progress';
  if (s.includes('pending'))       return 'In-progress';
  if (s.includes('scheduled'))     return 'In-progress';

  return 'Unknown';
};
