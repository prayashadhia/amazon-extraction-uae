/**
 * extractors/item-description.js
 *
 * Extracts the product name / description for a single item.
 *
 * Works with TWO input types (dual-path):
 *
 *   API path (Amazon Now orders):
 *     Input is a plain JavaScript object from the getOrderDetails JSON response.
 *     The object has a `.title` property with the product name.
 *
 *   DOM path (Regular Amazon + Lulu orders):
 *     Input is a DOM element representing a product row on the print page.
 *     Product title links always point to "/dp/{ASIN}" (the Amazon product detail page).
 *     If the link text is empty, we fall back to the image alt text inside the link.
 *
 * Returns a clean string description, or '' if nothing can be found.
 */

window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.extractors = window.AmazonExporter.extractors || {};

/**
 * Extracts the item description from an API item object or a DOM element.
 *
 * @param {Object|Element} source
 *   - API: a plain object with a `.title` property (from orderItems[] array)
 *   - DOM: a DOM element representing the product row (contains a product link)
 * @returns {string} The product description, or '' if not found
 */
window.AmazonExporter.extractors.extractItemDescription = function extractItemDescription(source) {
  // Guard: nothing to work with
  if (!source) return '';

  const { normalizeWhitespace } = window.AmazonExporter.domHelpers;

  // Detect whether source is a DOM element. This check must come FIRST:
  // DOM elements also have a `.title` property (the HTML `title` attribute),
  // so a naive `typeof source.title === 'string'` check would incorrectly
  // route DOM elements into the API path and return an empty string.
  const isDomElement = (source instanceof Element) || source.nodeType === 1;

  // ── API path: source is a plain object (NOT a DOM element) ────────────────
  // Amazon Now API responses always include a human-readable `.title` field.
  if (!isDomElement && typeof source.title === 'string') {
    return normalizeWhitespace(source.title);
  }

  if (!isDomElement) {
    // Not a DOM element and not an API object — nothing we can do
    console.warn('[AmazonExporter] extractItemDescription: Input is neither API object nor DOM element');
    return '';
  }

  try {
    // Collect every candidate string from inside the source element, then pick
    // the best one. We look at:
    //   1. Text inside product links (/dp/ and /gp/product/)
    //   2. `alt` attributes of <img> elements inside product links
    //   3. `alt` attributes of any <img> in the container (outside a link)
    //
    // Note: DOMParser-parsed documents are NOT laid out, so `innerText` often
    // returns "" even when text exists. Always use textContent for these.
    const candidates = [];

    const productLinks = source.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
    for (const link of productLinks) {
      const linkText = normalizeWhitespace(link.textContent || '');
      if (linkText.length > 0) candidates.push(linkText);

      const img = link.querySelector('img');
      if (img && img.getAttribute('alt')) {
        const altText = normalizeWhitespace(img.getAttribute('alt'));
        if (altText.length > 0) candidates.push(altText);
      }
    }

    // Fallback: any <img> with an alt attribute inside the container
    if (candidates.length === 0) {
      const imgs = source.querySelectorAll('img[alt]');
      for (const img of imgs) {
        const altText = normalizeWhitespace(img.getAttribute('alt') || '');
        if (altText.length > 0) candidates.push(altText);
      }
    }

    // Pick the longest candidate — product titles are usually longer than
    // generic alt placeholders like "Product image" or "image".
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];
    }

    // Diagnostic: log the outer HTML (trimmed) so we can see what Amazon sent
    const outerSnippet = (source.outerHTML || '').slice(0, 300).replace(/\s+/g, ' ');
    console.warn(
      '[AmazonExporter] extractItemDescription: no description found. ' +
      `Container has ${productLinks.length} product link(s). Snippet: ${outerSnippet}`
    );
  } catch (err) {
    console.warn('[AmazonExporter] extractItemDescription: DOM extraction error', err);
  }

  // Nothing found
  return '';
};
