/**
 * background/service-worker.js — Background Service Worker (Orchestrator)
 *
 * This is the central brain of the Amazon Order Exporter extension. It:
 *
 *   1. Listens for messages from the popup (START_SCRAPE, CANCEL_SCRAPE)
 *   2. Finds (or opens) an Amazon.ae tab to work in
 *   3. Injects dependency scripts + agents into that tab in the correct order
 *   4. Drives the four-agent pipeline:
 *        Agent 1 → scans every page of the orders list (paginated)
 *        Agent 2 → routes each order to the right extraction strategy
 *        Agent 3 → extracts data for each order, one at a time
 *        Agent 4 → validates all extracted rows
 *   5. Triggers the Excel export in the Amazon tab (SheetJS + export-xlsx.js)
 *   6. Sends progress updates back to the popup throughout
 *
 * MV3 RESILIENCE
 * --------------
 * Chrome can kill Manifest V3 service workers at any time, even mid-job.
 * To survive this, after every meaningful state change we save the full job
 * state to chrome.storage.session.  On startup we check for an interrupted
 * job and resume from where we left off.
 *
 * IMPORTANT NOTES
 * ---------------
 * - No ES6 imports — plain browser JavaScript only
 * - All async operations are wrapped in try/catch
 * - Every log line is prefixed with [AmazonExporter SW] for easy filtering
 * - If the popup is closed mid-scrape, the job continues in the background
 *   and the file downloads automatically when done
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const LOG = '[AmazonExporter SW]';

/**
 * Dependency scripts that must be injected into the Amazon tab BEFORE any
 * agent runs.  These set up window.AmazonExporter.* (patterns, extractors,
 * helpers, etc.).  Always inject as a single batch so they share the same
 * window context.
 */
const DEP_SCRIPTS = [
  'config/regions.js',
  'config/patterns.js',
  'utils/dom-helpers.js',
  'utils/api-helpers.js',
  'utils/pagination.js',
  'extractors/order-id.js',
  'extractors/order-type.js',
  'extractors/order-date.js',
  'extractors/item-description.js',
  'extractors/price.js',
  'extractors/quantity.js',
  'extractors/payment-method.js',
  'extractors/shipment-status.js',
  'extractors/seller.js',
  'classifiers/category-classifier.js'
];

const AGENT1 = 'agents/agent1-recon.js';
const AGENT2 = 'agents/agent2-strategy.js';
const AGENT3 = 'agents/agent3-executor.js';
const AGENT4 = 'agents/agent4-validator.js';

/** Export scripts — injected only in the final export step. */
const EXPORT_SCRIPTS = ['lib/xlsx.min.js', 'utils/export-xlsx.js'];

/**
 * The default URL used when the user's current tab is NOT already on an
 * Amazon orders list page. If the tab IS already on an orders page, we
 * preserve the user's filter (year, archived, date range, etc.) and only
 * reset startIndex=0 so the scrape always begins at page 1. See
 * resolveOrdersListUrl() below.
 */
const ORDERS_LIST_URL = 'https://www.amazon.ae/gp/css/order-history?startIndex=0';

/**
 * Returns true if `url` points at an Amazon.ae orders list page.
 * Matches both the legacy and current order-history paths.
 */
function isOrdersListUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.amazon.ae') return false;
    const p = u.pathname;
    return (
      p.startsWith('/gp/css/order-history') ||
      p.startsWith('/gp/your-account/order-history') ||
      p.startsWith('/your-orders/orders')
    );
  } catch {
    return false;
  }
}

/**
 * If the user's tab is already on an orders list page, return that URL with
 * startIndex forced to 0 (preserves every other filter: timeFilter, orderFilter,
 * search, etc.). Otherwise return the default ORDERS_LIST_URL.
 */
function resolveOrdersListUrl(tabUrl) {
  if (!isOrdersListUrl(tabUrl)) return ORDERS_LIST_URL;
  try {
    const u = new URL(tabUrl);
    u.searchParams.set('startIndex', '0');
    return u.toString();
  } catch {
    return ORDERS_LIST_URL;
  }
}

/**
 * Delay (ms) between processing consecutive orders in Agent 3.
 * Keeps us from hammering Amazon's servers and reduces the risk of being
 * rate-limited or temporarily blocked.
 */
const BETWEEN_ORDER_DELAY_MS = 1500;

/**
 * How long (ms) to wait for a tab navigation to complete before giving up.
 * 30 seconds should cover even very slow connections.
 */
const TAB_LOAD_TIMEOUT_MS = 30000;


// ─────────────────────────────────────────────────────────────────────────────
// JOB STATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory job state.  Also persisted to chrome.storage.session after every
 * meaningful change so we can resume if the service worker is killed.
 *
 * Fields:
 *   status             — current pipeline stage (see STATUS_* constants below)
 *   tabId              — the Amazon tab we injected scripts into
 *   allOrders          — array of order objects collected by Agent 1
 *   routedOrders       — array of routed order objects produced by Agent 2
 *   extractedRows      — growing array of item rows produced by Agent 3
 *   currentOrderIndex  — which index in routedOrders Agent 3 is working on
 *   errorCount         — number of orders where extraction fully failed
 *   reconPageCount     — how many orders-list pages have been scanned so far
 *   estimatedTotalPages— estimated total pages (derived from totalOrderCount)
 *   validRows          — final validated rows from Agent 4
 *   errorRows          — validation errors from Agent 4
 */
