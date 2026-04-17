/**
 * agents/agent2-strategy.js — Agent 2: Strategy
 *
 * PURPOSE:
 *   Takes the array of order objects collected by Agent 1 and assigns each
 *   order to the correct extraction path.  This is pure routing logic — no DOM
 *   access or network requests happen here.
 *
 * ROUTING RULES:
 *   AMAZON_NOW  → Try REST API first  (/tez/order/getOrderDetails)
 *                  Fallback: print summary page (same as Regular)
 *   LULU        → Lulu printable page (/uff/your-account/order-details/printable)
 *                  Fallback: same URL without the ref_ query param
 *   REGULAR     → Amazon print summary page (/gp/css/summary/print.html)
 *                  Fallback: same URL (retry once after a short delay)
 *
 * INPUT:
 *   orders      — array of { orderId, orderType, orderDate, orderTotal, statusHint }
 *   regionConfig — the region object from window.AmazonExporter.getRegion()
 *
 * OUTPUT (two ways to get the result):
 *   1. Return value  — array of routedOrders (for synchronous use by background worker)
 *   2. Message       — chrome.runtime.sendMessage({ action: 'STRATEGY_COMPLETE', data: { routedOrders } })
 *
 * DEPENDENCIES (pre-loaded on window.AmazonExporter):
 *   window.AmazonExporter.getRegion(domain)   — returns a region config object
 */

// Initialise the shared namespace — never overwrite what other scripts already set
window.AmazonExporter = window.AmazonExporter || {};

/**
 * runStrategy(orders, regionConfig)
 *
 * Main entry point.  Called by the background service worker, either:
 *   • via chrome.scripting.executeScript with args passed in, or
 *   • directly as window.AmazonExporter.runStrategy(orders, regionConfig)
 *
 * @param {Array}  orders        - Order objects from Agent 1
 * @param {Object} regionConfig  - Optional. Region config object.
 *                                 If omitted, auto-detected from window.location.
 * @returns {Array} routedOrders - The enriched array (also sent via sendMessage)
 */
