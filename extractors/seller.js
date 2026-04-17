/**
 * extractors/seller.js
 *
 * Extracts the seller name for a single item on the print page.
 *
 * Works with TWO input types (dual-path):
 *
 *   API path (Amazon Now orders):
 *     The Amazon Now API response does NOT include seller information.
 *     Always returns 'N/A' for API-sourced rows.
 *
 *   DOM path (Regular Amazon print pages):
 *     Regular Amazon print pages show "Sold by:" followed by a seller name link.
 *     Example: "Sold by: My Pharma Store" or "Sold by: Amazon.ae"
 *
 *     If "Sold by" text is NOT found (which happens for items fulfilled
 *     directly by Amazon), we default to 'Amazon.ae'.
 *
 *     Note: Lulu printable pages do NOT show seller info either.
 *           Lulu orders should be routed through the API path (return 'N/A')
 *           or callers should pass the Lulu DOM and expect 'N/A'.
 *
 * Returns a string seller name, or 'N/A' if not applicable.
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Extracts the seller name from an API item object or a DOM element (product row).
 *
 * @param {Object|Element} source
 *   - API: any plain object (API items don't have seller info — always returns 'N/A')
 *   - DOM: a DOM Element representing a product row on the Regular Amazon print page
 * @returns {string} Seller name (e.g. "My Pharma Store"), 'Amazon.ae', or 'N/A'
 */
window.AmazonExporter.extractors.extractSeller = function extractSeller(source) {
  // Guard
  if (!source) return 'N/A';

  const PATTERNS = window.AmazonExporter.PATTERNS;
  const { normalizeWhitespace, findTextNode } = window.AmazonExporter.domHelpers;

  // ── API path: plain object (Amazon Now) ───────────────────────────────────
  // The Amazon Now API does not expose seller information.
  // Lulu orders also have no seller info. Both cases return 'N/A'.
  // We detect this path by checking if the input is NOT a DOM element.
  const isDomElement = source instanceof Element || source.nodeType === 1;

  if (!isDomElement) {
    return 'N/A';
  }

  // ── DOM path: Element (Regular Amazon print page product row) ─────────────
  try {
    const soldByLabel = PATTERNS.printPage.soldByText;  // "Sold by"

    // ── Strategy 1: Find a text node containing "Sold by" ──────────────────
    // The print page pattern is:
    //   <generic>Sold by:</generic> <link>Seller Name</link>
    //   or just text "Sold by Seller Name" in the same element
    const soldByNode = findTextNode(source, soldByLabel);

    if (soldByNode) {
      // The seller name is usually in the NEXT sibling element after the label node
      // Walk up to the parent element to find sibling elements
      const parent = soldByNode.parentElement;

      if (parent) {
        // Strategy 1a: Look for a link inside or after the parent (seller name is often a link)
        const sellerLink = parent.querySelector('a');
        if (sellerLink) {
          const sellerText = normalizeWhitespace(sellerLink.innerText || sellerLink.textContent || '');
          if (sellerText.length > 0) return sellerText;
        }

        // Strategy 1b: Try the next sibling element of the parent
        const parentSibling = parent.nextElementSibling;
        if (parentSibling) {
          const siblingText = normalizeWhitespace(parentSibling.innerText || parentSibling.textContent || '');
          if (siblingText.length > 0) return siblingText;
        }

        // Strategy 1c: Read the parent text and strip the "Sold by" prefix
        const parentText = normalizeWhitespace(parent.innerText || parent.textContent || '');
        if (parentText.toLowerCase().startsWith(soldByLabel.toLowerCase())) {
          // Remove the "Sold by" or "Sold by:" prefix to get just the seller name
          const sellerText = parentText
            .slice(soldByLabel.length)  // Remove "Sold by" prefix
            .replace(/^[:.\s]+/, '')    // Remove any colon/dot/space after the label
            .trim();
          if (sellerText.length > 0) return sellerText;
        }
      }
    }

    // ── Strategy 2: Search all text nodes for "Sold by" pattern ─────────────
    // Catch any layout variations where findTextNode might miss it
    const allText = source.innerText || source.textContent || '';
    const soldByIndex = allText.toLowerCase().indexOf(soldByLabel.toLowerCase());

    if (soldByIndex !== -1) {
      // Extract the text after "Sold by" — take up to 80 chars to avoid grabbing too much
      const afterLabel = allText
        .slice(soldByIndex + soldByLabel.length)
        .replace(/^[:.\s]+/, '')   // Strip leading punctuation
        .trim();

      // Take just the first line (seller name shouldn't have newlines)
      const firstLine = afterLabel.split(/[\n\r]/)[0].trim();
      if (firstLine.length > 0 && firstLine.length <= 100) {
        return normalizeWhitespace(firstLine);
      }
    }

    // ── No "Sold by" text found ────────────────────────────────────────────
    // This is normal for items fulfilled directly by Amazon (no marketplace seller).
    // Default to 'Amazon.ae' to indicate Amazon is effectively the seller/fulfiller.
    return 'Amazon.ae';

  } catch (err) {
    console.warn('[AmazonExporter] extractSeller: DOM path error', err);
    return 'Amazon.ae';
  }
};