/** Allowed values for state.status */
const STATUS = {
  IDLE:        'idle',
  RECON:       'recon',
  STRATEGY:    'strategy',
  EXECUTING:   'executing',
  VALIDATING:  'validating',
  EXPORTING:   'exporting',
  DONE:        'done',
  ERROR:       'error',
  CANCELLED:   'cancelled'
};

let state = createFreshState();

/** Returns a blank, ready-to-use state object. */
function createFreshState() {
  return {
    status:             STATUS.IDLE,
    tabId:              null,
    allOrders:          [],
    routedOrders:       [],
    extractedRows:      [],
    currentOrderIndex:  0,
    errorCount:         0,
    reconPageCount:     0,
    estimatedTotalPages: null,
    depsInjectedForExecution: false,
    validRows:          [],
    errorRows:          []
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// STARTUP — resume any interrupted job
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  console.log(`${LOG} Service worker started — checking for an interrupted job...`);

  try {
    const saved = await chrome.storage.session.get('scraperState');

    if (!saved.scraperState) {
      console.log(`${LOG} No saved state found — starting fresh.`);
      return;
    }

    const savedState = saved.scraperState;
    console.log(`${LOG} Found saved state with status="${savedState.status}".`);

    // Only attempt to resume jobs that were actively executing.
    // Recon and strategy phases are fast enough to restart from scratch, so
    // we only resume from the execution loop (Agent 3).
    if (savedState.status === STATUS.EXECUTING && savedState.tabId !== null) {
      console.log(
        `${LOG} Resuming execution from order index ${savedState.currentOrderIndex} ` +
        `of ${savedState.routedOrders ? savedState.routedOrders.length : 0}.`
      );

      // Restore the in-memory state from the saved snapshot
      state = savedState;

      // Verify the tab still exists before trying to inject anything
      try {
        await chrome.tabs.get(state.tabId);
        console.log(`${LOG} Tab ${state.tabId} still exists — re-injecting deps and resuming.`);

        // Re-inject dependencies into the tab (they may have been cleared when
        // the service worker was killed) then continue the execution loop
        await injectDependencies(state.tabId);
        executionLoop();

      } catch (tabErr) {
        // The tab was closed — we cannot resume without navigating somewhere.
        // Clear the stale state so the user can start fresh from the popup.
        console.warn(
          `${LOG} Tab ${state.tabId} no longer exists (${tabErr.message}). ` +
          `Cannot resume — clearing saved state.`
        );
        state = createFreshState();
        await saveState();
      }

    } else if (savedState.status === STATUS.DONE || savedState.status === STATUS.CANCELLED) {
      // Job was already finished — clean up the saved state
      console.log(`${LOG} Previous job finished with status="${savedState.status}" — clearing state.`);
      await clearSavedState();

    } else {
      // Recon, strategy, validating, exporting — or an error state.
      // These are either too complex to resume mid-way, or already finished,
      // so we just clear them and let the user restart.
      console.log(
        `${LOG} Previous job was in status="${savedState.status}" — ` +
        `cannot safely resume. Clearing state.`
      );
      state = createFreshState();
      await clearSavedState();
    }

  } catch (err) {
    console.error(`${LOG} Error during startup resume:`, err);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE LISTENER
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message && message.action;
  console.log(`${LOG} Received message: action="${action}"`);

  // Acknowledge immediately so Chrome closes the message port cleanly.
  // Every handler below is fire-and-forget — real updates go back to the
  // popup via chrome.runtime.sendMessage (see sendToPopup). Without this
  // ack, Chrome surfaces "The message port closed before a response was
  // received" as a spurious lastError on the sender's callback.
  try { sendResponse({ ack: true }); } catch (_) { /* popup may be closed */ }

  // Route each incoming message to its handler.
  // We use an async IIFE so we can use await inside the listener.
  (async () => {
    try {
      switch (action) {

        // ── From popup ─────────────────────────────────────────────────────
        case 'START_SCRAPE':
          await startScrape();
          break;

        case 'CANCEL_SCRAPE':
          await cancelScrape();
          break;

        // ── From Agent 1 ───────────────────────────────────────────────────
        case 'RECON_PAGE_COMPLETE':
          await handleReconPage(message.data);
          break;

        case 'RECON_ERROR':
          await handleError(`Agent 1 recon error: ${message.error}`);
          break;

        // ── From Agent 2 ───────────────────────────────────────────────────
        // (Agent 2 also returns its result synchronously, but we handle the
        //  message too, for consistency — see runStrategyInTab() below)
        case 'STRATEGY_COMPLETE':
          // Handled synchronously in runStrategyInTab(); message is a no-op here.
          console.log(`${LOG} Received STRATEGY_COMPLETE message (handled synchronously — ignoring).`);
          break;

        case 'STRATEGY_ERROR':
          await handleError(`Agent 2 strategy error: ${message.error}`);
          break;

        // ── From Agent 3 ───────────────────────────────────────────────────
        case 'EXECUTOR_COMPLETE':
          await handleExecutorResult(message.data);
          break;

        case 'EXECUTOR_ERROR':
          await handleError(`Agent 3 executor error: ${message.error}`);
          break;

        // ── From Agent 4 ───────────────────────────────────────────────────
        case 'VALIDATOR_COMPLETE':
          await handleValidatorResult(message.data);
          break;

        default:
          // Unknown action — log it, but don't crash
          console.warn(`${LOG} Received unknown message action: "${action}"`, message);
      }
    } catch (err) {
      console.error(`${LOG} Uncaught error in message handler for action="${action}":`, err);
      await handleError(`Internal error handling "${action}": ${err.message}`);
    }
  })();

  // sendResponse() was already called synchronously above, so the port is
  // closed cleanly. Returning false tells Chrome there's no async reply
  // coming — it must not keep the port open.
  return false;
});


// ─────────────────────────────────────────────────────────────────────────────
// startScrape()
// Called when the popup sends START_SCRAPE
// ─────────────────────────────────────────────────────────────────────────────

async function startScrape() {
  console.log(`${LOG} startScrape() — initialising job.`);

  // Prevent double-starts: if a job is already running, ignore the request
  if (state.status !== STATUS.IDLE && state.status !== STATUS.DONE &&
      state.status !== STATUS.ERROR && state.status !== STATUS.CANCELLED) {
    console.warn(`${LOG} A scrape is already in progress (status="${state.status}") — ignoring START_SCRAPE.`);
    sendToPopup('ERROR', { message: 'A scrape is already in progress. Please wait for it to finish.' });
    return;
  }

  // Reset everything
  state = createFreshState();
  state.status = STATUS.RECON;

  try {
    // ── 1. Find or open an Amazon.ae tab ─────────────────────────────────────
    const { tabId, url: currentTabUrl } = await findOrOpenAmazonTab();
    state.tabId = tabId;
    await saveState();

    console.log(`${LOG} Using tab ${tabId} for scraping.`);

    // ── 2. Navigate the tab to page 1 of the orders list ────────────────────
    // If the tab is already on an orders list page, we keep the user's filter
    // (year, archived, etc.) and only reset startIndex=0. Otherwise we fall
    // back to the default orders URL.
    const targetUrl = resolveOrdersListUrl(currentTabUrl);
    const filterPreserved = targetUrl !== ORDERS_LIST_URL;
    console.log(
      `${LOG} Orders list URL: ${targetUrl}` +
      (filterPreserved ? ' (preserving tab filter)' : ' (default)')
    );

    sendToPopup('PROGRESS', {
      stage:   'Opening orders page...',
      current: 0,
      total:   0,
      message: filterPreserved
        ? 'Navigating to page 1 of your current filter...'
        : 'Navigating to your Amazon orders list...'
    });

    await navigateTab(tabId, targetUrl);

    console.log(`${LOG} Tab navigated to orders list. Injecting Agent 1...`);

    // ── 3. Inject deps + Agent 1 to scan page 1 ──────────────────────────────
    sendToPopup('PROGRESS', {
      stage:   'Scanning orders...',
      current: 0,
      total:   0,
      message: 'Reading your order list (page 1)...'
    });

    await injectDependencies(tabId);
    await injectAndRunAgent1(tabId);

    // From here the flow is event-driven:
    // Agent 1 → RECON_PAGE_COMPLETE → handleReconPage()
    // If more pages: navigate + re-inject Agent 1
    // If done: runStrategyInTab() → executionLoop() → …

  } catch (err) {
    console.error(`${LOG} startScrape() failed:`, err);
    await handleError(`Failed to start scrape: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// handleReconPage(data)
// Called each time Agent 1 finishes scanning one orders-list page
// ─────────────────────────────────────────────────────────────────────────────

async function handleReconPage(data) {
  if (state.status === STATUS.CANCELLED) return;

  console.log(
    `${LOG} handleReconPage() — got ${data.orders ? data.orders.length : 0} order(s). ` +
    `hasNextPage=${data.hasNextPage} totalOrderCount=${data.totalOrderCount}`
  );

  // Accumulate the orders found on this page
  if (Array.isArray(data.orders)) {
    state.allOrders = state.allOrders.concat(data.orders);
  }

  // Track pagination progress
  state.reconPageCount++;

  // Estimate total pages if Amazon told us the total order count
  if (data.totalOrderCount && !state.estimatedTotalPages) {
    state.estimatedTotalPages = Math.ceil(data.totalOrderCount / 10); // 10 orders/page
  }

  await saveState();

  // Report progress to the popup
  sendToPopup('PROGRESS', {
    stage:   'Scanning orders...',
    current: state.reconPageCount,
    total:   state.estimatedTotalPages || 0,
    message: `Found ${state.allOrders.length} order(s) so far...`
  });

  if (data.hasNextPage && data.nextPageUrl) {
    // ── More pages to scan: navigate and re-inject Agent 1 ──────────────────
    console.log(`${LOG} Navigating to next orders page: ${data.nextPageUrl}`);

    try {
      // nextPageUrl from pagination.js is an absolute URL or a path.
      // Ensure it is always a full URL.
      const nextUrl = data.nextPageUrl.startsWith('http')
        ? data.nextPageUrl
        : `https://www.amazon.ae${data.nextPageUrl}`;

      await navigateTab(state.tabId, nextUrl);
      await injectDependencies(state.tabId);
      await injectAndRunAgent1(state.tabId);

    } catch (err) {
      console.error(`${LOG} Error navigating to next page:`, err);
      await handleError(`Failed to navigate to next orders page: ${err.message}`);
    }

  } else {
    // ── All pages scanned — proceed to strategy phase ────────────────────────
    console.log(
      `${LOG} All orders-list pages scanned. ` +
      `Total orders collected: ${state.allOrders.length}.`
    );

    if (state.allOrders.length === 0) {
      await handleError(
        'No orders were found on your Amazon orders page. ' +
        'Please make sure you are logged in and have orders in the selected time period.'
      );
      return;
    }

    sendToPopup('PROGRESS', {
      stage:   'Planning extraction...',
      current: state.allOrders.length,
      total:   state.allOrders.length,
      message: `Found ${state.allOrders.length} order(s). Planning how to extract each one...`
    });

    await runStrategyInTab();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// runStrategyInTab()
// Inject Agent 2 and call it synchronously to get routing plans for all orders
// ─────────────────────────────────────────────────────────────────────────────

async function runStrategyInTab() {
  if (state.status === STATUS.CANCELLED) return;

  console.log(`${LOG} runStrategyInTab() — routing ${state.allOrders.length} order(s).`);
  state.status = STATUS.STRATEGY;
  await saveState();

  try {
    // Agent 2 is pure routing logic — no network requests, no DOM access.
    // We inject it and then call it synchronously via executeScript's func:
    // this avoids the async message round-trip and gives us the result directly.
    await injectScripts(state.tabId, [...DEP_SCRIPTS, AGENT2]);

    // Get the region config for the tab's domain
    const regionConfig = await getRegionConfig(state.tabId);

    // Call runStrategy synchronously — it returns the routedOrders array
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: function(orders, region) {
        // window.AmazonExporter.runStrategy is loaded by the injected AGENT2 file
        if (typeof window.AmazonExporter.runStrategy !== 'function') {
          throw new Error('window.AmazonExporter.runStrategy is not available — agent2 may not have loaded.');
        }
        return window.AmazonExporter.runStrategy(orders, region);
      },
      args: [state.allOrders, regionConfig]
    });

    // results is an array of frame results; frame 0 is the main page
    const routedOrders = results && results[0] && results[0].result;

    if (!Array.isArray(routedOrders) || routedOrders.length === 0) {
      throw new Error(
        'Agent 2 returned an empty or invalid routing result. ' +
        `Got: ${JSON.stringify(routedOrders)}`
      );
    }

    console.log(`${LOG} Strategy complete — ${routedOrders.length} order(s) routed.`);

    state.routedOrders      = routedOrders;
    state.currentOrderIndex = 0;
    state.status            = STATUS.EXECUTING;
    await saveState();

    sendToPopup('PROGRESS', {
      stage:   'Extracting orders...',
      current: 0,
      total:   state.routedOrders.length,
      message: `Starting extraction of ${state.routedOrders.length} order(s)...`
    });

    // Kick off the execution loop (processes one order at a time)
    executionLoop();

  } catch (err) {
    console.error(`${LOG} runStrategyInTab() failed:`, err);
    await handleError(`Strategy phase failed: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// executionLoop()
// Processes one order at a time via Agent 3, then waits for EXECUTOR_COMPLETE
// ─────────────────────────────────────────────────────────────────────────────

async function executionLoop() {
  // ── Check for cancellation ──────────────────────────────────────────────────
  if (state.status === STATUS.CANCELLED) {
    console.log(`${LOG} executionLoop() — job was cancelled. Stopping.`);
    return;
  }

  // ── Check if all orders have been processed ─────────────────────────────────
  if (state.currentOrderIndex >= state.routedOrders.length) {
    console.log(
      `${LOG} executionLoop() — all ${state.routedOrders.length} order(s) processed. ` +
      `Proceeding to validation.`
    );
    await runValidationInTab();
    return;
  }

  const order = state.routedOrders[state.currentOrderIndex];
  const orderNum = state.currentOrderIndex + 1;

  console.log(
    `${LOG} executionLoop() — processing order ${orderNum}/${state.routedOrders.length}: ` +
    `${order.orderId} (type: ${order.orderType})`
  );

  sendToPopup('PROGRESS', {
    stage:   'Extracting orders...',
    current: orderNum,
    total:   state.routedOrders.length,
    message: `Extracting order ${orderNum} of ${state.routedOrders.length}: ${order.orderId}...`
  });

  try {
    // Get the region config (needed by Agent 3 for URL building and API calls)
    const regionConfig = await getRegionConfig(state.tabId);

    // ── Inject deps + Agent 3, then call runExecutor with the current order ──
    // Inject dependency scripts only once at the start of the execution phase.
    // Agent 3 uses fetch() not tab navigation, so the window context persists
    // across orders and deps only need to be loaded once.
    if (!state.depsInjectedForExecution) {
      await injectScripts(state.tabId, DEP_SCRIPTS);
      state.depsInjectedForExecution = true;
    }
    await injectScripts(state.tabId, [AGENT3]);

    // Call runExecutor — Agent 3 will send back EXECUTOR_COMPLETE when done.
    // We do NOT await a return value here; the result comes back as a message.
    // The func is async in the tab, so we just trigger it and move on.
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: async function(routedOrder, region) {
        // runExecutor is async; it sends EXECUTOR_COMPLETE when it finishes.
        // We await it here so Chrome keeps the script alive until it completes.
        if (typeof window.AmazonExporter.runExecutor !== 'function') {
          throw new Error('window.AmazonExporter.runExecutor is not available — agent3 may not have loaded.');
        }
        await window.AmazonExporter.runExecutor(routedOrder, region);
      },
      args: [order, regionConfig]
    });

    // At this point, Agent 3 is running inside the tab (async).
    // When it finishes, it sends EXECUTOR_COMPLETE → handleExecutorResult()
    // which will call executionLoop() for the next order.

  } catch (err) {
    // Injection or call failed entirely — treat this order as an error
    // and move on to the next one rather than halting the whole job.
    console.error(
      `${LOG} Failed to inject/run Agent 3 for order ${order.orderId}:`, err
    );

    // Record it as an extraction failure
    state.extractedRows.push({
      orderId:     order.orderId,
      _failed:     true,
      _error:      err.message,
      _attemptCount: 0
    });
    state.errorCount++;
    state.currentOrderIndex++;
    await saveState();

    // Wait before next order to avoid hammering the server
    await delay(BETWEEN_ORDER_DELAY_MS);
    executionLoop();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// handleExecutorResult(data)
// Called when Agent 3 sends EXECUTOR_COMPLETE for an order
// ─────────────────────────────────────────────────────────────────────────────

async function handleExecutorResult(data) {
  if (state.status === STATUS.CANCELLED) return;

  const { orderId, rows, failed } = data || {};

  console.log(
    `${LOG} handleExecutorResult() — orderId=${orderId} ` +
    `rows=${rows ? rows.length : 0} failed=${failed}`
  );

  // Accumulate the extracted rows
  if (Array.isArray(rows) && rows.length > 0) {
    state.extractedRows = state.extractedRows.concat(rows);
  }

  if (failed) {
    state.errorCount++;
  }

  // Advance to the next order
  state.currentOrderIndex++;
  // Save every 10 orders to avoid constant I/O. Always save the first and last.
  if (state.currentOrderIndex % 10 === 0 || state.currentOrderIndex >= state.routedOrders.length) {
    await saveState();
  }

  // Brief pause before the next order — respect Amazon's servers
  await delay(BETWEEN_ORDER_DELAY_MS);

  // Loop to the next order (or finish if all done)
  executionLoop();
}


// ─────────────────────────────────────────────────────────────────────────────
// runValidationInTab()
// Inject Agent 4 and call it to validate all extracted rows
// ─────────────────────────────────────────────────────────────────────────────

async function runValidationInTab() {
  if (state.status === STATUS.CANCELLED) return;

  console.log(
    `${LOG} runValidationInTab() — validating ${state.extractedRows.length} row(s).`
  );

  state.status = STATUS.VALIDATING;
  await saveState();

  sendToPopup('PROGRESS', {
    stage:   'Validating data...',
    current: state.routedOrders.length,
    total:   state.routedOrders.length,
    message: `Checking ${state.extractedRows.length} item row(s) for data quality...`
  });

  try {
    await injectScripts(state.tabId, [...DEP_SCRIPTS, AGENT4]);

    // Call runValidator synchronously — it returns { validRows, errorRows }
    // and also sends VALIDATOR_COMPLETE (which we handle in handleValidatorResult).
    // We use the synchronous return value here so we don't have to wait for the message.
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: function(rows) {
        if (typeof window.AmazonExporter.runValidator !== 'function') {
          throw new Error('window.AmazonExporter.runValidator is not available — agent4 may not have loaded.');
        }
        return window.AmazonExporter.runValidator(rows);
      },
      args: [state.extractedRows]
    });

    const validationResult = results && results[0] && results[0].result;

    if (!validationResult) {
      throw new Error('Agent 4 returned an empty validation result.');
    }

    await handleValidatorResult(validationResult);

  } catch (err) {
    console.error(`${LOG} runValidationInTab() failed:`, err);
    await handleError(`Validation phase failed: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// handleValidatorResult(data)
// Called when Agent 4 sends VALIDATOR_COMPLETE, or directly from runValidationInTab
// ─────────────────────────────────────────────────────────────────────────────

async function handleValidatorResult(data) {
  if (state.status === STATUS.CANCELLED) return;

  // Guard against duplicate calls: once we have valid rows, don't process again
  if (state.status === STATUS.EXPORTING || state.status === STATUS.DONE) {
    console.log(`${LOG} handleValidatorResult() called but already in status="${state.status}" — ignoring.`);
    return;
  }

  const { validRows, errorRows, stats } = data || {};

  console.log(
    `${LOG} handleValidatorResult() — validRows=${validRows ? validRows.length : 0} ` +
    `errorRows=${errorRows ? errorRows.length : 0}`
  );

  if (stats) {
    console.log(
      `${LOG} Validation stats — total=${stats.total} passed=${stats.passed} ` +
      `warned=${stats.warned} failed=${stats.failed}`
    );
  }

  state.validRows  = Array.isArray(validRows)  ? validRows  : [];
  state.errorRows  = Array.isArray(errorRows)  ? errorRows  : [];
  state.status     = STATUS.EXPORTING;
  await saveState();

  sendToPopup('PROGRESS', {
    stage:   'Exporting to Excel...',
    current: state.routedOrders.length,
    total:   state.routedOrders.length,
    message: `Generating Excel file with ${state.validRows.length} item row(s)...`
  });

  await runExport();
}


// ─────────────────────────────────────────────────────────────────────────────
// runExport()
// Inject SheetJS + export-xlsx.js and trigger the Excel download
// ─────────────────────────────────────────────────────────────────────────────

async function runExport() {
  if (state.status === STATUS.CANCELLED) return;

  console.log(`${LOG} runExport() — exporting ${state.validRows.length} valid row(s).`);

  try {
    // Inject SheetJS first, then our export wrapper
    await injectScripts(state.tabId, EXPORT_SCRIPTS);

    // Call exportToExcel synchronously — it returns { success, filename, rowCount }
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: function(rows, errors) {
        if (typeof window.AmazonExporter.exportToExcel !== 'function') {
          throw new Error('window.AmazonExporter.exportToExcel is not available — export-xlsx.js may not have loaded.');
        }
        return window.AmazonExporter.exportToExcel({ rows: rows, errors: errors });
      },
      args: [state.validRows, state.errorRows]
    });

    const exportResult = results && results[0] && results[0].result;

    if (!exportResult) {
      throw new Error('exportToExcel returned an empty result.');
    }

    if (!exportResult.success) {
      throw new Error(`exportToExcel reported failure: ${exportResult.error}`);
    }

    console.log(
      `${LOG} Export complete — file: "${exportResult.filename}", ` +
      `rows: ${exportResult.rowCount}.`
    );

    // ── Job complete ─────────────────────────────────────────────────────────
    state.status = STATUS.DONE;
    await saveState();

    // Count unique order IDs in the valid rows to report "X orders, Y items"
    const uniqueOrderIds = new Set(
      state.validRows.map(r => r.orderId).filter(Boolean)
    );

    sendToPopup('COMPLETE', {
      orderCount: uniqueOrderIds.size,
      itemCount:  state.validRows.length,
      errorCount: state.errorRows.length + state.errorCount,
      filename:   exportResult.filename
    });

    // Clean up the session storage — job is done
    await clearSavedState();
    console.log(`${LOG} Job finished successfully.`);

  } catch (err) {
    console.error(`${LOG} runExport() failed:`, err);
    await handleError(`Export failed: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// cancelScrape()
// Called when the popup sends CANCEL_SCRAPE
// ─────────────────────────────────────────────────────────────────────────────

async function cancelScrape() {
  console.log(`${LOG} cancelScrape() — setting status to cancelled.`);

  state.status = STATUS.CANCELLED;
  await saveState();

  sendToPopup('PROGRESS', {
    stage:   'Cancelled',
    current: state.currentOrderIndex,
    total:   state.routedOrders.length,
    message: 'Scrape cancelled by user.'
  });

  console.log(`${LOG} Scrape cancelled. Extracted ${state.extractedRows.length} row(s) before cancellation.`);

  // Clean up session storage
  await clearSavedState();
}


// ─────────────────────────────────────────────────────────────────────────────
// handleError(errorMsg)
// Called whenever a fatal or unrecoverable error occurs
// ─────────────────────────────────────────────────────────────────────────────

async function handleError(errorMsg) {
  console.error(`${LOG} handleError(): ${errorMsg}`);

  state.status = STATUS.ERROR;
  await saveState();

  sendToPopup('ERROR', { message: errorMsg });
}


// ─────────────────────────────────────────────────────────────────────────────
// TAB MANAGEMENT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * findOrOpenAmazonTab()
 *
 * Looks for an existing Amazon.ae tab.  If one exists, returns its ID.
 * If none exists, opens a new tab at the orders list URL and returns its ID.
 *
 * @returns {Promise<number>} Tab ID
 */
async function findOrOpenAmazonTab() {
  // Query for any tab on Amazon.ae
  const existingTabs = await chrome.tabs.query({ url: 'https://www.amazon.ae/*' });

  if (existingTabs.length > 0) {
    // Prefer a tab that's already on an orders list page — that's the one
    // whose filter (year, archived, etc.) we want to preserve.
    const ordersTab = existingTabs.find(t => isOrdersListUrl(t.url));
    const tab = ordersTab || existingTabs[0];
    console.log(`${LOG} Found existing Amazon.ae tab: ${tab.id} (${tab.url})`);
    return { tabId: tab.id, url: tab.url };
  }

  // No existing tab — open a new one
  console.log(`${LOG} No Amazon.ae tab found — opening a new tab.`);
  const newTab = await chrome.tabs.create({ url: ORDERS_LIST_URL, active: false });
  console.log(`${LOG} Opened new tab: ${newTab.id}`);
  return { tabId: newTab.id, url: ORDERS_LIST_URL };
}

/**
 * navigateTab(tabId, url)
 *
 * Navigates a tab to the specified URL and waits for it to finish loading.
 * Rejects if the tab does not finish loading within TAB_LOAD_TIMEOUT_MS.
 *
 * @param {number} tabId - The tab to navigate
 * @param {string} url   - The URL to load
 * @returns {Promise<void>}
 */
async function navigateTab(tabId, url) {
  console.log(`${LOG} navigateTab(${tabId}) → ${url}`);

  // Navigate the tab
  await chrome.tabs.update(tabId, { url });

  // Wait for the tab to fully load
  await waitForTabLoad(tabId);
}

/**
 * waitForTabLoad(tabId)
 *
 * Returns a Promise that resolves when the given tab reaches status 'complete'.
 * If the tab is ALREADY complete before we start listening, we detect that too.
 * Rejects after TAB_LOAD_TIMEOUT_MS milliseconds.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    let timeoutHandle = null;
    let listenerAttached = false;

    // Clean-up helper — removes the listener and clears the timeout
    function cleanup() {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (listenerAttached) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
    }

    // Called for every tab update event
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;  // Not our tab
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    }

    // Set the timeout first
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Tab ${tabId} did not finish loading within ${TAB_LOAD_TIMEOUT_MS / 1000}s. ` +
        'Check your internet connection or try again.'
      ));
    }, TAB_LOAD_TIMEOUT_MS);

    // Attach the listener
    chrome.tabs.onUpdated.addListener(onUpdated);
    listenerAttached = true;

    // Also check whether the tab is ALREADY complete (race condition avoidance:
    // if the navigation completed before we attached the listener, we'd wait forever)
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        cleanup();
        resolve();
      }
    }).catch(err => {
      // Tab may have been closed — pass the error up
      cleanup();
      reject(err);
    });
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// SCRIPT INJECTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * injectScripts(tabId, files)
 *
 * Injects one or more extension scripts into a tab.
 * All files are injected as a single batch so they share the same window context.
 * If injection fails (e.g. the tab navigated away), throws an error.
 *
 * @param {number}   tabId - Target tab
 * @param {string[]} files - Array of extension-relative file paths
 * @returns {Promise<void>}
 */
