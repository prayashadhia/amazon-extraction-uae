/**
 * agents/agent1-recon.js — Agent 1: Recon
 *
 * PURPOSE:
 *   Scans the currently loaded Amazon orders list page and collects all order
 *   IDs with their types (Amazon Now / Lulu / Regular).  The background service
 *   worker re-injects this script once per page — it is never responsible for
 *   navigating between pages itself.
 *
 * OUTPUT:
 *   Sends a chrome.runtime message with action 'RECON_PAGE_COMPLETE' containing:
 *     • orders          — array of order objects found on this page
 *     • hasNextPage     — true if there is another page to process
 *     • nextPageUrl     — the href for the next page (null if last page)
 *     • currentStartIndex — the startIndex this page represents
 *     • totalOrderCount — total orders Amazon reports (null if not found)
 *
 * DEPENDENCIES (pre-loaded on window.AmazonExporter by the background worker):
 *   window.AmazonExporter.extractors.extractOrderId(card)
 *   window.AmazonExporter.extractors.extractOrderType(card)
 *   window.AmazonExporter.extractors.extractOrderDate(card)
 *   window.AmazonExporter.pagination.getNextPageUrl(doc)
 *   window.AmazonExporter.pagination.getTotalOrderCount(doc)
 *   window.AmazonExporter.pagination.getCurrentStartIndex(url)
 *   window.AmazonExporter.PATTERNS
 */

// Initialise the shared namespace — never overwrite what other scripts already set
window.AmazonExporter = window.AmazonExporter || {};

/**
 * runRecon()
 *
 * Main entry point called by the background service worker via
 * chrome.scripting.executeScript({ func: () => window.AmazonExporter.runRecon() }).
 *
 * Scans the current page, builds the results array, and fires a
 * chrome.runtime.sendMessage back to the background worker.
 */
