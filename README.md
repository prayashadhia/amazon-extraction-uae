# Amazon Order Exporter (Amazon.ae)

A free Chrome extension that exports your Amazon.ae order history to an Excel file (`.xlsx`).

Supports regular Amazon orders, Amazon Now, and Lulu — including multi-item orders, multi-shipment orders, and cancelled / returned / refunded orders.

> **Disclaimer:** This is an unofficial, community-built tool. It is not affiliated with, endorsed by, or sponsored by Amazon.

---

## What it does

- Reads every order from your Amazon.ae order history
- Pulls out date, items, quantities, prices, payment method, seller, and delivery status
- Saves everything to an Excel file you can open in Excel, Google Sheets, or Numbers

## Privacy

The extension runs entirely in your browser. **No data is sent anywhere** — no servers, no analytics, no API keys. Your orders are read from Amazon's pages while you're logged in, and the Excel file is saved straight to your computer's Downloads folder.

---

## Install

1. **Download the code**
   - Click the green **Code** button at the top of this page → **Download ZIP**
   - Unzip the file somewhere you'll remember (e.g. your Documents folder)

2. **Load it into Chrome**
   - Open Chrome and go to `chrome://extensions`
   - Turn on **Developer mode** (toggle in the top-right)
   - Click **Load unpacked**
   - Select the unzipped folder

3. **Pin the extension** (optional but useful)
   - Click the puzzle-piece icon in Chrome's toolbar
   - Find "Amazon Order Exporter" and click the pin icon

The extension also works in Edge, Brave, and other Chromium-based browsers.

---

## How to use

1. Sign in to [amazon.ae](https://www.amazon.ae) and go to **Your Orders**
2. Pick the time range you want (e.g. "last 6 months", "2025", etc.)
3. Click the extension icon in the toolbar
4. Click **Start Export**
5. Wait — the extension will scan your orders, fetch the details, and download an Excel file when done

The extension handles pagination automatically, so all orders in your selected time range will be included.

---

## Requirements

- A Chromium-based browser (Chrome, Edge, Brave, etc.)
- An Amazon.ae account
- That's it — no Node.js, no install steps, no accounts to create

---

## Troubleshooting

- **Extension button does nothing?** Make sure you're on amazon.ae and signed in.
- **Some orders missing?** Try a smaller time range first to check it works, then widen it.
- **Excel file didn't download?** Check your browser's Downloads folder, and make sure Chrome isn't blocking pop-ups for the extension.

---

## Limitations

- **Amazon.ae only** (UAE). Other Amazon regions (.com, .co.uk, .in, etc.) are not supported.
- Amazon may change its site at any time. If something breaks, please open an Issue on this repo.

---

## Contributing

Found a bug or want to add support for another Amazon region? Open an Issue or Pull Request.
