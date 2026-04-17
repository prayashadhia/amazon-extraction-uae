/**
 * popup.js — Amazon Order Exporter
 *
 * Handles all UI logic for the extension popup.
 * Communicates with the background service worker via chrome.runtime.sendMessage
 * and chrome.runtime.onMessage.
 *
 * Message protocol
 * ────────────────
 * Popup → Background:
 *   { action: 'START_SCRAPE' }
 *   { action: 'CANCEL_SCRAPE' }
 *
 * Background → Popup:
 *   { action: 'PROGRESS', data: { stage, current, total, message } }
 *   { action: 'COMPLETE', data: { orderCount, itemCount, errorCount, filename } }
 *   { action: 'ERROR',    data: { message } }
 */

/* ── State ───────────────────────────────────────────────── */
var isRunning = false;

/* ── DOM references ──────────────────────────────────────── */
var statusIcon;
var statusText;
var progressBarWrap;
var progressBar;
var progressLabel;
var btnExport;
var btnCancel;
var resultArea;
var resultSummary;
var resultFilename;
var errorArea;
var errorMessage;

/* ═══════════════════════════════════════════════════════════
   Initialise once the page has loaded
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {

  /* Cache DOM references */
  statusIcon      = document.getElementById('status-icon');
  statusText      = document.getElementById('status-text');
  progressBarWrap = document.getElementById('progress-bar-wrap');
  progressBar     = document.getElementById('progress-bar');
  progressLabel   = document.getElementById('progress-label');
  btnExport       = document.getElementById('btn-export');
  btnCancel       = document.getElementById('btn-cancel');
  resultArea      = document.getElementById('result-area');
  resultSummary   = document.getElementById('result-summary');
  resultFilename  = document.getElementById('result-filename');
  errorArea       = document.getElementById('error-area');
  errorMessage    = document.getElementById('error-message');

  /* ── Check whether we are on the right tab ── */
  checkIsAmazonTab(function (isAmazon) {
    if (!isAmazon) {
      setStatus('error', 'Please open Amazon.ae and go to your Order History page first.');
      showErrorArea('Please open Amazon.ae and go to your Order History page first.');
      btnExport.disabled = true;
    } else {
      setStatus('idle', 'Ready to export');
    }
  });

  /* ── Button handlers ── */
  btnExport.addEventListener('click', onExportClick);
  btnCancel.addEventListener('click', onCancelClick);

  /* ── Listen for messages from the background service worker ── */
  chrome.runtime.onMessage.addListener(onBackgroundMessage);
});

/* ═══════════════════════════════════════════════════════════
   Button handlers
   ═══════════════════════════════════════════════════════════ */

/**
 * User clicked "Export to Excel".
 * Sends START_SCRAPE to the background and switches UI to running state.
 */
function onExportClick() {
  if (isRunning) { return; }

  isRunning = true;

  /* Reset any previous result / error areas */
  hideResultArea();
  hideErrorArea();

  setStatus('running', 'Starting...');
  setProgress(0, 1, ''); /* Reset bar to 0 */
  showProgressUI(true);

  btnExport.hidden = true;
  btnCancel.hidden = false;

  chrome.runtime.sendMessage({ action: 'START_SCRAPE' }, function (response) {
    /* If the background returns an immediate error (e.g. no listener yet)
       chrome.runtime.lastError will be set. Handle gracefully. */
    if (chrome.runtime.lastError) {
      var msg = chrome.runtime.lastError.message || 'Could not contact the background script.';
      /* "The message port closed before a response was received" is a
         known Chrome false-positive for fire-and-forget messages. Real
         progress/errors arrive via chrome.runtime.onMessage — ignore it. */
      if (msg.indexOf('message port closed') === -1) {
        handleError(msg);
      }
    }
    /* Successful dispatch — UI updates come via onMessage. */
  });
}

/**
 * User clicked "Cancel".
 * Sends CANCEL_SCRAPE to the background and resets the UI.
 */
function onCancelClick() {
  chrome.runtime.sendMessage({ action: 'CANCEL_SCRAPE' }, function () {
    /* Ignore any lastError — we are cancelling anyway */
    if (chrome.runtime.lastError) { /* swallow */ }
  });

  isRunning = false;
  setStatus('idle', 'Cancelled.');
  showProgressUI(false);
  btnExport.hidden = false;
  btnCancel.hidden = true;
}

/* ═══════════════════════════════════════════════════════════
   Background message handler
   ═══════════════════════════════════════════════════════════ */