async function injectScripts(tabId, files) {
  console.log(`${LOG} injectScripts(${tabId}) — injecting ${files.length} file(s): ${files.join(', ')}`);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  files
    });
    console.log(`${LOG} Injection successful for: ${files.join(', ')}`);
  } catch (err) {
    throw new Error(
      `Failed to inject scripts into tab ${tabId}: ${err.message}. ` +
      `Files: ${files.join(', ')}`
    );
  }
}

/**
 * injectDependencies(tabId)
 *
 * Injects ALL dependency scripts (regions, patterns, helpers, all extractors)
 * in a single batch.  This is called before every agent injection.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function injectDependencies(tabId) {
  await injectScripts(tabId, DEP_SCRIPTS);
}

/**
 * injectAndRunAgent1(tabId)
 *
 * Injects Agent 1 into the tab and then calls runRecon() on it.
 * Agent 1 sends RECON_PAGE_COMPLETE back when it's done.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function injectAndRunAgent1(tabId) {
  // Inject the agent script (this also registers window.AmazonExporter.runRecon)
  await injectScripts(tabId, [AGENT1]);

  // Call the agent's entry point
  await chrome.scripting.executeScript({
    target: { tabId },
    func: function() {
      if (typeof window.AmazonExporter.runRecon !== 'function') {
        throw new Error(
          'window.AmazonExporter.runRecon is not available — agent1 may not have loaded correctly.'
        );
      }
      window.AmazonExporter.runRecon();
    }
  });

  console.log(`${LOG} Agent 1 runRecon() triggered — waiting for RECON_PAGE_COMPLETE message.`);
}


// ─────────────────────────────────────────────────────────────────────────────
// REGION CONFIG HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getRegionConfig(tabId)
 *
 * Reads the domain of the given tab and returns the appropriate region config
 * object by calling window.AmazonExporter.getRegion() inside the tab.
 *
 * Requires DEP_SCRIPTS to already be injected (which includes config/regions.js).
 *
 * @param {number} tabId
 * @returns {Promise<Object>} Region config (see config/regions.js)
 */
