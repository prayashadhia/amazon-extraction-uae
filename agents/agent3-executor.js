/**
 * agents/agent3-executor.js
 *
 * AGENT 3: EXECUTOR
 *
 * This agent does the actual data extraction for ONE order at a time.
 * It receives a "routed order" object from Agent 2 (which has already decided
 * WHERE and HOW to extract the data), and it carries out that plan.
 *
 * There are three extraction paths:
 *
 *   Path A  — API extraction (Amazon Now orders)
 *     Calls the Amazon Now REST API and reads structured JSON.
 *     This gives the cleanest, most reliable data including exact quantities.
 *
 *   Path B  — DOM extraction (Regular Amazon print summary page)
 *     Fetches the print-friendly version of the order page and scrapes the HTML.
 *     Derives quantities by comparing unit price vs. line total.
 *
 *   Path B-LULU — DOM extraction (Lulu printable page)
 *     Fetches Lulu's own printable page (different URL, table-based layout).
 *     Quantity is in an explicit table column; unit price is derived from line total.
 *
 * If the primary path fails, the agent automatically tries the fallback path.
 * If both fail, it returns a special error row so the problem can be reported.
 *
 * HOW IT IS CALLED:
 *   The background service worker injects this script into the Amazon tab using
 *   chrome.scripting.executeScript, passing (routedOrder, regionConfig) as args.
 *
 * OUTPUT:
 *   Sends a chrome.runtime.sendMessage with action = 'EXECUTOR_COMPLETE'
 *   and also returns the rows array so the background worker can use it.
 *
 * Dependencies (already loaded by the time this runs):
 *   window.AmazonExporter.extractors
 *   window.AmazonExporter.domHelpers
 *   window.AmazonExporter.apiHelpers
 *   window.AmazonExporter.PATTERNS
 */

// Attach to the shared namespace — never overwrite existing parts
window.AmazonExporter = window.AmazonExporter || {};

/**
 * Runs the extraction pipeline for a single routed order.
 *
 * @param {Object} routedOrder   - The strategy plan from Agent 2. Shape:
 *   {
 *     orderId:        string,   // e.g. "171-8280466-8238758"
 *     orderType:      string,   // 'AMAZON_NOW' | 'LULU' | 'REGULAR'
 *     orderDate:      string,   // ISO date "YYYY-MM-DD"
 *     orderTotal:     string,   // raw total text from orders list
 *     statusHint:     string,   // raw status text from orders list
 *     primarySource:  string,   // 'API' | 'PRINT_SUMMARY' | 'LULU_PRINTABLE'
 *     primaryUrl:     string,   // URL to fetch for primary extraction
 *     fallbackSource: string,   // 'PRINT_SUMMARY' | 'PRINT_SUMMARY_RETRY' | 'LULU_PRINTABLE_NO_REF'
 *     fallbackUrl:    string,   // URL to fetch if primary fails
 *     extractors:     string[]  // (informational) list of extractor names used
 *   }
 *
 * @param {Object} regionConfig  - Region settings from config/regions.js. Shape:
 *   {
 *     domain:      string,   // e.g. "https://www.amazon.ae"
 *     currency:    string,   // e.g. "AED"
 *     nowApiBase:  string,   // e.g. "/tez/order"
 *     nowBrandId:  string,   // e.g. "sAuWWBROaG"
 *   }
 *
 * @returns {Promise<Object[]>} Array of unified item row objects.
 *   Each row has the shape described in the Unified Item Row Object spec.
 *   On total failure, returns [ { orderId, _failed: true, _error, _attemptCount: 2 } ]
 */
