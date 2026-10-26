// Runs on linkedin.com. Only READS what LinkedIn has already rendered on
// /messaging pages and hands it to the background worker. It never clicks,
// scrolls, types or sends anything: the system observes, humans send.

(function () {
  const parser = globalThis.LinkedInParser;
  const tracking = globalThis.LeadTrackerTracking;
  const LOG = "[lead-tracker]";
  const SCAN_DELAY_MS = 2000; // wait for LinkedIn to finish rendering a change
  const RESCAN_MS = 60000; // safety net in case a change produced no mutation we saw

  // threadId -> content of what we last handed to the background. Memory only:
  // after a page reload we resend the visible conversations once, which the
  // backend treats as "unchanged".
  let lastSent = {};
  let scanTimer = null;
  let stopped = false;
  let observer = null;
  let interval = null;

  // Scans run one at a time (they read and write the stored fresh state).
  let chain = Promise.resolve();
  function runExclusive(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  function onMessagingPage() {
    return location.pathname.startsWith("/messaging");
  }

  function readPage(observedAt) {
    const list = parser.parseConversationList(document, location.pathname);
    const thread = parser.parseOpenThread(document, location.pathname);
    const conversations = parser.mergeConversations(list.conversations, thread, observedAt);
    return { list, thread, conversations };
  }

  // Storage keys. "freshStateV2" replaced "freshState" when the state moved
  // from thread ids to names, so the baseline is taken again.
  const FRESH_KEY = "freshStateV2";
  const MEMORY_KEY = "threadMemory";

  // Reads the page, fills in thread ids learned earlier and marks each
  // conversation fresh or not (see tracking.js). Conversations whose thread id
  // is still unknown are returned separately: they are not sent until their
  // thread has been opened once.
  async function collect() {
    const observedAt = new Date().toISOString();
    const { conversations } = readPage(observedAt);
    const stored = await chrome.storage.local.get([FRESH_KEY, MEMORY_KEY]);
    const remembered = tracking.rememberThreads(conversations, stored[MEMORY_KEY]);
    const result = tracking.applyFreshness(remembered.conversations, stored[FRESH_KEY]);
    await chrome.storage.local.set({ [FRESH_KEY]: result.state, [MEMORY_KEY]: remembered.memory });
    return {
      observedAt,
      conversations: result.conversations.filter((c) => c.threadId),
      waiting: result.conversations.filter((c) => !c.threadId),
    };
  }

  // sendAll=false: only conversations that changed since we last sent them.
  async function sync(sendAll) {
    const { observedAt, conversations, waiting } = await collect();
    const toSend = sendAll ? conversations : tracking.pickChanged(conversations, lastSent);
    if (toSend.length === 0) {
      let note = "Nothing changed since the last sync.";
      if (!conversations.length) {
        note = waiting.length
          ? "No conversation can be sent yet: open each one once so the tracker learns its thread."
          : "No conversations found on this page.";
      }
      return { ok: true, sent: 0, note };
    }
    const payload = tracking.buildPayload(toSend, observedAt);
    // Marked as sent once handed over: the background keeps and retries
    // anything that fails to reach the Apps Script.
    lastSent = tracking.markSent(lastSent, payload.conversations);
    return chrome.runtime.sendMessage({ type: "sync", payload });
  }

  function handleError(err) {
    const message = String((err && err.message) || err);
    // After the extension is reloaded or updated, this old copy of the
    // script can no longer reach chrome.*; stop quietly.
    if (message.includes("Extension context invalidated")) {
      stop();
      return;
    }
    console.warn(LOG, "scan failed:", message);
  }

  function autoSync() {
    if (stopped || !onMessagingPage()) return;
    runExclusive(() => sync(false)).catch(handleError);
  }

  // Throttle rather than debounce: LinkedIn mutates the DOM constantly (typing
  // indicators, presence dots), so a pure debounce might never fire.
  function scheduleScan() {
    if (stopped || scanTimer || !onMessagingPage()) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      autoSync();
    }, SCAN_DELAY_MS);
  }

  function stop() {
    stopped = true;
    if (observer) observer.disconnect();
    if (interval) clearInterval(interval);
    if (scanTimer) clearTimeout(scanTimer);
  }

  async function diagnose() {
    const page = readPage(new Date().toISOString());
    const stored = await chrome.storage.local.get(MEMORY_KEY);
    const remembered = tracking.rememberThreads(page.conversations, stored[MEMORY_KEY]).conversations;
    return {
      url: location.href,
      onMessagingPage: onMessagingPage(),
      selectorCounts: parser.countSelectorMatches(document),
      listCount: page.conversations.length,
      waitingNames: remembered.filter((c) => !c.threadId).map((c) => c.name),
      openThread: page.thread && {
        threadId: page.thread.threadId,
        name: page.thread.name,
        profileUrl: page.thread.profileUrl,
        messageCount: page.thread.messages.length,
        lastFromMe: page.thread.lastMessage ? page.thread.lastMessage.fromMe : null,
        seen: page.thread.seen,
      },
      conversations: remembered.slice(0, 20),
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "diagnose") {
      diagnose().then(
        (report) => sendResponse({ ok: true, report }),
        (err) => {
          handleError(err);
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        },
      );
      return true; // async response
    }
    if (message.type === "syncNow") {
      if (!onMessagingPage()) {
        sendResponse({ ok: false, error: "Open LinkedIn Messages first." });
        return false;
      }
      runExclusive(() => sync(true)).then(sendResponse, (err) => {
        handleError(err);
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      });
      return true; // async response
    }
    return false;
  });

  try {
    // LinkedIn is a single-page app: observe always, act only on /messaging.
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    interval = setInterval(autoSync, RESCAN_MS);
    scheduleScan();
  } catch (err) {
    handleError(err);
  }
})();