async function getRegionConfig(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: function() {
        if (typeof window.AmazonExporter.getRegion !== 'function') {
          // regions.js hasn't loaded yet — return the hardcoded amazon.ae config
          return {
            domain:           'https://www.amazon.ae',
            currency:         'AED',
            ordersListPath:   '/gp/css/order-history',
            printSummaryPath: '/gp/css/summary/print.html',
            luluPrintPath:    '/uff/your-account/order-details/printable',
            luluPrintRef:     'ref_=uff_od_invoice',
            nowApiBase:       '/tez/order',
            nowBrandId:       'sAuWWBROaG',
            luluBrandId:      'Wf2HUUZ9yC',
            ordersPerPage:    10,
            locale:           'en-AE'
          };
        }
        return window.AmazonExporter.getRegion(window.location.hostname);
      }
    });

    const regionConfig = results && results[0] && results[0].result;
    if (!regionConfig) {
      throw new Error('getRegionConfig returned empty result');
    }

    return regionConfig;

  } catch (err) {
    // If we can't read the region, fall back to amazon.ae config
    console.warn(`${LOG} getRegionConfig() failed (${err.message}) — using amazon.ae defaults.`);
    return {
      domain:           'https://www.amazon.ae',
      currency:         'AED',
      ordersListPath:   '/gp/css/order-history',
      printSummaryPath: '/gp/css/summary/print.html',
      luluPrintPath:    '/uff/your-account/order-details/printable',
      luluPrintRef:     'ref_=uff_od_invoice',
      nowApiBase:       '/tez/order',
      nowBrandId:       'sAuWWBROaG',
      luluBrandId:      'Wf2HUUZ9yC',
      ordersPerPage:    10,
      locale:           'en-AE'
    };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// COMMUNICATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sendToPopup(action, data)
 *
 * Sends a message to the extension popup using chrome.runtime.sendMessage.
 * Wrapped in try/catch because the popup may have been closed — that is fine,
 * the job continues silently in the background.
 *
 * @param {string} action  - One of: 'PROGRESS', 'COMPLETE', 'ERROR'
 * @param {Object} data    - Payload to attach to the message
 */
function sendToPopup(action, data) {
  try {
    chrome.runtime.sendMessage({ action, data });
  } catch (err) {
    // Popup is closed — this is expected, not an error
    console.log(`${LOG} sendToPopup("${action}") — popup appears to be closed (${err.message}). Continuing.`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * saveState()
 *
 * Persists the current in-memory state to chrome.storage.session.
 * Session storage is cleared automatically when the browser is closed,
 * but survives service worker restarts within the same browser session.
 *
 * Note: chrome.storage.session has a 1 MB limit per item.
 * If extractedRows grows very large (thousands of rows), this could hit
 * the limit.  To mitigate, we only store the fields needed for resumption.
 *
 * @returns {Promise<void>}
 */
async function saveState() {
  try {
    // Only save the fields that are truly needed to resume.
    // This keeps the serialised payload as small as possible.
    const stateToSave = {
      status:             state.status,
      tabId:              state.tabId,
      allOrders:          state.allOrders,
      routedOrders:       state.routedOrders,
      // extractedRows is kept in memory only — it can be large (1000+ rows) and
      // would quickly hit session storage limits. On resume, the execution loop
      // picks up from currentOrderIndex and re-extracts any unprocessed orders.
      currentOrderIndex:  state.currentOrderIndex,
      depsInjectedForExecution: state.depsInjectedForExecution,
      errorCount:         state.errorCount,
      reconPageCount:     state.reconPageCount,
      estimatedTotalPages: state.estimatedTotalPages
      // validRows and errorRows are only produced at the end and don't need saving
    };

    await chrome.storage.session.set({ scraperState: stateToSave });

  } catch (err) {
    // Storage errors should not crash the job — log and continue
    console.warn(`${LOG} saveState() failed (${err.message}). Job will continue but cannot be resumed if service worker is killed.`);
  }
}

/**
 * clearSavedState()
 *
 * Removes the persisted state from chrome.storage.session.
 * Called when a job completes, errors out, or is cancelled.
 *
 * @returns {Promise<void>}
 */
async function clearSavedState() {
  try {
    await chrome.storage.session.remove('scraperState');
    console.log(`${LOG} Cleared saved state from session storage.`);
  } catch (err) {
    console.warn(`${LOG} clearSavedState() failed: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * delay(ms)
 *
 * Returns a Promise that resolves after `ms` milliseconds.
 * Used to pace Agent 3 requests so we don't hammer Amazon's servers.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ─────────────────────────────────────────────────────────────────────────────
// STARTUP LOG
// ─────────────────────────────────────────────────────────────────────────────

console.log(`${LOG} service-worker.js loaded and ready.`);