/**
 * Receives PROGRESS / COMPLETE / ERROR messages from the background.
 * @param {object} message
 */
function onBackgroundMessage(message) {
  if (!message || !message.action) { return; }

  var data = message.data || {};

  switch (message.action) {

    case 'PROGRESS':
      /* Update the progress bar and label */
      setProgress(data.current || 0, data.total || 1, data.message || '');
      /* Update the status text to show the current stage */
      if (data.stage) {
        statusText.textContent = data.stage;
      }
      break;

    case 'COMPLETE':
      isRunning = false;
      setStatus('done', 'Done! ' + (data.orderCount || 0) + ' orders, ' + (data.itemCount || 0) + ' items exported.');
      showProgressUI(false);
      showResultArea(data.orderCount || 0, data.itemCount || 0, data.errorCount || 0, data.filename || '');
      btnExport.hidden = false;
      btnCancel.hidden = true;
      break;

    case 'ERROR':
      handleError(data.message || 'An unknown error occurred.');
      break;

    default:
      /* Ignore unrecognised messages */
      break;
  }
}

/* ═══════════════════════════════════════════════════════════
   UI helpers
   ═══════════════════════════════════════════════════════════ */

/**
 * Sets the status dot colour and status text.
 *
 * @param {'idle'|'running'|'done'|'error'} state
 * @param {string} message  Text to display next to the dot
 */
function setStatus(state, message) {
  /* Remove all state classes from the icon */
  statusIcon.className = 'status-icon status-' + state;

  /* Update the status text */
  statusText.textContent = message || '';
}

/**
 * Updates the progress bar width and the label below it.
 *
 * @param {number} current  Orders / pages processed so far
 * @param {number} total    Total orders / pages expected
 * @param {string} message  Human-readable label, e.g. "Scanning page 2 of 5..."
 */
function setProgress(current, total, message) {
  var pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  progressBar.style.width = pct + '%';

  if (message) {
    progressLabel.textContent = message;
    progressLabel.hidden = false;
  }
}

/**
 * Shows or hides the progress bar and label.
 * @param {boolean} visible
 */
function showProgressUI(visible) {
  progressBarWrap.hidden = !visible;
  progressLabel.hidden   = !visible;

  if (!visible) {
    /* Reset bar to 0 when hidden so it starts fresh next time */
    progressBar.style.width = '0%';
    progressLabel.textContent = '';
  }
}

/**
 * Displays the success result area.
 *
 * @param {number} orderCount
 * @param {number} itemCount
 * @param {number} errorCount
 * @param {string} filename   Name of the exported .xlsx file
 */
function showResultArea(orderCount, itemCount, errorCount, filename) {
  var summary = orderCount + ' order' + (orderCount !== 1 ? 's' : '') +
                ', ' + itemCount + ' item' + (itemCount !== 1 ? 's' : '') + ' exported';

  if (errorCount > 0) {
    summary += ' (' + errorCount + ' error' + (errorCount !== 1 ? 's' : '') + ')';
  }

  resultSummary.textContent  = summary;
  resultFilename.textContent = filename ? 'File: ' + filename : '';
  resultArea.hidden = false;
}

function hideResultArea() {
  resultArea.hidden = true;
  resultSummary.textContent  = '';
  resultFilename.textContent = '';
}

/**
 * Displays the error area with a human-readable message.
 * @param {string} message
 */
function showErrorArea(message) {
  errorMessage.textContent = message;
  errorArea.hidden = false;
}

function hideErrorArea() {
  errorArea.hidden = true;
  errorMessage.textContent = '';
}

/**
 * Convenience: transition to error state and update both the status area
 * and the error area panel.
 * @param {string} message
 */
function handleError(message) {
  isRunning = false;
  setStatus('error', 'Export failed.');
  showProgressUI(false);
  showErrorArea(message);
  btnExport.hidden = false;
  btnCancel.hidden = true;
}

/* ═══════════════════════════════════════════════════════════
   Tab check
   ═══════════════════════════════════════════════════════════ */

/**
 * Checks whether the currently active tab is on www.amazon.ae.
 * Calls the provided callback with true / false.
 *
 * @param {function(boolean): void} callback
 */
function checkIsAmazonTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || tabs.length === 0) {
      callback(false);
      return;
    }

    var url = tabs[0].url || '';
    callback(url.includes('www.amazon.ae'));
  });
}