window.AmazonExporter.runStrategy = function runStrategy(orders, regionConfig) {
  const LOG = '[AmazonExporter Agent2]';
  console.log(`${LOG} runStrategy() started — ${orders ? orders.length : 0} order(s) to route.`);

  try {
    // ── 1. Resolve region config ──────────────────────────────────────────────
    // The background worker can pass the region config directly (preferred), or
    // we auto-detect from the current page domain as a fallback.
    let region = regionConfig;

    if (!region) {
      // Auto-detect from the tab's domain
      const domain = window.location.hostname; // e.g. "www.amazon.ae"
      if (typeof window.AmazonExporter.getRegion === 'function') {
        region = window.AmazonExporter.getRegion(domain);
        console.log(`${LOG} Region auto-detected from domain "${domain}":`, region);
      } else {
        throw new Error(
          'regionConfig was not provided and window.AmazonExporter.getRegion is not available. ' +
          'Make sure config/regions.js is injected before agent2-strategy.js.'
        );
      }
    }

    // ── 2. Validate inputs ────────────────────────────────────────────────────
    if (!Array.isArray(orders)) {
      throw new Error(
        `"orders" must be an array. Received: ${typeof orders}. ` +
        'Pass the orders array from Agent 1 as the first argument.'
      );
    }

    // ── 3. Route each order ───────────────────────────────────────────────────
    const routedOrders = [];

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];

      // Basic guard — skip malformed entries rather than crashing
      if (!order || !order.orderId) {
        console.warn(`${LOG} Order #${i + 1}: Missing orderId — skipping.`, order);
        continue;
      }

      const { orderId, orderType } = order;

      let routing;

      // ── Route: AMAZON_NOW ─────────────────────────────────────────────────
      if (orderType === 'AMAZON_NOW') {
        /*
         * Amazon Now orders have a live REST API that returns structured JSON.
         * This is always the preferred source because:
         *   - Explicit quantity field (no price-maths needed)
         *   - Pack size info (e.g. "500g, 6-7 Pcs")
         *   - Item-level discount breakdown
         *
         * API URL example:
         *   https://www.amazon.ae/tez/order/getOrderDetails
         *     ?orderId=171-8280466-8238758
         *     &pageType=orderDetail
         *     &brandId=sAuWWBROaG
         *
         * Fallback: Amazon print summary page (same DOM structure as Regular Amazon)
         */
        const apiUrl = `${region.domain}${region.nowApiBase}/getOrderDetails` +
                       `?orderId=${orderId}` +
                       `&pageType=orderDetail` +
                       `&brandId=${region.nowBrandId}`;

        const fallbackUrl = `${region.domain}${region.printSummaryPath}?orderID=${orderId}`;

        routing = {
          primarySource: 'API',
          primaryUrl:    apiUrl,

          fallbackSource: 'PRINT_SUMMARY',
          fallbackUrl:    fallbackUrl,

          // These are the extractor module names Agent 3 will run.
          // 'seller' is intentionally excluded — not available via the Now API.
          // 'shipment-status' maps to milestoneData.orderStatusEnum in the API.
          extractors: [
            'order-id',
            'item-description',
            'price',
            'quantity',
            'payment-method',
            'shipment-status',
            'order-type',
            'order-date',
            'seller'          // N/A for API path — Agent 3 will mark as "N/A"
          ]
        };

        console.log(`${LOG} ${orderId} (AMAZON_NOW) → API primary, PRINT_SUMMARY fallback`);
      }

      // ── Route: LULU ───────────────────────────────────────────────────────
      else if (orderType === 'LULU') {
        /*
         * Lulu orders use a completely different printable page URL.
         * The page is table-based (not div-based like regular Amazon).
         * Quantity is shown explicitly in the table's Quantity column.
         * Unit price is NOT shown — derive as lineTotal / quantity when qty > 1.
         * No seller info is available.
         *
         * Primary URL (with ref_ param):
         *   https://www.amazon.ae/uff/your-account/order-details/printable
         *     ?ref_=uff_od_invoice
         *     &orderID=404-0649716-2229124
         *
         * Fallback (without ref_ — in case the param causes a 404 on some regions):
         *   https://www.amazon.ae/uff/your-account/order-details/printable
         *     ?orderID=404-0649716-2229124
         */
        const primaryUrl  = `${region.domain}${region.luluPrintPath}` +
                            `?${region.luluPrintRef}` +
                            `&orderID=${orderId}`;

        const fallbackUrl = `${region.domain}${region.luluPrintPath}` +
                            `?orderID=${orderId}`;

        routing = {
          primarySource: 'LULU_PRINTABLE',
          primaryUrl,

          // Try without the ref_ param if the primary URL 404s
          fallbackSource: 'LULU_PRINTABLE_NO_REF',
          fallbackUrl,

          // 'shipment-status' and 'seller' are not available on the Lulu page
          extractors: [
            'order-id',
            'item-description',
            'price',
            'quantity',
            'payment-method',
            'order-type',
            'order-date'
          ]
        };

        console.log(`${LOG} ${orderId} (LULU) → LULU_PRINTABLE primary, LULU_PRINTABLE_NO_REF fallback`);
      }

      // ── Route: REGULAR (default) ──────────────────────────────────────────
      else {
        /*
         * Standard Amazon orders use the print summary page.
         * This is a simplified, stable page that rarely changes — the safest
         * scraping target for Regular Amazon orders.
         *
         * Quantity is derived: if both price fields on an item are identical,
         * quantity = 1; otherwise quantity = lineTotal / unitPrice.
         *
         * If the page fails to load or returns empty content, Agent 3 retries
         * once after a 2-second delay (same URL).
         *
         * URL example:
         *   https://www.amazon.ae/gp/css/summary/print.html
         *     ?orderID=404-5826165-9042763
         */
        const printUrl = `${region.domain}${region.printSummaryPath}?orderID=${orderId}`;

        routing = {
          primarySource: 'PRINT_SUMMARY',
          primaryUrl:    printUrl,

          // Retry the same URL — Agent 3 waits 2 s before the retry
          fallbackSource: 'PRINT_SUMMARY_RETRY',
          fallbackUrl:    printUrl,

          extractors: [
            'order-id',
            'item-description',
            'price',
            'quantity',
            'payment-method',
            'shipment-status',
            'order-type',
            'order-date',
            'seller'
          ]
        };

        console.log(`${LOG} ${orderId} (${orderType || 'REGULAR'}) → PRINT_SUMMARY`);
      }

      // ── 4. Merge the original order fields with the routing info ──────────
      // Agent 3 needs both the original metadata (date, total, statusHint)
      // AND the routing plan, so we spread them together.
      const routedOrder = Object.assign({}, order, routing);
      routedOrders.push(routedOrder);
    }

    console.log(`${LOG} Routing complete — ${routedOrders.length} order(s) assigned a strategy.`);

    // ── 5. Send results back to the background service worker ─────────────────
    // The background worker listens for 'STRATEGY_COMPLETE' and then launches
    // Agent 3 with this payload.
    chrome.runtime.sendMessage({
      action: 'STRATEGY_COMPLETE',
      data: {
        routedOrders
      }
    });

    console.log(`${LOG} STRATEGY_COMPLETE message sent.`);

    // Also return the array so the caller can use it synchronously if needed
    return routedOrders;

  } catch (err) {
    // Top-level catch — report back to the background worker so it knows
    // strategy planning failed and can surface the error to the user.
    console.error(`${LOG} Fatal error in runStrategy():`, err);

    chrome.runtime.sendMessage({
      action: 'STRATEGY_ERROR',
      error: err.message
    });

    // Return an empty array so synchronous callers don't crash
    return [];
  }
};

// Signal to the background worker that the script is ready
console.log('[AmazonExporter Agent2] agent2-strategy.js loaded — window.AmazonExporter.runStrategy() is ready.');
