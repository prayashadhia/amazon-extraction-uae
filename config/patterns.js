/**
 * patterns.js — CSS Selectors, Regex Patterns & Detection Logic
 *
 * This is the FIRST file to update if Amazon changes its page structure.
 * All CSS selectors, regex patterns, and keyword lists live here — never
 * scattered through other files.  Keeping them centralised means one fix
 * in this file can restore the entire extension after a site redesign.
 */

const PATTERNS = {

  // ── Order ID ─────────────────────────────────────────────────────────────
  // Amazon order IDs follow the format: 3 digits - 7 digits - 7 digits
  orderIdRegex: /\b(\d{3}-\d{7}-\d{7})\b/,

  // ── Orders List Page ─────────────────────────────────────────────────────
  ordersList: {
    // Each order card on the orders list page
    orderCard: '.order-card.js-order-card',

    // Fallback: any element with data-order-id attribute
    orderCardFallback: '[data-order-id]',

    // Element containing the order ID text
    orderIdElement: '.yohtmlc-order-id',

    // Shipment status text on a list card. Amazon renders this in one of
    // several places depending on the order's state. Agent 1 tries each
    // selector in order and uses the first one whose text is non-empty.
    //
    // Common patterns:
    //   - Active orders: .delivery-box__primary-text         (e.g. "Delivered", "Out for delivery")
    //   - With follow-up: .delivery-box__secondary-text       (e.g. "Your return is complete…")
    //   - Post-return-window: plain <span> inside a-row      (e.g. "Return window closed on 28 November 2025")
    //     — no distinguishing class, so Agent 1 falls back to a text-phrase
    //       scan (see statusPhraseKeywords below).
    statusElementFallbacks: [
      '.delivery-box__primary-text',
      '.delivery-box__secondary-text'
    ],

    // Legacy single selector — kept for older code paths that expect a
    // single CSS string. Agent 1 uses statusElementFallbacks above.
    statusElement: '.delivery-box__primary-text',

    // Brand-label strings that appear in `.delivery-box__primary-text` but
    // are NOT statuses. Lulu cards put "LuLu delivery" in the primary-text
    // slot (it's the brand label). When Agent 1 encounters text that matches
    // one of these phrases, it treats the slot as empty and falls through to
    // the fallback selectors and phrase-scan below. Matching is case-
    // insensitive exact-trim.
    brandLabelPhrases: [
      'lulu delivery'
    ],

    // Last-resort: if every fallback selector returns empty, Agent 1 scans
    // the entire card's text content looking for any of these phrases (in
    // priority order — more specific first). Matching is case-insensitive
    // substring match on the whitespace-normalized card text. When a match
    // is found, Agent 1 captures the phrase plus up to 40 characters after
    // it, so context like "on 28 November 2025" is preserved for the log.
    statusPhraseKeywords: [
      'return window closed',
      'return complete',
      'refund issued',
      'refunded',
      'order canceled',
      'cancelled',
      'delivered',
      'out for delivery',
      'arriving',
      'in transit',
      'not yet dispatched',
      'preparing',
      'shipped',
      'packed'
    ],

    // Order placed date on the list card
    orderDateElement: '.a-size-base.a-color-secondary',

    // Order total on the list card
    orderTotalElement: '.a-color-base.a-text-bold',

    // ── Order Type Detection (by badge/logo — NOT by order ID prefix) ──────
    // Amazon Now: look for this specific brand image
    amazonNowBadge: 'img[alt="The brand image for your Amazon Now order"]',

    // Lulu: look for their brand image or heading text
    luluBadge: 'img[alt="LuLu"]',
    luluHeadingText: 'LuLu delivery',   // text to search for in headings

    // "DELIVER TO" vs "SHIP TO" address label (secondary signal)
    deliverToText: 'DELIVER TO',
    shipToText: 'SHIP TO',

    // Pagination: "Next" button link
    nextPageLink: '.a-last a',
    currentPageIndicator: '.a-selected'
  },

  // ── Print Summary Page (Regular Amazon + Amazon Now fallback) ────────────
  printPage: {
    // Heading that confirms the page has loaded
    pageHeading: 'h1, h2, h3',             // look for text "Order Summary"
    pageHeadingText: 'Order Summary',

    // "Ship to" heading (Regular Amazon) vs "DELIVER TO" (Amazon Now)
    shipToHeading: 'Ship to',
    deliverToHeading: 'DELIVER TO',

    // Payment method section heading
    paymentHeading: 'Payment method',

    // Product image link: links that go to a product detail (/dp/) page
    productImageLink: 'a[href*="/dp/"]',

    // Brand image indicating Amazon Now on print page
    amazonNowBrandImage: 'img[alt*="Amazon Now"]',

    // Brand image indicating Lulu on print page
    luluBrandImage: 'img[alt*="LuLu"]',

    // "Sold by" label text (only appears on Regular Amazon orders)
    soldByText: 'Sold by',

    // Cancelled order signals
    cancelledHeadingText: 'Order canceled',
    cancelledPaymentText: 'No current charges',

    // Status keywords used to recognise shipment status headings
    statusKeywords: [
      'Delivered', 'Shipped', 'Out for delivery', 'Order canceled',
      'Cancelled', 'Returned', 'Refunded', 'Not yet dispatched',
      'Arriving', 'Preparing', 'In transit', 'DELIVERED', 'CANCELLED',
      'Return complete', 'Refund issued', 'refund has been issued'
    ]
  },

  // ── Lulu Printable Page ───────────────────────────────────────────────────
  luluPage: {
    // The main items table
    itemsTable: 'table',

    // Table rows inside tbody (skip header row)
    tableRows: 'tbody tr',

    // Column indices (0-based) in each item row
    cols: {
      image: 0,
      itemName: 1,
      quantity: 2,
      weight: 3,     // always empty — skip
      lineTotal: 4
    },

    // Link inside item name cell (contains the ASIN)
    itemLink: 'a[href*="/gp/product/"]',

    // Heading that shows total item count, e.g. "Items in your order (11)"
    itemCountHeading: /Items in your order\s*\((\d+)\)/i,

    // Brand image
    luluBrandImage: 'img[alt="LuLu"]'
  },

  // ── Amazon Now API ────────────────────────────────────────────────────────
  nowApi: {
    // URL parameter that identifies Amazon Now items on print pages and item URLs
    brandIdParam: 'almBrandId',

    // The Amazon Now brand ID value
    nowBrandIdValue: 'sAuWWBROaG',

    // Lulu brand ID value (for detection on item URLs)
    luluBrandIdValue: 'Wf2HUUZ9yC',

    // API endpoint names
    endpoints: {
      orderDetails: 'getOrderDetails',
      orderMetadata: 'getOrderMetadata',
      orderTracking: 'getOrderTrackingInfo'
    },

    // Known order status values returned by the API
    statusMap: {
      'DELIVERED': 'Delivered',
      'CANCELLED': 'Cancelled',
      'OUT_FOR_DELIVERY': 'Out for delivery',
      'IN_TRANSIT': 'In transit',
      'PLACED': 'Order placed',
      'CONFIRMED': 'Confirmed',
      'PACKED': 'Packed'
    }
  },

  // ── Price / Currency ──────────────────────────────────────────────────────
  price: {
    // Matches prices like "AED 45.00", "AED45.00", "AED 1,200.50"
    aedPriceRegex: /AED\s*([\d,]+\.?\d*)/i,

    // Generic currency amount (any prefix)
    genericPriceRegex: /[\d,]+\.\d{2}/,

    // Currency symbol for this region
    currencySymbol: 'AED'
  },

  // ── Date Formats ──────────────────────────────────────────────────────────
  date: {
    // Amazon.ae date format: "13 April 2026" or "13th April 2026"
    longFormatRegex: /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/,

    // Short format: "13 Apr 2026"
    shortFormatRegex: /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/,

    // Month name to number mapping
    months: {
      january: 1, february: 2, march: 3, april: 4,
      may: 5, june: 6, july: 7, august: 8,
      september: 9, october: 10, november: 11, december: 12,
      jan: 1, feb: 2, mar: 3, apr: 4,
      jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    }
  },

  // ── Payment Method ────────────────────────────────────────────────────────
  payment: {
    // Maps raw API card type codes to human-readable labels
    cardTypeMap: {
      'CREDIT_CARD':  'Credit Card',
      'DEBIT_CARD':   'Debit Card',
      'AMAZON_PAY':   'Amazon Pay',
      'COD':          'Cash on Delivery',
      'GIFT_CARD':    'Gift Card',
      'EMI':          'EMI'
    },

    // Known card brand names to look for in payment text
    cardBrands: ['Visa', 'Mastercard', 'American Express', 'Amex', 'Mada',
                 'CREDIT_CARD', 'DEBIT_CARD', 'Amazon Pay', 'COD', 'Cash'],

    // "ending in XXXX" pattern
    endingInRegex: /ending in\s*(\d{4})/i,

    // Cancelled order has no payment charged
    noChargeText: 'No current charges'
  },

  // ── Validation Rules ──────────────────────────────────────────────────────
  validation: {
    // Price sanity limits (AED)
    maxReasonablePrice: 50000,
    minPrice: 0,

    // Quantity sanity limit
    maxReasonableQty: 999,

    // Quantity float tolerance: flag if lineTotal / unitPrice deviates by more than this
    quantityFloatTolerance: 0.05,

    // Item description minimum length
    minDescriptionLength: 3
  }

};

// Expose on window namespace
window.AmazonExporter = window.AmazonExporter || {};
window.AmazonExporter.PATTERNS = PATTERNS;
