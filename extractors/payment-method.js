/**
 * extractors/payment-method.js
 *
 * Extracts the payment method used for an order.
 *
 * Works with TWO input types (dual-path):
 *
 *   API path (Amazon Now orders):
 *     Source is the full orderDetailsResponse object from the getOrderDetails API.
 *     It contains a `paymentMethods` array with card type and issuing bank.
 *     Example output: "CREDIT_CARD — Emirates Islamic Bank EMI MC"
 *
 *   DOM path (Regular Amazon + Lulu print pages):
 *     Source is a Document or DOM element (the print page).
 *     The page has a "Payment method" section with the card name and last 4 digits.
 *     For cancelled orders, it shows "No current charges" instead.
 *     Example output: "Mastercard ending in 3148"
 *                  or "Visa ending in 5817"
 *                  or "No charge (cancelled)"
 *
 * Returns a string description, or '' if nothing can be found.
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Extracts the payment method from an API response object or print page DOM.
 *
 * @param {Object|Document|Element} source
 *   - API: the full orderDetailsResponse object (has `.paymentMethods` array)
 *   - DOM: a Document or Element representing the print page
 * @returns {string} Payment description, or '' if not found
 */
window.AmazonExporter.extractors.extractPaymentMethod = function extractPaymentMethod(source) {
  // Guard
  if (!source) return '';

  const PATTERNS     = window.AmazonExporter.PATTERNS;
  const { normalizeWhitespace, findTextNode, safeText } = window.AmazonExporter.domHelpers;

  // ── API path: source has a paymentMethods array ───────────────────────────
  // Amazon Now API returns structured payment data with card type and bank name.
  if (source.paymentMethods && Array.isArray(source.paymentMethods) && source.paymentMethods.length > 0) {
    try {
      const method = source.paymentMethods[0];
      const cardTypeMap = (PATTERNS && PATTERNS.payment.cardTypeMap) || {};
      const type = cardTypeMap[method.paymentMethodType] || method.paymentMethodType || '';

      // Clean up bank name: remove underscores and trailing card-network suffixes
      // "Emirates_Islamic_Bank_EMI_MC" → "Emirates Islamic Bank"
      let bank = (method.issuingBank || '')
        .replace(/_/g, ' ')
        .replace(/\b(EMI|MC|VISA|AMEX|MASTER)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      // NOTE: Last 4 card digits are not available in the Amazon Now API response.
      // DOM-scraped orders (Regular Amazon, Lulu) do include "ending in XXXX".
      if (type && bank) return `${type} \u2014 ${bank}`;
      if (type)         return type;
      if (bank)         return bank;

      return '';
    } catch (err) {
      console.warn('[AmazonExporter] extractPaymentMethod: API path error', err);
      return '';
    }
  }

  // ── DOM path: source is a Document or Element ─────────────────────────────
  // The print page has a "Payment method" heading followed by payment details.
  // We search for that heading and then read the text that follows it.
  if (source instanceof Element || source instanceof Document || source.nodeType) {
    try {
      // Use the root element for querying
      const root = (source instanceof Document) ? source.documentElement : source;

      // ── Lulu quick path (Amazon UFPO template) ────────────────────────────
      // Lulu printable pages don't have a "Payment method" label; they use a
      // dedicated .pmts-payment-instrument-billing-address container with the
      // card info (e.g. "Visa ending in 5817") already formatted.
      const luluPaymentEl = root.querySelector('.pmts-payment-instrument-billing-address');
      if (luluPaymentEl) {
        const luluText = normalizeWhitespace(luluPaymentEl.textContent || '');
        if (luluText) {
          if (luluText.includes(PATTERNS.payment.noChargeText)) {
            return 'No charge (cancelled)';
          }
          let luluBrand = '';
          for (const brand of PATTERNS.payment.cardBrands) {
            if (luluText.toLowerCase().includes(brand.toLowerCase())) {
              luluBrand = brand;
              break;
            }
          }
          const luluEndingMatch = luluText.match(PATTERNS.payment.endingInRegex);
          const luluLastFour = luluEndingMatch ? luluEndingMatch[1] : '';
          if (luluBrand && luluLastFour) return `${luluBrand} ending in ${luluLastFour}`;
          if (luluBrand)                 return luluBrand;
          if (luluLastFour)              return `Card ending in ${luluLastFour}`;
          if (luluText.length > 0)       return luluText;
        }
      }

      // ── Step 1: Check for cancelled order ─────────────────────────────────
      // Cancelled orders show "No current charges" instead of a card name
      const bodyText = root.innerText || root.textContent || '';
      if (bodyText.includes(PATTERNS.payment.noChargeText)) {
        return 'No charge (cancelled)';
      }

      // ── Step 2: Find the "Payment method" section ─────────────────────────
      // Look for any element whose text is (or contains) "Payment method"
      // then get the element or text that immediately follows it
      const allElements = Array.from(root.querySelectorAll('*'));
      let paymentText   = '';

      for (const el of allElements) {
        // Skip containers — only look at leaf elements (those with no child elements)
        if (el.children.length > 0) continue;

        const elText = (el.innerText || el.textContent || '').trim();

        // Found the "Payment method" label
        if (elText.toLowerCase().includes('payment method')) {
          // Get the element that follows this label
          const sibling = el.nextElementSibling;
          if (sibling) {
            paymentText = normalizeWhitespace(sibling.innerText || sibling.textContent || '');
          }
          // Also try the parent's next sibling
          if (!paymentText && el.parentElement) {
            const parentSibling = el.parentElement.nextElementSibling;
            if (parentSibling) {
              paymentText = normalizeWhitespace(parentSibling.innerText || parentSibling.textContent || '');
            }
          }
          break;
        }
      }

      // ── Step 3: Parse the payment text ────────────────────────────────────
      // Try to find a known card brand name and the last 4 digits
      if (paymentText) {
        // Check for "No current charges" inside the payment text too
        if (paymentText.includes(PATTERNS.payment.noChargeText)) {
          return 'No charge (cancelled)';
        }

        // Look for a card brand name
        let brandFound = '';
        for (const brand of PATTERNS.payment.cardBrands) {
          if (paymentText.toLowerCase().includes(brand.toLowerCase())) {
            brandFound = brand;
            break;
          }
        }

        // Look for "ending in XXXX" pattern
        const endingMatch = paymentText.match(PATTERNS.payment.endingInRegex);
        const lastFour    = endingMatch ? endingMatch[1] : '';

        // Build the result string
        if (brandFound && lastFour) return `${brandFound} ending in ${lastFour}`;
        if (brandFound)             return brandFound;
        if (lastFour)               return `Card ending in ${lastFour}`;

        // Return the raw text if we couldn't parse it neatly
        if (paymentText.length > 0) return paymentText;
      }

      // ── Fallback: scan all text for card brands + ending-in pattern ────────
      // Sometimes the layout places payment info differently
      const endingMatch = bodyText.match(PATTERNS.payment.endingInRegex);
      for (const brand of PATTERNS.payment.cardBrands) {
        if (bodyText.toLowerCase().includes(brand.toLowerCase())) {
          if (endingMatch) return `${brand} ending in ${endingMatch[1]}`;
          return brand;
        }
      }

    } catch (err) {
      console.warn('[AmazonExporter] extractPaymentMethod: DOM path error', err);
    }
  }

  return '';
};
