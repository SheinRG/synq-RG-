// Helpers shared by the background worker and the popup. Pure functions only.

(function () {
  const MAX_CONVERSATIONS = 200;

  // Apps Script web app URLs: https://script.google.com/macros/s/<id>/exec,
  // or /a/macros/<domain>/s/<id>/exec for Google Workspace accounts.
  // The "/dev" test URL is rejected: it only works for the script's owner
  // and caches old code, which leads to confusing results.
  function isValidScriptUrl(url) {
    return /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/.test(
      String(url || "").trim()
    );
  }

  // Counts per backend action, for the popup's "last sync" line.
  function summarizeResults(results) {
    const counts = { updated: 0, unchanged: 0, added: 0, ignored: 0 };
    for (const r of results || []) {
      if (r && Object.prototype.hasOwnProperty.call(counts, r.action)) counts[r.action]++;
    }
    return counts;
  }

  // Retry without a queue: conversations from a failed send are kept and sent
  // again with the next sync. A newer reading of the same thread replaces the
  // older one, so we only ever retry the latest state per thread.
  function mergePending(pending, conversations) {
    const byThread = new Map();
    for (const c of (pending || []).concat(conversations || [])) {
      byThread.delete(c.threadId); // re-insert so the newest reading sorts last
      byThread.set(c.threadId, c);
    }
    return Array.from(byThread.values()).slice(-MAX_CONVERSATIONS);
  }

  const api = { isValidScriptUrl, summarizeResults, mergePending, MAX_CONVERSATIONS };

  globalThis.LeadTrackerShared = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