window.AmazonExporter.runRecon = function runRecon() {
  const LOG = '[AmazonExporter Agent1]';
  console.log(`${LOG} runRecon() started on ${window.location.href}`);

  try {
    // ── 1. Grab the dependencies we need ─────────────────────────────────────
    const extractors = window.AmazonExporter.extractors;
    const pagination  = window.AmazonExporter.pagination;
    const PATTERNS    = window.AmazonExporter.PATTERNS;

    // Defensive check — if scripts loaded out of order, fail gracefully
    if (!extractors || !pagination || !PATTERNS) {
      const missing = [
        !extractors && 'extractors',
        !pagination  && 'pagination',
        !PATTERNS    && 'PATTERNS'
      ].filter(Boolean).join(', ');

      throw new Error(
        `Required dependencies not found on window.AmazonExporter: ${missing}. ` +
        'Make sure config/patterns.js, extractors/*, and utils/pagination.js are ' +
        'injected before agent1-recon.js.'
      );
    }

    // ── 2. Find all order cards on the page ───────────────────────────────────
    // Primary selector matches the real Amazon.ae DOM structure observed in RECON.md.
    // The fallback covers edge cases where the outer class names change but
    // Amazon keeps data-order-id attributes on the card element.
    let cards = Array.from(
      document.querySelectorAll(PATTERNS.ordersList.orderCard)
    );

    if (cards.length === 0) {
      console.warn(
        `${LOG} Primary card selector "${PATTERNS.ordersList.orderCard}" found no cards. ` +
        `Trying fallback: "${PATTERNS.ordersList.orderCardFallback}"`
      );
      cards = Array.from(
        document.querySelectorAll(PATTERNS.ordersList.orderCardFallback)
      );
    }

    console.log(`${LOG} Found ${cards.length} order card(s) on this page.`);

    // ── 3. Extract data from each card ────────────────────────────────────────
    const orders = [];

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      try {
        // 3a. Order ID — if we can't get this, the card is useless; skip it
        const orderId = extractors.extractOrderId(card);
        if (!orderId) {
          console.warn(
            `${LOG} Card #${i + 1}: Could not extract order ID — skipping this card.`,
            card
          );
          continue; // skip, never crash the whole run
        }

        // 3b. Order type — AMAZON_NOW | LULU | REGULAR
        //     Badge/logo detection is used, NOT the order ID prefix
        const orderType = extractors.extractOrderType(card);

        // 3c. Order date — returned as "YYYY-MM-DD" string or null
        const orderDate = extractors.extractOrderDate(card);

        // 3d. Order total — read from the bold price element on the card header
        //     PATTERNS.ordersList.orderTotalElement = '.a-color-base.a-text-bold'
        //     There may be multiple matches; the first is usually the order total.
        const { safeText } = window.AmazonExporter.domHelpers;
        let orderTotal = null;
        try {
          const totalEl = card.querySelector(PATTERNS.ordersList.orderTotalElement);
          if (totalEl) {
            orderTotal = safeText(totalEl);
          }

          // Fallback: scan the full card text for an AED price pattern
          if (!orderTotal) {
            const priceMatch = safeText(card).match(PATTERNS.price.aedPriceRegex);
            if (priceMatch) {
              // Re-attach the currency prefix so downstream code has context
              orderTotal = `AED ${priceMatch[1]}`;
            }
          }
        } catch (priceErr) {
          console.warn(`${LOG} Card #${i + 1} (${orderId}): Could not read order total.`, priceErr);
        }

        // 3e. Status hint — the brief delivery/status label shown on the list card
        //     e.g. "Delivered", "Out for delivery", "Order canceled".
        //
        // Amazon renders this in different places depending on order state:
        //   1. Active orders:      .delivery-box__primary-text
        //   2. With follow-up:     .delivery-box__secondary-text
        //   3. Post-return-window: a plain <span> inside the item box, with
        //                          no distinguishing class — we locate it by
        //                          scanning the card text for known phrases.
        let statusHint = null;
        try {
          const fallbackSelectors = PATTERNS.ordersList.statusElementFallbacks
            || [PATTERNS.ordersList.statusElement];

          // Brand-label phrases that appear in `.delivery-box__primary-text`
          // but are NOT statuses (e.g. Lulu cards render "LuLu delivery" as
          // the brand label in the primary-text slot). We treat these as
          // empty so phrase-scan below can try to find a real status.
          const brandLabels = (PATTERNS.ordersList.brandLabelPhrases || [])
            .map(s => String(s).toLowerCase().trim());

          for (const sel of fallbackSelectors) {
            const els = card.querySelectorAll(sel);
            for (const el of els) {
              const text = safeText(el);
              if (!text) continue;
              if (brandLabels.includes(text.toLowerCase().trim())) continue;
              // Skip date labels that Lulu cards render in the secondary-text
              // slot, e.g. "Ordered on Wednesday, 9 July 2025". These are not
              // statuses — treat them as empty so the phrase-scan below can
              // try to find a real status.
              if (/^ordered\s/i.test(text.trim())) continue;
              statusHint = text;
              break;
            }
            if (statusHint) break;
          }

          // Last resort: scan the whole card's text for a known status phrase
          if (!statusHint) {
            const rawCardText    = safeText(card);
            const cardText       = rawCardText.replace(/[\s\t\n\r]+/g, ' ').trim();
            const cardTextLower  = cardText.toLowerCase();
            const phrases        = PATTERNS.ordersList.statusPhraseKeywords || [];

            for (const phrase of phrases) {
              const idx = cardTextLower.indexOf(phrase);
              if (idx !== -1) {
                // Capture the phrase + up to 40 chars of following context
                // (e.g. "Return window closed on 28 November 2025")
                const end = Math.min(idx + phrase.length + 40, cardText.length);
                statusHint = cardText.substring(idx, end).trim();
                break;
              }
            }
          }
        } catch (statusErr) {
          console.warn(`${LOG} Card #${i + 1} (${orderId}): Could not read status hint.`, statusErr);
        }

        // 3f. Assemble the order record and push to results
        const orderRecord = {
          orderId,
          orderType,    // 'AMAZON_NOW' | 'LULU' | 'REGULAR'
          orderDate,    // "YYYY-MM-DD" or null
          orderTotal,   // e.g. "AED 55.95" or null
          statusHint    // e.g. "Delivered" or null
        };

        console.log(
          `${LOG} Card #${i + 1}: orderId=${orderId} type=${orderType} ` +
          `date=${orderDate} total=${orderTotal} status=${statusHint}`
        );

        orders.push(orderRecord);

      } catch (cardErr) {
        // A single bad card must never stop the whole page scan
        console.warn(`${LOG} Card #${i + 1}: Unexpected error — skipping.`, cardErr);
      }
    }

    console.log(`${LOG} Successfully collected ${orders.length} order(s) from this page.`);

    // ── 4. Pagination info ────────────────────────────────────────────────────
    // The background worker uses this to decide whether to navigate to the next
    // page and re-inject Agent 1.
    const nextPageUrl     = pagination.getNextPageUrl(document);
    const hasNextPage     = nextPageUrl !== null;
    const totalOrderCount = pagination.getTotalOrderCount(document);

    // Extract the current startIndex from the page URL so the background worker
    // can track overall scraping progress.
    const currentStartIndex = pagination.getCurrentStartIndex(window.location.href);

    console.log(
      `${LOG} Pagination — hasNextPage=${hasNextPage} ` +
      `nextPageUrl=${nextPageUrl} currentStartIndex=${currentStartIndex} ` +
      `totalOrderCount=${totalOrderCount}`
    );

    // ── 5. Send results back to the background service worker ─────────────────
    chrome.runtime.sendMessage({
      action: 'RECON_PAGE_COMPLETE',
      data: {
        orders,
        hasNextPage,
        nextPageUrl,        // null on the last page
        currentStartIndex,
        totalOrderCount     // null if Amazon didn't show the count on this page
      }
    });

    console.log(`${LOG} RECON_PAGE_COMPLETE message sent.`);

  } catch (err) {
    // Top-level catch — something went badly wrong; report back so the
    // background worker knows this page failed and can decide what to do.
    console.error(`${LOG} Fatal error in runRecon():`, err);

    chrome.runtime.sendMessage({
      action: 'RECON_ERROR',
      error: err.message,
      url: window.location.href
    });
  }
};

// Let the background worker know the script is ready (useful for debugging
// injection timing issues — the worker can listen for this log line).
console.log('[AmazonExporter Agent1] agent1-recon.js loaded — window.AmazonExporter.runRecon() is ready.');
