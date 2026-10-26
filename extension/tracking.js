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

  // LinkedIn's conversation list has no thread links. The thread id is only
  // in the URL of the open thread, so we learn it then and remember it by name.
  //
  // memory = { ids: { [nameKey]: threadId }, senders: { [threadId]: { text, fromMe } } }
  //
  // - ids: a list item without an id gets the one learned for its name. Names
  //   shown more than once in the list are never learned or looked up.
  // - senders: who sent the last message, as the open thread showed it, for
  //   that preview text. The list preview alone can get it wrong (a message
  //   with a subject line previews as the subject, with no "You:"), so while
  //   the preview stays the same we keep the thread's answer.
  function rememberThreads(conversations, memory) {
    const ids = Object.assign({}, memory && memory.ids);
    const senders = Object.assign({}, memory && memory.senders);

    const out = conversations.map((original) => {
      const c = Object.assign({}, original);
      const name = parser.nameKey(c.name);
      if (c.threadId && name && !c.ambiguous) ids[name] = c.threadId;
      if (!c.threadId && name && !c.ambiguous && ids[name]) {
        c.threadId = ids[name];
        c.threadUrl = parser.threadUrlFor(c.threadId);
      }

      if (c.threadId && c.lastMessage) {
        const text = previewKey(c.lastMessage.text);
        if (c.messages && c.messages.length) {
          senders[c.threadId] = { text, fromMe: c.lastMessage.fromMe };
        } else if (senders[c.threadId] && senders[c.threadId].text === text) {
          c.lastMessage = Object.assign({}, c.lastMessage, { fromMe: senders[c.threadId].fromMe });
        }
      }
      return c;
    });
    return { conversations: out, memory: { ids, senders } };
  }

  function previewKey(text) {
    return parser.cleanText(text).replace(/(…|\.\.\.)$/, "").toLowerCase().slice(0, 30);
  }

  // "fresh" tells the backend a conversation is new activity, so it may add an
  // unknown contact as a lead. Without it, opening an old inbox for the first
  // time would flood the Sheet with every past conversation.
  //
  // state = { baselineTaken: boolean, threads: { [key]: { sig, fresh } } }
  //
  // Keyed by the conversation's key (its name), not the thread id, so the
  // baseline covers every conversation, including those whose id we have not
  // learned yet.
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
        threads[keyOf(c)] = { sig: parser.signature(c), fresh: false };
      }
      return {
        conversations: conversations.map((c) => Object.assign({}, c, { fresh: false })),
        state: { baselineTaken: true, threads },
      };
    }

    let belowUnchangedKnown = false;
    const marked = conversations.map((c) => {
      const sig = parser.signature(c);
      const known = threads[keyOf(c)];
      const fresh = known ? known.fresh || known.sig !== sig : !belowUnchangedKnown;
      if (known && !fresh) belowUnchangedKnown = true;
      threads[keyOf(c)] = { sig, fresh };
      return Object.assign({}, c, { fresh });
    });
    return { conversations: marked, state: { baselineTaken: true, threads } };
  }

  function keyOf(conversation) {
    return conversation.key || conversation.threadId;
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
      // key and ambiguous are the extension's own bookkeeping.
      conversations: conversations.slice(0, MAX_CONVERSATIONS).map((c) => {
        const copy = Object.assign({}, c);
        delete copy.key;
        delete copy.ambiguous;
        return copy;
      }),
    };
  }

  const api = {
    rememberThreads,
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
