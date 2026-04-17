/**
 * utils/pagination.js
 *
 * Handles navigating through multiple pages of Amazon order history.
 * Amazon shows a limited number of orders per page, so to get ALL orders
 * we need to move through pages one by one.
 *
 * All functions are stored under: window.AmazonExporter.pagination
 */

// Make sure we never accidentally overwrite other parts of the extension
window.AmazonExporter = window.AmazonExporter || {};

window.AmazonExporter.pagination = {

  /**
   * Finds the URL of the next page of orders.
   * Amazon shows a "Next" button on the orders list — this reads that button's link.
   * Returns null when we are on the last page (no more orders to load).
   *
   * @param {Document} doc - The page document to inspect (usually just `document`)
   * @returns {string|null} The URL/path to the next page, or null if there is no next page
   *
   * Example:
   *   getNextPageUrl(document) → "/your-orders/orders?startIndex=10"
   *   getNextPageUrl(document) → null  (on the last page)
   */
  getNextPageUrl(doc) {
    // Amazon's pagination uses '.a-last' for the "Next" button container
    const nextContainer = doc.querySelector('.a-last');

    if (!nextContainer) {
      // No pagination element at all — this is a single-page result
      return null;
    }

    // If the container has the 'a-disabled' class, the button is greyed out (last page)
    if (nextContainer.classList.contains('a-disabled')) {
      return null;
    }

    // Find the actual clickable link inside the container
    const linkEl = nextContainer.querySelector('a');
    if (!linkEl) {
      // Container exists but has no link — treat as disabled/last page
      return null;
    }

    const href = linkEl.getAttribute('href');
    if (!href) {
      return null;
    }

    return href;
  },

  /**
   * Builds the URL for a specific page of orders using a start index.
   * Amazon paginates using a `startIndex` parameter (0 = first page, 10 = second page, etc.).
   *
   * @param {string} domain     - The Amazon domain with protocol, e.g. "https://www.amazon.ae"
   * @param {number} startIndex - The order number to start from (0-based)
   * @returns {string} The full URL to that page of orders
   *
   * Example:
   *   buildPageUrl('https://www.amazon.ae', 0)  → 'https://www.amazon.ae/your-orders/orders?startIndex=0'
   *   buildPageUrl('https://www.amazon.ae', 10) → 'https://www.amazon.ae/your-orders/orders?startIndex=10'
   */
  buildPageUrl(domain, startIndex) {
    return domain + '/your-orders/orders?startIndex=' + startIndex;
  },

  /**
   * Reads the total number of orders from the orders list page.
   * Amazon usually shows something like "49 orders placed in" or "Showing 1-10 of 49 results".
   * This function tries several common patterns to find that number.
   *
   * @param {Document} doc - The page document to inspect (usually just `document`)
   * @returns {number|null} The total order count as an integer, or null if it couldn't be found
   *
   * Example:
   *   getTotalOrderCount(document) → 49
   *   getTotalOrderCount(document) → null  (if the count text isn't found)
   */
  getTotalOrderCount(doc) {
    // Strategy 1: Look for text like "49 orders" anywhere on the page
    // This covers patterns like "49 orders placed in the last 3 months"
    const allText = doc.body ? doc.body.innerText || doc.body.textContent || '' : '';

    // Pattern: a number followed by the word "orders" (e.g. "49 orders", "1 order")
    const ordersPattern = /(\d[\d,]*)\s+orders?/i;
    const ordersMatch = allText.match(ordersPattern);
    if (ordersMatch) {
      const count = parseInt(ordersMatch[1].replace(/,/g, ''), 10);
      if (!isNaN(count)) return count;
    }

    // Strategy 2: Look for "Showing X-Y of Z results" or "X results"
    // This covers filter/search result pages
    const resultsPattern = /(?:of\s+)?(\d[\d,]*)\s+results?/i;
    const resultsMatch = allText.match(resultsPattern);
    if (resultsMatch) {
      const count = parseInt(resultsMatch[1].replace(/,/g, ''), 10);
      if (!isNaN(count)) return count;
    }

    // Strategy 3: Look for a dedicated count element Amazon sometimes uses
    // (class names may vary, so we check a few common ones)
    const countSelectors = [
      '.num-orders',
      '[data-component="orderCount"]',
      '.order-count'
    ];
    for (const sel of countSelectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const text = (el.innerText || el.textContent || '').trim();
        const numMatch = text.match(/(\d[\d,]*)/);
        if (numMatch) {
          const count = parseInt(numMatch[1].replace(/,/g, ''), 10);
          if (!isNaN(count)) return count;
        }
      }
    }

    // Could not find a total count
    console.warn('[AmazonExporter] getTotalOrderCount: Could not determine total order count from page.');
    return null;
  },

  /**
   * Reads the `startIndex` value from a URL string.
   * This tells us which page of results we are currently on.
   *
   * @param {string} url - A full URL or path string that may contain `?startIndex=N`
   * @returns {number} The startIndex as an integer. Returns 0 if the parameter is missing.
   *
   * Examples:
   *   getCurrentStartIndex('https://www.amazon.ae/your-orders/orders?startIndex=20') → 20
   *   getCurrentStartIndex('https://www.amazon.ae/your-orders/orders')               → 0
   *   getCurrentStartIndex('https://www.amazon.ae/your-orders/orders?startIndex=0')  → 0
   */
  getCurrentStartIndex(url) {
    if (!url) return 0;

    try {
      // Use the URL API if we have a full URL, otherwise parse manually
      let params;

      if (url.startsWith('http')) {
        params = new URL(url).searchParams;
      } else {
        // Relative URL — extract just the query string part
        const queryStart = url.indexOf('?');
        if (queryStart === -1) return 0;
        params = new URLSearchParams(url.slice(queryStart));
      }

      const startIndexStr = params.get('startIndex');
      if (startIndexStr === null) return 0;

      const parsed = parseInt(startIndexStr, 10);
      return isNaN(parsed) ? 0 : parsed;

    } catch (err) {
      console.warn(`[AmazonExporter] getCurrentStartIndex: Could not parse URL "${url}": ${err.message}`);
      return 0;
    }
  }

};
