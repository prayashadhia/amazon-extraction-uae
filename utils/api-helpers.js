/**
 * utils/api-helpers.js
 *
 * Handles all communication with the Amazon Now REST API.
 * Amazon Now orders have a special internal API that returns clean JSON data —
 * this file knows how to talk to that API and how to read its response.
 *
 * IMPORTANT: This file only works inside an Amazon tab because the browser
 * automatically sends Amazon login cookies with every request.
 *
 * All functions are stored under: window.AmazonExporter.apiHelpers
 */

// Make sure we never accidentally overwrite other parts of the extension
window.AmazonExporter = window.AmazonExporter || {};

window.AmazonExporter.apiHelpers = {

  /**
   * Fetches the full order details for a single Amazon Now order from the REST API.
   *
   * @param {string} orderId - The Amazon order ID (e.g. "171-1234567-8901234")
   * @param {Object} region  - A region config object (from config/regions.js) with:
   *                             .domain     — e.g. "https://www.amazon.ae"
   *                             .nowApiBase — e.g. "/tez/order"
   *                             .nowBrandId — e.g. "sAuWWBROaG"
   * @returns {Promise<Object>} The full parsed JSON response from the API
   * @throws {Error} If the HTTP request fails or the API reports success === false
   *
   * Example URL built:
   *   https://www.amazon.ae/tez/order/getOrderDetails?orderId=171-xxx&pageType=orderDetail&brandId=sAuWWBROaG
   */
  async fetchOrderDetails(orderId, region) {
    // Build the full API URL from the region config
    const url =
      region.domain +
      region.nowApiBase +
      '/getOrderDetails' +
      '?orderId=' + encodeURIComponent(orderId) +
      '&pageType=orderDetail' +
      '&brandId=' + encodeURIComponent(region.nowBrandId);

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        credentials: 'include',  // Send Amazon login cookies automatically
        headers: {
          'Accept': 'application/json'
        }
      });
    } catch (networkErr) {
      // Network failure (offline, CORS issue, etc.)
      throw new Error(
        `[AmazonExporter] Network error fetching order ${orderId}: ${networkErr.message}`
      );
    }

    // Check for HTTP-level errors (e.g. 404, 500)
    if (!response.ok) {
      throw new Error(
        `[AmazonExporter] API request failed for order ${orderId}. ` +
        `HTTP status: ${response.status} ${response.statusText}`
      );
    }

    let json;
    try {
      json = await response.json();
    } catch (parseErr) {
      throw new Error(
        `[AmazonExporter] Could not parse API response for order ${orderId}: ${parseErr.message}`
      );
    }

    // Check the API's own success flag
    if (!json.success || json.statusCode !== '200') {
      throw new Error(
        `[AmazonExporter] API returned failure for order ${orderId}. ` +
        `Success: ${json.success}, StatusCode: ${json.statusCode}`
      );
    }

    return json;
  },

  /**
   * A generic retry wrapper. Runs an async function and automatically retries
   * it if it throws an error. Useful for handling temporary network hiccups.
   *
   * @param {Function} asyncFn      - An async function that takes no arguments (use arrow functions)
   * @param {number}   maxAttempts  - How many times to try before giving up (default: 3)
   * @param {number}   delayMs      - How long to wait between retries in milliseconds (default: 1500)
   * @returns {Promise<*>} The result of asyncFn if it eventually succeeds
   * @throws {Error} The last error thrown if all attempts fail
   *
   * Example:
   *   const data = await retryFetch(
   *     () => apiHelpers.fetchOrderDetails('171-xxx', region),
   *     3,
   *     1500
   *   );
   */
  async retryFetch(asyncFn, maxAttempts = 3, delayMs = 1500) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await asyncFn();
      } catch (err) {
        lastError = err;

        if (attempt < maxAttempts) {
          console.warn(
            `[AmazonExporter] Attempt ${attempt}/${maxAttempts} failed. ` +
            `Retrying in ${delayMs}ms... Error: ${err.message}`
          );
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    // All attempts failed — re-throw with context
    throw new Error(
      `[AmazonExporter] All ${maxAttempts} attempts failed. ` +
      `Last error: ${lastError.message}`
    );
  },

  /**
   * Converts a raw API JSON response into a clean, structured order object.
   * This is the "translation layer" between Amazon's API format and our export format.
   *
   * @param {Object} apiJson - The full parsed JSON object returned by fetchOrderDetails()
   * @returns {Object} A structured order object ready to be validated and exported.
   *                   See structure below in the implementation.
   *
   * The returned object shape:
   * {
   *   orderId:       string,    — e.g. "171-1234567-8901234"
   *   orderDate:     string,    — as returned by the API
   *   orderStatus:   string,    — human-readable, e.g. "Delivered"
   *   paymentMethod: string,    — e.g. "CREDIT_CARD Emirates Islamic Bank EMI MC"
   *   grandTotal:    number,    — e.g. 129.75
   *   items:         Array      — one entry per item in the order (see below)
   * }
   */
  extractNowOrderData(apiJson) {
    // Navigate safely to the nested order data
    const orderData =
      apiJson &&
      apiJson.data &&
      apiJson.data.orderDetailsResponse;

    if (!orderData) {
      console.error('[AmazonExporter] extractNowOrderData: Missing orderDetailsResponse in API JSON.');
      return null;
    }

    // --- Order Status ---
    // Map internal status codes to readable labels
    const rawStatus =
      (orderData.milestoneData && orderData.milestoneData.orderStatusEnum) || '';

    // Use the shared status map from patterns.js (available as window.AmazonExporter.PATTERNS)
    const statusMap = (window.AmazonExporter.PATTERNS && window.AmazonExporter.PATTERNS.nowApi.statusMap) || {};
    const orderStatus = statusMap[rawStatus] || rawStatus;

    // --- Full-order refund flag ---
    // When Amazon refunds an entire Now order, the API sets this flag. We
    // surface it so Agent 3 can override the shipment status to "Refunded"
    // for every item in the order.
    //
    // NOTE: Partial refunds (individual items refunded within an otherwise
    // delivered order) would need a per-item refund field in `orderItems[]`.
    // We have not seen a sample with that pattern yet — when one appears,
    // add the per-item flag to the items.map() below.
    const fullOrderRefund = !!(
      orderData.orderRefundInfo && orderData.orderRefundInfo.fullOrderRefundStarted
    );

    // --- Payment Method ---
    // The API gives us card type and issuing bank, but NOT the last 4 digits.
    // We clean both fields into readable text.
    // Example raw:   paymentMethodType="CREDIT_CARD", issuingBank="Emirates_Islamic_Bank_EMI_MC"
    // Example output: "Credit Card — Emirates Islamic Bank"
    //
    // NOTE: For Amazon Now orders, last 4 card digits are not available from the API.
    //       Regular Amazon and Lulu orders (scraped from the print page) DO include
    //       "ending in XXXX" because that text appears on the page itself.
    let paymentMethod = 'N/A';
    if (orderData.paymentMethods && orderData.paymentMethods.length > 0) {
      const pm = orderData.paymentMethods[0];

      // Use the shared card type map from patterns.js
      const cardTypeMap = (window.AmazonExporter.PATTERNS && window.AmazonExporter.PATTERNS.payment.cardTypeMap) || {};
      const methodType = cardTypeMap[pm.paymentMethodType] || pm.paymentMethodType || '';

      // Clean up bank name:
      //   "Emirates_Islamic_Bank_EMI_MC" → "Emirates Islamic Bank"
      //   Strip trailing suffixes like _EMI, _MC, _VISA, _AMEX
      let bankName = (pm.issuingBank || '')
        .replace(/_/g, ' ')                       // underscores → spaces
        .replace(/\b(EMI|MC|VISA|AMEX|MASTER)\b/gi, '') // strip card network suffixes
        .replace(/\s+/g, ' ')                     // collapse extra spaces
        .trim();

      if (methodType && bankName) {
        paymentMethod = `${methodType} \u2014 ${bankName}`;
      } else if (methodType) {
        paymentMethod = methodType;
      } else if (bankName) {
        paymentMethod = bankName;
      }
    }

    // --- Grand Total ---
    // Deep path: billSummary → grandTotal → totalPayable → currency → amount
    let grandTotal = 0;
    try {
      grandTotal =
        orderData.billSummary.grandTotal.totalPayable.currency.amount || 0;
    } catch (_) {
      console.warn(
        `[AmazonExporter] Could not read grandTotal for order ${orderData.orderId}.`
      );
    }

    // --- Order Items ---
    const rawItems = orderData.orderItems || [];
    const items = rawItems.map((item, index) => {
      // Unit price from the offer price field
      const unitPrice =
        (item.totalOfferPrice && item.totalOfferPrice.amount) || 0;

      const quantity = item.quantity || 1;

      // List price = original price before any discounts
      const listPrice =
        (item.listPrice && item.listPrice.amount) || unitPrice;

      return {
        asin:        item.asin        || '',
        title:       item.title       || `Item ${index + 1}`,
        packSize:    item.packSize    || '',
        quantity:    quantity,
        unitPrice:   unitPrice,
        lineTotal:   parseFloat((unitPrice * quantity).toFixed(2)),  // Avoid floating point dust
        listPrice:   listPrice,
        orderType:   'Amazon Now',
        seller:      'N/A',          // The Amazon Now API does not expose seller info
        dataSource:  'API'
      };
    });

    // Normalize orderDate: the API returns raw text like "14th April 2026 07:27 AM".
    // Run it through the shared date extractor so it ends up as "YYYY-MM-DD".
    const rawOrderDate = orderData.orderDate || '';
    const extractOrderDate =
      window.AmazonExporter.extractors && window.AmazonExporter.extractors.extractOrderDate;
    const orderDate = extractOrderDate ? (extractOrderDate(rawOrderDate) || rawOrderDate) : rawOrderDate;

    return {
      orderId:          orderData.orderId       || '',
      orderDate:        orderDate,
      orderStatus:      orderStatus,
      paymentMethod:    paymentMethod,
      grandTotal:       grandTotal,
      fullOrderRefund:  fullOrderRefund,
      items:            items
    };
  }

};
