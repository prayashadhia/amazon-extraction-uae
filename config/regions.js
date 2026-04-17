/**
 * regions.js — Region Configuration
 *
 * Centralises all Amazon region-specific settings (URLs, currency, brand IDs).
 * If you ever need to support Amazon.in or Amazon.com, add a new entry here.
 * All other files read from this config — never hard-code URLs elsewhere.
 */

const REGIONS = {
  'amazon.ae': {
    domain: 'https://www.amazon.ae',
    currency: 'AED',

    // ── Orders list (Pass 1 — DOM scraping) ──────────────────────────────────
    ordersListPath: '/gp/css/order-history',

    // ── Print summary page — Regular Amazon orders (Pass 2 — DOM scraping) ──
    printSummaryPath: '/gp/css/summary/print.html',

    // ── Lulu printable page — Lulu orders (Pass 2 — DOM scraping) ───────────
    luluPrintPath: '/uff/your-account/order-details/printable',
    luluPrintRef: 'ref_=uff_od_invoice',    // appended as query param; try without if 404

    // ── Amazon Now REST API base (Pass 2 — API extraction) ──────────────────
    nowApiBase: '/tez/order',               // endpoints appended: /getOrderDetails etc.
    nowBrandId: 'sAuWWBROaG',              // Amazon Now brand ID (used in API calls + URL detection)

    // ── Lulu brand ID (used in item URL detection on print pages) ───────────
    luluBrandId: 'Wf2HUUZ9yC',

    // ── Pagination ───────────────────────────────────────────────────────────
    ordersPerPage: 10,

    locale: 'en-AE'
  },

  'amazon.in': {
    domain: 'https://www.amazon.in',
    currency: 'INR',
    ordersListPath: '/gp/css/order-history',
    printSummaryPath: '/gp/css/summary/print.html',
    luluPrintPath: null,        // Lulu not available on amazon.in
    nowApiBase: null,           // Amazon Now may differ; set if discovered
    nowBrandId: null,
    luluBrandId: null,
    ordersPerPage: 10,
    locale: 'en-IN'
  },

  'amazon.com': {
    domain: 'https://www.amazon.com',
    currency: 'USD',
    ordersListPath: '/gp/css/order-history',
    printSummaryPath: '/gp/css/summary/print.html',
    luluPrintPath: null,
    nowApiBase: null,
    nowBrandId: null,
    luluBrandId: null,
    ordersPerPage: 10,
    locale: 'en-US'
  }
};

/**
 * getRegion(domain)
 * Returns the config object for the given domain (e.g. "www.amazon.ae").
 * Falls back to amazon.ae if the domain is not recognised.
 */
function getRegion(domain) {
  // Normalise: strip "www." prefix if present, take only the relevant part
  const key = domain.replace(/^www\./, '');
  if (REGIONS[key]) return REGIONS[key];

  // Fallback
  console.warn(`[AmazonExporter] Unknown domain "${domain}" — defaulting to amazon.ae`);
  return REGIONS['amazon.ae'];
}

// Expose on window so content scripts can access without ES6 imports
window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.REGIONS = REGIONS;
window.AmazonExporter.getRegion = getRegion;
