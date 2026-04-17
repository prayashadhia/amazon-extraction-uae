/**
 * utils/dom-helpers.js
 *
 * Shared DOM utility functions used by all extractors and agents.
 * These are low-level helpers that make it safe and easy to read data from
 * Amazon's HTML pages without crashing if something is missing or changes.
 *
 * All functions are stored under: window.AmazonExporter.domHelpers
 */

// Make sure we never accidentally overwrite other parts of the extension
window.AmazonExporter = window.AmazonExporter || {};

window.AmazonExporter.domHelpers = {

  /**
   * Safely reads the visible text from a DOM element.
   *
   * @param {Element|null|undefined} element - Any DOM element (e.g. a <div> or <span>)
   * @returns {string} The trimmed text content, or an empty string if the element is missing
   *
   * Example:
   *   safeText(document.querySelector('.order-total')) → "AED 45.00"
   *   safeText(null)                                   → ""
   */
  safeText(element) {
    if (!element) return '';
    return (element.innerText || element.textContent || '').trim();
  },

  /**
   * Safely reads an HTML attribute value from a DOM element.
   *
   * @param {Element|null|undefined} element  - Any DOM element
   * @param {string}                 attrName - The attribute to read (e.g. 'href', 'data-order-id')
   * @returns {string} The attribute value, or an empty string if the element or attribute is missing
   *
   * Example:
   *   safeAttr(linkEl, 'href') → "/gp/css/summary/print.html?orderID=123"
   *   safeAttr(null, 'href')   → ""
   */
  safeAttr(element, attrName) {
    if (!element) return '';
    return element.getAttribute(attrName) || '';
  },

  /**
   * Safely finds the FIRST element matching a CSS selector within a given root element.
   * Wrapped in try/catch so a bad selector never crashes the whole extension.
   *
   * @param {Element|Document} root     - The element to search within (often `document`)
   * @param {string}           selector - A CSS selector string (e.g. '.order-total', '#order-id')
   * @returns {Element|null} The matching element, or null if nothing was found or an error occurred
   *
   * Example:
   *   queryFirst(document, '.a-price-whole') → <span class="a-price-whole">45</span>
   */
  queryFirst(root, selector) {
    try {
      return root.querySelector(selector) || null;
    } catch (err) {
      console.warn(`[AmazonExporter] queryFirst failed for selector: "${selector}"`, err);
      return null;
    }
  },

  /**
   * Safely finds ALL elements matching a CSS selector within a given root element.
   * Always returns a plain array (never a NodeList), and never throws.
   *
   * @param {Element|Document} root     - The element to search within
   * @param {string}           selector - A CSS selector string
   * @returns {Element[]} An array of matching elements, or an empty array on failure
   *
   * Example:
   *   queryAll(document, '.order-card') → [<div>, <div>, <div>, ...]
   */
  queryAll(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (err) {
      console.warn(`[AmazonExporter] queryAll failed for selector: "${selector}"`, err);
      return [];
    }
  },

  /**
   * Waits for an element to appear in the page (useful when Amazon loads content dynamically).
   * Uses a MutationObserver, which is more efficient than repeatedly checking in a loop.
   *
   * @param {string} selector   - CSS selector for the element to wait for
   * @param {number} timeoutMs  - How many milliseconds to wait before giving up (default: 5000)
   * @returns {Promise<Element>} Resolves with the element once it appears in the DOM.
   *                             Rejects with an Error if the element never appears in time.
   *
   * Example:
   *   const el = await waitForElement('.order-summary', 8000);
   */
  waitForElement(selector, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      // Check if the element is already present before setting up the observer
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      // Set a timer — if the element never appears, reject the promise
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`[AmazonExporter] Timed out waiting for: ${selector}`));
      }, timeoutMs);

      // Watch the page for any DOM changes
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(document.body, {
        childList: true,   // Watch for elements being added/removed
        subtree: true      // Watch all descendants, not just direct children
      });
    });
  },

  /**
   * Parses an Amazon AED price string into a plain JavaScript number.
   * Handles currency symbols, commas, and extra whitespace.
   *
   * @param {string} text - A price string from an Amazon page
   * @returns {number|null} A float (e.g. 1200.50), or null if parsing failed
   *
   * Examples:
   *   parseAEPrice("AED 45.00")     → 45
   *   parseAEPrice("AED 1,200.50")  → 1200.5
   *   parseAEPrice("AED45.00")      → 45
   *   parseAEPrice("not a price")   → null
   */
  parseAEPrice(text) {
    if (!text) return null;

    // Remove "AED", commas, and all whitespace, then parse as a float
    const cleaned = text
      .replace(/AED/gi, '')   // Remove currency code (case-insensitive)
      .replace(/,/g, '')      // Remove thousands separators (e.g. 1,200 → 1200)
      .replace(/\s/g, '')     // Remove all whitespace
      .trim();

    const result = parseFloat(cleaned);
    return isNaN(result) ? null : result;
  },

  /**
   * Collapses messy whitespace (multiple spaces, tabs, newlines) into a single space.
   * Amazon pages often have irregular spacing in scraped text.
   *
   * @param {string|null|undefined} text - Any text string
   * @returns {string} Cleaned-up text with single spaces, or '' if input is empty/null
   *
   * Example:
   *   normalizeWhitespace("  Order  \n  Total  ") → "Order Total"
   */
  normalizeWhitespace(text) {
    if (!text) return '';
    return text.replace(/[\s\t\n\r]+/g, ' ').trim();
  },

  /**
   * Finds the first text node inside a container that CONTAINS a given search string.
   * Useful for finding labels whose exact position or parent element may vary.
   *
   * @param {Element} root        - The element to search inside
   * @param {string}  searchText  - The text to look for (case-insensitive)
   * @returns {Text|null} The matching DOM Text node, or null if not found
   *
   * Example:
   *   findTextNode(orderCard, 'payment method') → [Text node with "Payment Method:"]
   */
  findTextNode(root, searchText) {
    if (!root || !searchText) return null;

    const lowerSearch = searchText.toLowerCase();

    // TreeWalker efficiently visits every text node in the subtree
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,  // Only visit text nodes (not elements or comments)
      null
    );

    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim().toLowerCase().includes(lowerSearch)) {
        return node;
      }
    }

    return null;
  },

  /**
   * Finds a label element by text, then returns the element immediately after it.
   * Amazon pages often have a pattern like: <span>Payment Method</span><span>Visa</span>
   * This function helps extract the value that follows a known label.
   *
   * @param {Element} root       - The element to search inside
   * @param {string}  labelText  - The label text to look for (e.g. "Payment Method")
   * @returns {Element|null} The sibling element right after the label, or null if not found
   *
   * Example:
   *   getElementAfterLabel(orderSummary, 'Payment Method') → <span>Visa ending in 1234</span>
   */
  getElementAfterLabel(root, labelText) {
    if (!root || !labelText) return null;

    const lowerLabel = labelText.toLowerCase();

    // Search all elements inside root for one whose text contains the label
    const allElements = Array.from(root.querySelectorAll('*'));

    for (const el of allElements) {
      // Only match leaf-level elements (those without child elements), to avoid
      // matching a container that holds both the label and the value
      const hasChildElements = el.children.length > 0;
      if (hasChildElements) continue;

      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (text.includes(lowerLabel)) {
        // Return the next sibling element (the value after the label)
        return el.nextElementSibling || null;
      }
    }

    return null;
  }

};