async function runExecutor(routedOrder, regionConfig) {
  const LOG = '[AmazonExporter Agent3]';

  // ── Dependency check ──────────────────────────────────────────────────────
  // All of these must be pre-loaded by the background service worker before
  // this script runs. If any are missing, fail fast with a clear error message.
  const { apiHelpers, domHelpers, extractors, PATTERNS } = window.AmazonExporter;
  const missingDeps = [];
  if (!apiHelpers)  missingDeps.push('apiHelpers');
  if (!domHelpers)  missingDeps.push('domHelpers');
  if (!extractors)  missingDeps.push('extractors');
  if (!PATTERNS)    missingDeps.push('PATTERNS');

  if (missingDeps.length > 0) {
    const errMsg = `${LOG} Required dependencies not loaded: ${missingDeps.join(', ')}. ` +
                   'Make sure the background service worker injects dependency scripts before agent3.';
    console.error(errMsg);
    chrome.runtime.sendMessage({ action: 'EXECUTOR_ERROR', error: errMsg });
    return [{ orderId: routedOrder.orderId, _failed: true, _error: errMsg, _attemptCount: 0 }];
  }

  const { parseAEPrice, queryAll, safeText, normalizeWhitespace } = domHelpers;

  console.log(`${LOG} Starting extraction for order ${routedOrder.orderId} (type: ${routedOrder.orderType})`);

  // ─── SHORT-CIRCUIT: cancelled orders ──────────────────────────────────────
  // If Agent 1's list-page scan already reported this order as cancelled,
  // there is nothing useful to fetch. The print summary page for a cancelled
  // order has no item rows (Amazon hides them), so the DOM path would fail
  // and the order would end up in the Errors sheet. Instead, emit a single
  // synthetic cancelled-row straight from the list-page metadata and return.
  //
  // Scope: non-API paths only. Amazon Now's API sometimes still returns
  // items for cancelled orders with real titles — let Path A handle those
  // rather than collapsing them to a single placeholder row.
  const statusHintLower = String(routedOrder.statusHint || '').toLowerCase();
  if (statusHintLower.includes('cancel') && routedOrder.primarySource !== 'API') {
    console.log(
      `${LOG} Short-circuit: order ${routedOrder.orderId} is cancelled ` +
      `(statusHint="${routedOrder.statusHint}"). Emitting single cancelled row without fetching.`
    );

    const orderTypeLabel =
      routedOrder.orderType === 'AMAZON_NOW' ? 'Amazon Now' :
      routedOrder.orderType === 'LULU'       ? 'Lulu'       :
                                               'Regular Amazon';

    const cancelledRow = {
      orderId:         routedOrder.orderId,
      orderDate:       routedOrder.orderDate || '',
      itemDescription: '(Order cancelled)',
      category:        'Others',
      packSize:        '',
      quantity:        0,
      unitPrice:       0,
      lineTotal:       0,
      paymentMethod:   'No charge (cancelled)',
      shipmentStatus:  'Cancelled',
      orderType:       orderTypeLabel,
      seller:          'N/A',
      dataSource:      'List page',
      _attemptCount:   1,
      _cancelled:      true
    };

    try {
      chrome.runtime.sendMessage({
        action: 'EXECUTOR_COMPLETE',
        data: {
          orderId: routedOrder.orderId,
          rows:    [cancelledRow],
          failed:  false
        }
      });
    } catch (msgErr) {
      console.warn(`${LOG} Could not send EXECUTOR_COMPLETE message: ${msgErr.message}`);
    }

    return [cancelledRow];
  }

  // ─── Helper: build a unified row from an API item ──────────────────────────
  /**
   * Maps one item from the Amazon Now API (after extractNowOrderData) into
   * the unified row format we use across all order types.
   *
   * @param {Object} apiItem      - One item from extractNowOrderData().items[]
   * @param {Object} orderMeta    - Shared order-level data (id, date, payment, status)
   * @returns {Object} A unified item row
   */
  function mapApiItemToRow(apiItem, orderMeta) {
    const desc = apiItem.title || '';
    return {
      orderId:         orderMeta.orderId,
      orderDate:       orderMeta.orderDate,
      itemDescription: desc,
      category:        window.AmazonExporter.classifyCategory(desc),
      packSize:        apiItem.packSize  || '',
      quantity:        apiItem.quantity  || 1,
      unitPrice:       apiItem.unitPrice || 0,
      lineTotal:       apiItem.lineTotal || 0,
      paymentMethod:   orderMeta.paymentMethod,
      shipmentStatus:  orderMeta.orderStatus,
      orderType:       'Amazon Now',
      seller:          'N/A',    // Amazon Now API does not expose seller info
      dataSource:      'API',
      _attemptCount:   orderMeta._attemptCount || 1
    };
  }

  // ─── Helper: find shipment status near an item on a print page ─────────────
  /**
   * Scans backwards through the DOM siblings of an element to find the
   * nearest preceding heading that contains a delivery status keyword.
   * Amazon print pages group items under headings like "Delivered on 11 April".
   *
   * @param {Element} itemEl   - A product row element on the print page
   * @returns {string}         - The status heading text, or 'Unknown'
   */
  function findNearestStatusHeading(itemEl) {
    // PATTERNS is already hoisted at the top of runExecutor — use it directly
    const statusKeywords = PATTERNS.printPage.statusKeywords;

    // Walk backwards through previous siblings of this element's parent
    // and look for a heading tag containing a known status keyword
    let current = itemEl.parentElement;
    let safety  = 0;   // prevent infinite loops

    while (current && safety < 50) {
      // Check previous siblings of the current element
      let sibling = current.previousElementSibling;
      while (sibling) {
        const tag  = (sibling.tagName || '').toLowerCase();
        const text = normalizeWhitespace(sibling.innerText || sibling.textContent || '');

        if (['h1', 'h2', 'h3', 'h4', 'h5'].includes(tag)) {
          const lower = text.toLowerCase();
          if (statusKeywords.some(kw => lower.includes(kw.toLowerCase()))) {
            return text;
          }
        }
        sibling = sibling.previousElementSibling;
      }

      // Move up one level and keep looking
      current = current.parentElement;
      safety++;
    }

    return 'Unknown';
  }

  // ─── Helper: extract items from a Regular Amazon print page DOM ────────────
  /**
   * Given a parsed HTML Document from an Amazon print summary page,
   * finds all product items and returns them as unified row objects.
   *
   * @param {Document} doc         - Parsed print page HTML
   * @param {string}   orderId     - The order ID for this page
   * @param {string}   orderDate   - Date string (from routedOrder or extracted)
   * @param {number}   attemptNum  - Which attempt this is (1 = primary, 2 = fallback)
   * @returns {Object[]}           - Array of unified item rows
   */
  function extractRegularAmazonRows(doc, orderId, orderDate, attemptNum, listStatus) {
    const rows = [];

    // Extract order-level payment method from the document
    const paymentMethod = extractors.extractPaymentMethod(doc);

    // Find all product image links — each one marks the start of an item block.
    // Product links always go to /dp/{ASIN}.
    // `:has(img)` keeps only links that directly contain an <img>, excluding plain
    // text title links that also point to /dp/.  Requires Chrome 105+ (all modern
    // Chrome versions support :has()).
    const imageOnlyLinks = queryAll(doc, 'a[href*="/dp/"]:has(img)');

    console.log(`${LOG} Found ${imageOnlyLinks.length} item image links for order ${orderId}`);

    // ── Per-shipment status lookup ────────────────────────────────────────────
    // Amazon's print page groups items into shipments. Each group is wrapped in
    // a `[data-component="shipmentsLeftGrid"]` div that contains ONE
    // `[data-component="shipmentStatus"]` block plus its `purchasedItems` block.
    // On partial-refund orders, only the refunded shipment's status block has
    // non-empty text (e.g. "Refunded"); the other shipments have empty status
    // blocks because their return window has closed.
    function readShipmentGroupStatus(imageLink) {
      const group = imageLink.closest('[data-component="shipmentsLeftGrid"]');
      if (!group) return '';
      const statusEl = group.querySelector('[data-component="shipmentStatus"]');
      if (!statusEl) return '';
      return normalizeWhitespace(safeText(statusEl));
    }

    // Detect partial-refund orders: at least one shipment group has a
    // refund-related status AND at least one other group is empty. When this
    // is true, the list-page status is order-level "Refunded (N)" but only
    // the refunded items should be marked Refunded — the rest were delivered.
    const shipmentGroups = queryAll(doc, '[data-component="shipmentsLeftGrid"]');
    let hasRefundGroup = false;
    let hasEmptyGroup  = false;
    for (const group of shipmentGroups) {
      const statusEl = group.querySelector('[data-component="shipmentStatus"]');
      const text     = statusEl ? normalizeWhitespace(safeText(statusEl)) : '';
      if (text && text.toLowerCase().includes('refund'))   hasRefundGroup = true;
      else if (!text)                                      hasEmptyGroup  = true;
    }
    const isPartialRefund = hasRefundGroup && hasEmptyGroup;
    const listStatusRaw   = (listStatus && listStatus.trim()) ? listStatus.trim() : '';

    if (isPartialRefund) {
      console.log(
        `${LOG} Order ${orderId}: detected partial refund ` +
        `(some shipment groups marked Refunded, others empty)`
      );
    }

    for (const imageLink of imageOnlyLinks) {
      try {
        // The item's data is spread across the image and title columns of an
        // Amazon print page item row. The image link lives inside a leaf div
        // (`div.aok-relative`), while the title link is in a sibling column.
        // Walk up to `a-fixed-left-grid-inner` (or its parent) to capture both
        // columns. Fall back to any wider block ancestor, then any ancestor.
        const itemContainer =
          imageLink.closest('.a-fixed-left-grid-inner') ||
          imageLink.closest('tr, li') ||
          imageLink.parentElement;

        // ── Item description ─────────────────────────────────────────────────
        // Search the wider item container: on Amazon print pages the image and
        // the title link live in separate <td> cells, so `imageLink.parentElement`
        // alone often contains only the image.
        const itemDescription = extractors.extractItemDescription(itemContainer);

        // ── Prices ───────────────────────────────────────────────────────────
        // extractPrices scans the container for AED price patterns
        // First price found = unit price, second = line total
        const prices = extractors.extractPrices(itemContainer);

        // ── Quantity ─────────────────────────────────────────────────────────
        // For Regular Amazon, we derive quantity by comparing unit price to line total
        const quantity = extractors.extractQuantity({
          unitPrice: prices.unitPrice,
          lineTotal: prices.lineTotal
        });

        // ── Seller ───────────────────────────────────────────────────────────
        const seller = extractors.extractSeller(itemContainer);

        // ── Shipment status ──────────────────────────────────────────────────
        // Resolve status per item using a three-step priority:
        //
        //   1. Per-shipment group — each item lives inside a
        //      `[data-component="shipmentsLeftGrid"]` wrapper. If that wrapper's
        //      `shipmentStatus` block has non-empty text, use it directly. This
        //      catches partial-refund orders where only the refunded shipment
        //      renders status text.
        //
        //   2. Partial-refund inference — if the list-page status looks like
        //      "Refunded (N)" AND this is a partial-refund order AND this item's
        //      per-shipment status was empty (i.e. not the refunded one), infer
        //      Delivered. The other items in a partial-refund order must have
        //      been delivered; Amazon just stops rendering their status once the
        //      return window closes.
        //
        //   3. Fallbacks — list-page status, then nearest status heading scan,
        //      then doc-wide status scan. Finally normalize to canonical value.
        const perItemStatus = readShipmentGroupStatus(imageLink);
        let rawStatus = '';

        if (perItemStatus) {
          rawStatus = perItemStatus;
        } else if (isPartialRefund && listStatusRaw.toLowerCase().includes('refund')) {
          rawStatus = 'Delivered';
        } else if (listStatusRaw) {
          rawStatus = listStatusRaw;
        } else {
          rawStatus = findNearestStatusHeading(imageLink);
          if (!rawStatus || rawStatus === 'Unknown') {
            rawStatus = extractors.extractShipmentStatus(doc) || '';
          }
        }
        const shipmentStatus = extractors.normalizeShipmentStatus(rawStatus);

        rows.push({
          orderId:         orderId,
          orderDate:       orderDate,
          itemDescription: itemDescription,
          category:        window.AmazonExporter.classifyCategory(itemDescription),
          packSize:        '',   // Not available on print pages
          quantity:        quantity,
          unitPrice:       prices.unitPrice  || 0,
          lineTotal:       prices.lineTotal  || 0,
          paymentMethod:   paymentMethod,
          shipmentStatus:  shipmentStatus,
          orderType:       'Regular Amazon',
          seller:          seller,
          dataSource:      'DOM',
          _attemptCount:   attemptNum
        });
      } catch (itemErr) {
        // One item failed — log it but keep going with the other items
        console.warn(`${LOG} Failed to extract one item in order ${orderId}:`, itemErr);
      }
    }

    return rows;
  }

  // ─── Helper: extract items from a Lulu printable page DOM ─────────────────
  /**
   * Given a parsed HTML Document from Lulu's printable order page,
   * finds all items in the div-grid and returns them as unified row objects.
   *
   * Lulu page layout (Amazon UFPO template — div-based ARIA grid, NOT a table):
   *   Each item is a <div id="{ASIN}-item-grid-row" role="row"> containing:
   *     .ufpo-item-image-column > img[alt]          — product image + alt-text name
   *     a.a-link-normal.a-text-normal > span        — item name link
   *     div.a-column.a-span1.a-text-center          — quantity as plain text
   *     span[id$="-item-total-price"]               — line total as "AED X.XX"
   *
   * @param {Document} doc         - Parsed Lulu printable page HTML
   * @param {string}   orderId     - The order ID
   * @param {string}   orderDate   - Date string (from Agent 1's list-page scan)
   * @param {number}   attemptNum  - Which attempt this is
   * @returns {Object[]}           - Array of unified item rows
   */
  function extractLuluRows(doc, orderId, orderDate, attemptNum, listStatus) {
    const rows = [];

    // Extract payment method from the page (uses the .pmts-payment-instrument-billing-address
    // container present in Amazon's UFPO template — handled inside extractPaymentMethod)
    const paymentMethod = extractors.extractPaymentMethod(doc);

    // Order-level shipment status: the Lulu printable page itself has no
    // rendered status text, so prefer Agent 1's list-page statusHint, then
    // fall back to a full-doc scan (usually "Unknown" for Lulu). Normalize
    // at the end to a canonical value.
    //
    // Lulu safety net: if the normalized result is still "Unknown", default
    // to "Delivered". This is safe because every non-Delivered Lulu outcome
    // leaves a detectable phrase somewhere on the list card or the printable
    // page (Cancelled, Return complete, Return window closed, Refunded,
    // Out for delivery, Arriving, etc.). "Unknown" after all those checks
    // means there is genuinely no other signal — which for a grocery order
    // in the user's history means it was silently delivered.
    let rawOrderStatus = (listStatus && listStatus.trim()) ? listStatus.trim() : '';
    if (!rawOrderStatus) {
      rawOrderStatus = extractors.extractShipmentStatus(doc) || '';
    }
    let orderShipmentStatus = extractors.normalizeShipmentStatus(rawOrderStatus);
    if (orderShipmentStatus === 'Unknown') {
      console.log(
        `${LOG} Lulu order ${orderId}: no status signal on list card or printable page ` +
        `— defaulting to "Delivered" (safety net for silent-delivery grocery orders)`
      );
      orderShipmentStatus = 'Delivered';
    }

    // Find the items container — each item has id "{ASIN}-item-grid-row"
    const itemRows = queryAll(doc, 'div[id$="-item-grid-row"]');

    // Detect whether ANY row has a per-item refund marker. On a partial-refund
    // order the list-page status will be "Refunded (1)" (order-level), but the
    // print page marks only the actually-refunded rows with `.ufpo-item-status`.
    // When this is the case we infer "Delivered" for the non-refunded rows
    // (they weren't refunded, so on a delivered + partially-refunded order
    // they must have been delivered to the customer).
    const anyRowHasStatusBox = Array.prototype.some.call(
      itemRows,
      (r) => r.querySelector('.ufpo-item-status')
    );

    if (itemRows.length === 0) {
      console.warn(
        `${LOG} No Lulu item rows found for order ${orderId} ` +
        `(expected div[id$="-item-grid-row"] — Lulu UFPO template)`
      );
      return rows;
    }

    console.log(`${LOG} Found ${itemRows.length} Lulu item row(s) for order ${orderId}`);

    for (const itemRow of itemRows) {
      try {
        // ── Item description ─────────────────────────────────────────────────
        // Primary: the product link's <span>
        // Fallback: the product image's alt attribute
        let itemDescription = '';
        const nameLink = itemRow.querySelector('a.a-link-normal.a-text-normal span');
        if (nameLink) {
          itemDescription = normalizeWhitespace(safeText(nameLink));
        }
        if (!itemDescription) {
          const imgEl = itemRow.querySelector('.ufpo-item-image-column img');
          if (imgEl) {
            itemDescription = normalizeWhitespace(imgEl.getAttribute('alt') || '');
          }
        }

        if (!itemDescription) {
          console.warn(`${LOG} Lulu item row missing description for order ${orderId}`);
          continue;
        }

        // ── Quantity ─────────────────────────────────────────────────────────
        // Scoped to THIS row (not the document) so we don't accidentally match
        // the header row's "Quantity" label. The id-suffixed row selector above
        // already excludes the header (which has no id).
        const qtyCell = itemRow.querySelector('div.a-column.a-span1.a-text-center[role="gridcell"]');
        const qtyText = qtyCell ? safeText(qtyCell) : '1';
        const quantity = parseInt(qtyText, 10) || 1;

        // ── Line total ───────────────────────────────────────────────────────
        // Each row has a span with id "{ASIN}-item-total-price" containing e.g. "AED 9.90"
        const priceEl = itemRow.querySelector('span[id$="-item-total-price"]');
        const lineTotalText = priceEl ? safeText(priceEl) : '';
        const lineTotal = parseAEPrice(lineTotalText) || 0;

        // ── Unit price ───────────────────────────────────────────────────────
        // Lulu only shows the line total per row — derive unit price from it
        const unitPrice = quantity > 1
          ? parseFloat((lineTotal / quantity).toFixed(2))
          : lineTotal;

        // ── Per-item refund detection ────────────────────────────────────────
        // Refunded items have an inline `.ufpo-item-status` box with text
        // like "Refunded (1)". Non-refunded items do not.
        const itemStatusBox = itemRow.querySelector('.ufpo-item-status');
        const isRefunded = !!(itemStatusBox && /refund/i.test(safeText(itemStatusBox)));

        // Partial-refund inference: if any row in this order has a per-item
        // refund marker AND the order-level status is "Refunded", the
        // non-refunded rows must have been delivered (otherwise Amazon
        // couldn't have processed a partial refund). Default those to
        // "Delivered". If the order-level status is already a clean value
        // (e.g. "Delivered"), use it directly.
        let rowShipmentStatus;
        if (isRefunded) {
          rowShipmentStatus = 'Refunded';
        } else if (anyRowHasStatusBox && orderShipmentStatus === 'Refunded') {
          rowShipmentStatus = 'Delivered';
        } else {
          rowShipmentStatus = orderShipmentStatus;
        }

        rows.push({
          orderId:         orderId,
          orderDate:       orderDate,
          itemDescription: itemDescription,
          category:        window.AmazonExporter.classifyCategory(itemDescription),
          packSize:        '',   // Not available on Lulu pages
          quantity:        quantity,
          unitPrice:       unitPrice,
          lineTotal:       lineTotal,
          paymentMethod:   paymentMethod,
          shipmentStatus:  rowShipmentStatus,
          orderType:       'Lulu',
          seller:          'N/A',   // Lulu pages don't show seller info
          dataSource:      'DOM',
          _attemptCount:   attemptNum
        });
      } catch (rowErr) {
        console.warn(`${LOG} Failed to extract one Lulu item row for order ${orderId}:`, rowErr);
      }
    }

    return rows;
  }

  // ─── Helper: fetch a URL and parse it into a DOM Document ──────────────────
  /**
   * Fetches a page URL using the current tab's session (includes cookies),
   * then parses the response HTML into a DOM Document object.
   *
   * @param {string} url   - The URL to fetch
   * @returns {Promise<Document>} Parsed HTML document
   * @throws {Error} If the fetch fails or returns a non-OK status
   */
  async function fetchAndParse(url) {
    const response = await fetch(url, {
      method:      'GET',
      credentials: 'include',   // Use the user's active Amazon login session
      headers: {
        'Accept': 'text/html'
      }
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText} fetching: ${url}`
      );
    }

    const html = await response.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MAIN EXTRACTION LOGIC — try primary path, fall back if it fails
  // ──────────────────────────────────────────────────────────────────────────

  let rows          = [];
  let extractionErr = null;

  // ── PATH A: API Extraction (Amazon Now orders) ─────────────────────────────
  if (routedOrder.primarySource === 'API') {
    try {
      console.log(`${LOG} Path A (API): Fetching order details for ${routedOrder.orderId}`);

      // retryFetch will try up to 2 times with 1500ms delay between attempts
      const apiJson = await apiHelpers.retryFetch(
        () => apiHelpers.fetchOrderDetails(routedOrder.orderId, regionConfig),
        2,
        1500
      );

      // Convert the raw API JSON into a clean structured object
      const orderData = apiHelpers.extractNowOrderData(apiJson);

      if (!orderData || !orderData.items || orderData.items.length === 0) {
        throw new Error('extractNowOrderData returned empty or null data');
      }

      // ── Upgrade payment method using the print summary page ──────────────
      // The Amazon Now API does NOT include card last 4 digits (only
      // paymentMethodType + issuingBank). The Regular Amazon print summary
      // page for the SAME orderID includes "Mastercard ending in 3148".
      // Fetch that page and re-run extractPaymentMethod so Amazon Now rows
      // match the Regular/Lulu format. Fall back to the API-derived value
      // if the print page is unavailable or returns empty.
      try {
        const printDoc = await fetchAndParse(routedOrder.fallbackUrl);
        const printPayment = extractors.extractPaymentMethod(printDoc);
        if (printPayment) {
          orderData.paymentMethod = printPayment;
          console.log(
            `${LOG} Path A: upgraded paymentMethod from print page for ` +
            `${routedOrder.orderId} -> "${printPayment}"`
          );
        }
      } catch (printErr) {
        console.warn(
          `${LOG} Path A: could not fetch print page for payment upgrade ` +
          `(${routedOrder.orderId}): ${printErr.message}. Keeping API value.`
        );
      }

      // Normalize the order status to a canonical value. The API returns
      // values like "Delivered", "Out for delivery", "In transit" — only
      // "Delivered"/"Cancelled"/"Returned"/"Refunded" are considered clean.
      //
      // Full-order refund override: when the API reports
      // orderRefundInfo.fullOrderRefundStarted === true, treat items as
      // "Refunded" — UNLESS the milestone already says Cancelled or
      // Returned. A cancelled order that triggers a refund is still
      // primarily "Cancelled"; the refund is a consequence, not the main
      // state. Only apply the refund label when the refund is the new
      // information (e.g. a delivered order that was later refunded).
      const normalizedApiStatus = extractors.normalizeShipmentStatus(
        orderData.orderStatus || routedOrder.statusHint || ''
      );
      const apiOrderStatus =
        orderData.fullOrderRefund &&
        normalizedApiStatus !== 'Cancelled' &&
        normalizedApiStatus !== 'Returned'
          ? 'Refunded'
          : normalizedApiStatus;

      // Map each API item to the unified row format
      for (const item of orderData.items) {
        rows.push(mapApiItemToRow(item, {
          orderId:       orderData.orderId       || routedOrder.orderId,
          orderDate:     orderData.orderDate     || routedOrder.orderDate,
          paymentMethod: orderData.paymentMethod || '',
          orderStatus:   apiOrderStatus,
          _attemptCount: 1
        }));
      }

      console.log(`${LOG} Path A succeeded: extracted ${rows.length} item(s) for ${routedOrder.orderId}`);

    } catch (apiErr) {
      // API path failed — log it and try the DOM fallback
      console.warn(
        `${LOG} Path A (API) failed for order ${routedOrder.orderId}: ${apiErr.message}. ` +
        `Attempting DOM fallback...`
      );
      extractionErr = apiErr;

      // Fall back to Path B (print summary page DOM scraping)
      try {
        console.log(`${LOG} Path A fallback (DOM): Fetching ${routedOrder.fallbackUrl}`);
        const doc = await fetchAndParse(routedOrder.fallbackUrl);

        rows = extractRegularAmazonRows(
          doc,
          routedOrder.orderId,
          routedOrder.orderDate,
          2,   // attemptCount = 2 because this is the second attempt
          routedOrder.statusHint
        );

        if (rows.length > 0) {
          console.log(`${LOG} Path A fallback succeeded: ${rows.length} item(s) extracted`);
          extractionErr = null;   // Fallback worked — clear the error
        } else {
          throw new Error('DOM fallback returned zero items');
        }

      } catch (fallbackErr) {
        console.error(
          `${LOG} Both API and DOM fallback failed for order ${routedOrder.orderId}. ` +
          `Final error: ${fallbackErr.message}`
        );
        extractionErr = fallbackErr;
        rows = [];
      }
    }
  }

  // ── PATH B: DOM Extraction (Regular Amazon print summary page) ─────────────
  else if (routedOrder.primarySource === 'PRINT_SUMMARY') {
    try {
      console.log(`${LOG} Path B (DOM): Fetching print summary at ${routedOrder.primaryUrl}`);
      const doc = await fetchAndParse(routedOrder.primaryUrl);

      rows = extractRegularAmazonRows(
        doc,
        routedOrder.orderId,
        routedOrder.orderDate,
        1,
        routedOrder.statusHint
      );

      if (rows.length === 0) {
        // Page loaded but no items found — possibly a layout we didn't recognise
        throw new Error('No items extracted from print summary page');
      }

      console.log(`${LOG} Path B succeeded: ${rows.length} item(s) extracted for ${routedOrder.orderId}`);

    } catch (domErr) {
      console.warn(
        `${LOG} Path B (DOM) primary failed for order ${routedOrder.orderId}: ${domErr.message}. ` +
        `Retrying with fallback URL...`
      );
      extractionErr = domErr;

      // Retry with the fallback URL (usually same page URL, retry once after delay)
      try {
        // Brief wait before retry to let the server settle
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log(`${LOG} Path B retry: Fetching ${routedOrder.fallbackUrl}`);
        const doc = await fetchAndParse(routedOrder.fallbackUrl);

        rows = extractRegularAmazonRows(
          doc,
          routedOrder.orderId,
          routedOrder.orderDate,
          2,
          routedOrder.statusHint
        );

        if (rows.length > 0) {
          console.log(`${LOG} Path B retry succeeded: ${rows.length} item(s)`);
          extractionErr = null;
        } else {
          throw new Error('DOM retry also returned zero items');
        }

      } catch (retryErr) {
        console.error(
          `${LOG} Both DOM attempts failed for order ${routedOrder.orderId}. ` +
          `Final error: ${retryErr.message}`
        );
        extractionErr = retryErr;
        rows = [];
      }
    }
  }

  // ── PATH B-LULU: DOM Extraction (Lulu printable page) ─────────────────────
  else if (routedOrder.primarySource === 'LULU_PRINTABLE') {
    try {
      console.log(`${LOG} Path B-LULU (DOM): Fetching Lulu printable at ${routedOrder.primaryUrl}`);
      const doc = await fetchAndParse(routedOrder.primaryUrl);

      rows = extractLuluRows(
        doc,
        routedOrder.orderId,
        routedOrder.orderDate,
        1,
        routedOrder.statusHint
      );

      if (rows.length === 0) {
        throw new Error('No items extracted from Lulu printable page');
      }

      console.log(`${LOG} Path B-LULU succeeded: ${rows.length} item(s) extracted for ${routedOrder.orderId}`);

    } catch (luluErr) {
      console.warn(
        `${LOG} Path B-LULU primary failed for order ${routedOrder.orderId}: ${luluErr.message}. ` +
        `Retrying with fallback URL...`
      );
      extractionErr = luluErr;

      // Retry with alternate Lulu URL (without the ref= parameter)
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log(`${LOG} Path B-LULU retry: Fetching ${routedOrder.fallbackUrl}`);
        const doc = await fetchAndParse(routedOrder.fallbackUrl);

        rows = extractLuluRows(
          doc,
          routedOrder.orderId,
          routedOrder.orderDate,
          2,
          routedOrder.statusHint
        );

        if (rows.length > 0) {
          console.log(`${LOG} Path B-LULU retry succeeded: ${rows.length} item(s)`);
          extractionErr = null;
        } else {
          throw new Error('Lulu retry also returned zero items');
        }

      } catch (luluRetryErr) {
        console.error(
          `${LOG} Both Lulu extraction attempts failed for order ${routedOrder.orderId}. ` +
          `Final error: ${luluRetryErr.message}`
        );
        extractionErr = luluRetryErr;
        rows = [];
      }
    }
  }

  // ── UNKNOWN primarySource — should never happen, but handle gracefully ─────
  else {
    console.error(
      `${LOG} Unknown primarySource "${routedOrder.primarySource}" for order ${routedOrder.orderId}. ` +
      `No extraction was attempted.`
    );
    extractionErr = new Error(`Unknown primarySource: ${routedOrder.primarySource}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RESULT: Build the response and send it back to the background service worker
  // ──────────────────────────────────────────────────────────────────────────

  const failed = extractionErr !== null || rows.length === 0;

  // If extraction completely failed, return a special error row so Agent 4
  // and the export module can include it in the Errors sheet
  if (failed && rows.length === 0) {
    const errorRow = {
      orderId:       routedOrder.orderId,
      _failed:       true,
      _error:        extractionErr ? extractionErr.message : 'No items extracted',
      _attemptCount: 2
    };

    console.error(
      `${LOG} Extraction failed for order ${routedOrder.orderId}. ` +
      `Error: ${errorRow._error}`
    );

    // Notify background service worker of the failure
    try {
      chrome.runtime.sendMessage({
        action: 'EXECUTOR_COMPLETE',
        data: {
          orderId: routedOrder.orderId,
          rows:    [errorRow],
          failed:  true
        }
      });
    } catch (msgErr) {
      // sendMessage can fail if the extension context is invalidated (e.g. extension reloaded)
      console.warn(`${LOG} Could not send EXECUTOR_COMPLETE message: ${msgErr.message}`);
    }

    return [errorRow];
  }

  console.log(
    `${LOG} Extraction complete for order ${routedOrder.orderId}: ` +
    `${rows.length} row(s), failed=${failed}`
  );

  // Notify the background service worker that this order is done
  try {
    chrome.runtime.sendMessage({
      action: 'EXECUTOR_COMPLETE',
      data: {
        orderId: routedOrder.orderId,
        rows:    rows,
        failed:  false
      }
    });
  } catch (msgErr) {
    console.warn(`${LOG} Could not send EXECUTOR_COMPLETE message: ${msgErr.message}`);
  }

  return rows;
}

// Expose the function on the shared namespace so other scripts can call it directly
window.AmazonExporter.runExecutor = runExecutor;
