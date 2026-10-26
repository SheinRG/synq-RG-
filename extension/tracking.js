// Pure bookkeeping used by content.js: which conversations are "fresh", which
// changed since we last sent them, and the payload shape. No chrome.* calls;
// the caller loads and saves the state objects.

(function () {
  const parser =
    typeof module === "object" && module.exports
      ? require("./parser.js")
      : globalThis.LinkedInParser;

  const PAYLOAD_VERSION = 1;
  const MAX_CONVERSATIONS = 200;

  // "fresh" tells the backend a conversation is new activity, so it may add an
  // unknown contact as a lead. Without it, opening an old inbox for the first
  // time would flood the Sheet with every past conversation.
  //
  // state = { baselineTaken: boolean, threads: { [threadId]: { sig, fresh } } }
  //
  // - First scan ever: everything visible becomes the baseline, fresh:false.
  // - Later: a known conversation is fresh once its last message changes, and
  //   then stays fresh. An unknown conversation is fresh unless it appears
  //   BELOW a known, unchanged one. The list is sorted newest first, so
  //   anything below an unchanged baseline item is older than the baseline
  //   (e.g. revealed by scrolling down) and is not new activity.
  function applyFreshness(conversations, state) {
    const threads = Object.assign({}, state && state.threads);

    if (!(state && state.baselineTaken)) {
      // Nothing rendered yet: wait for a real list before taking the baseline.
      if (conversations.length === 0) {
        return { conversations, state: { baselineTaken: false, threads } };
      }
      for (const c of conversations) {
        threads[c.threadId] = { sig: parser.signature(c), fresh: false };
      }
      return {
        conversations: conversations.map((c) => Object.assign({}, c, { fresh: false })),
        state: { baselineTaken: true, threads },
      };
    }

    let belowUnchangedKnown = false;
    const marked = conversations.map((c) => {
      const sig = parser.signature(c);
      const known = threads[c.threadId];
      const fresh = known ? known.fresh || known.sig !== sig : !belowUnchangedKnown;
      if (known && !fresh) belowUnchangedKnown = true;
      threads[c.threadId] = { sig, fresh };
      return Object.assign({}, c, { fresh });
    });
    return { conversations: marked, state: { baselineTaken: true, threads } };
  }

  // Everything the backend cares about, minus observedAt (which changes on
  // every scan and would make every conversation look changed).
  function contentKey(conversation) {
    const copy = Object.assign({}, conversation);
    delete copy.observedAt;
    return JSON.stringify(copy);
  }

  // Conversations whose content differs from what we last sent.
  function pickChanged(conversations, lastSent) {
    const sent = lastSent || {};
    return conversations.filter((c) => sent[c.threadId] !== contentKey(c));
  }

  // Returns a new lastSent map that includes the given conversations.
  function markSent(lastSent, conversations) {
    const next = Object.assign({}, lastSent);
    for (const c of conversations) next[c.threadId] = contentKey(c);
    return next;
  }

  function buildPayload(conversations, observedAt) {
    return {
      version: PAYLOAD_VERSION,
      observedAt,
      conversations: conversations.slice(0, MAX_CONVERSATIONS),
    };
  }

  const api = {
    applyFreshness,
    contentKey,
    pickChanged,
    markSent,
    buildPayload,
    MAX_CONVERSATIONS,
  };

  globalThis.LeadTrackerTracking = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
