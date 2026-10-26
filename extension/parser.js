// Pure functions that read LinkedIn's already-rendered messaging DOM and turn
// it into plain data. No chrome.* calls and no side effects: they only read,
// never click, scroll or type. This keeps them testable in Node with jsdom.

(function () {
  const SELECTORS =
    typeof module === "object" && module.exports
      ? require("./selectors.js")
      : globalThis.LinkedInSelectors;

  const MAX_THREAD_MESSAGES = 10;

  // ---- Small DOM helpers that try each fallback selector in order ----

  function selectorsFor(key) {
    const list = SELECTORS[key];
    if (!list) throw new Error("Unknown selector key: " + key);
    return list;
  }

  // querySelector that treats an invalid selector as "no match" instead of
  // throwing, so one bad entry in selectors.js cannot break the whole scan.
  function safeQueryAll(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (err) {
      return [];
    }
  }

  function safeMatches(el, selector) {
    try {
      return el.matches(selector);
    } catch (err) {
      return false;
    }
  }

  function queryFirst(root, key) {
    if (!root) return null;
    for (const selector of selectorsFor(key)) {
      const found = safeQueryAll(root, selector);
      if (found.length) return found[0];
    }
    return null;
  }

  // All elements matched by the first selector in the list that matches anything.
  function queryAll(root, key) {
    if (!root) return [];
    for (const selector of selectorsFor(key)) {
      const found = safeQueryAll(root, selector);
      if (found.length) return found;
    }
    return [];
  }

  function matchesAny(el, key) {
    if (!el) return false;
    return selectorsFor(key).some((selector) => safeMatches(el, selector));
  }

  function closestAny(el, key) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (matchesAny(node, key)) return node;
    }
    return null;
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // ---- URL and text helpers ----

  // "/messaging/thread/2-ABC%3D%3D/?x=1" -> "2-ABC==". Returns "" if no id.
  function threadIdFromHref(href) {
    const match = /\/messaging\/thread\/([^/?#]+)/.exec(String(href || ""));
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (err) {
      return match[1];
    }
  }

  function threadUrlFor(threadId) {
    // Keep "=" readable in the Sheet; LinkedIn accepts it unencoded.
    const segment = encodeURIComponent(threadId).replace(/%3D/g, "=");
    return "https://www.linkedin.com/messaging/thread/" + segment + "/";
  }

  // Any LinkedIn profile link -> "https://www.linkedin.com/in/<slug>/".
  // The slug is kept as-is: messaging often links by member id (ACoAA...),
  // which is case-sensitive.
  function profileUrlFromHref(href) {
    const match = /\/in\/([^/?#]+)/.exec(String(href || ""));
    return match ? "https://www.linkedin.com/in/" + match[1] + "/" : "";
  }

  // The list preview of our own last message reads "You: <text>", or
  // "You sent an attachment" when there is no text to show.
  function stripYouPrefix(snippet) {
    const text = cleanText(snippet);
    const match = /^You:\s*/i.exec(text);
    if (match) return { fromMe: true, text: text.slice(match[0].length) };
    if (/^You sent\b/i.test(text)) return { fromMe: true, text };
    return { fromMe: false, text };
  }

  // Inbound previews may read "Priya: <text>". Strip it when it is the
  // contact's first name so the text matches what the open thread shows.
  function stripSenderPrefix(text, name) {
    const firstName = cleanText(name).split(" ")[0];
    if (!firstName) return text;
    const prefix = firstName + ":";
    return text.toLowerCase().startsWith(prefix.toLowerCase())
      ? cleanText(text.slice(prefix.length))
      : text;
  }

  // Short tokens people put after their name: "Priya Sharma, MBA", "Sam Lee, Ph.D., PMP".
  const CREDENTIAL = /^(?:[A-Z]{2,6}|Ph\.?\s?D\.?|M\.?D\.?|Jr\.?|Sr\.?|Esq\.?|I{2,3}|IV)$/;

  // "Priya Sharma, MBA, PMP" -> "Priya Sharma", so the name matches the Sheet
  // and the comma is not mistaken for a group chat.
  function stripCredentials(name) {
    const parts = cleanText(name).split(/\s*,\s*/);
    while (parts.length > 1 && CREDENTIAL.test(parts[parts.length - 1])) parts.pop();
    return parts.join(", ");
  }

  // Group chats show several names: "Ana, Ben and 2 others", "Ana and Ben".
  // Expects a name that already went through stripCredentials.
  function isGroupName(name) {
    const text = cleanText(name);
    return /,/.test(text) || /\band \d+ others?\b/i.test(text) || / and /i.test(text);
  }

  // Sponsored InMail ads sit in the inbox like conversations; they are never leads.
  function isSponsoredItem(item) {
    // Every selector is checked: an item can carry several labels.
    return selectorsFor("itemSponsoredLabel").some((selector) =>
      safeQueryAll(item, selector).some((el) => /^sponsored$/i.test(cleanText(el.textContent))),
    );
  }

  // Identifies "what the last message was" for fresh/baseline tracking. The
  // list preview can be truncated while the open thread shows the full text,
  // so only the first 30 characters are compared.
  function signature(conversation) {
    const last = conversation && conversation.lastMessage;
    if (!last) return "none";
    const text = cleanText(last.text).replace(/(…|\.\.\.)$/, "").toLowerCase();
    return (last.fromMe ? "me:" : "them:") + text.slice(0, 30);
  }

  // ---- Conversation list ----

  // How the extension remembers a conversation before it knows the thread id:
  // its name, lowercased. Used for the fresh/baseline state and to look up a
  // thread id learned earlier.
  function nameKey(name) {
    return cleanText(name).toLowerCase();
  }

  function isActiveItem(item) {
    return matchesAny(item, "itemActive") || Boolean(queryFirst(item, "itemActive"));
  }

  // Returns { conversations }. LinkedIn's list items carry no thread link, so
  // threadId is "" except on the open thread's item (id from the URL);
  // tracking.rememberThreads fills in ids learned earlier. Each item has a
  // "key" (its name, plus "#2", "#3" when several items share a name) and
  // "ambiguous" when its name is not unique in the list.
  function parseConversationList(doc, pathname) {
    const openThreadId = threadIdFromHref(pathname);
    const conversations = [];
    const seenIds = new Set();
    const keyCounts = {};

    for (const item of queryAll(doc, "conversationItem")) {
      if (isSponsoredItem(item)) continue;
      const nameEl = queryFirst(item, "itemName");
      const name = stripCredentials(nameEl && nameEl.textContent);
      // LinkedIn keeps a few empty placeholder items at the end of the list.
      if (!name) continue;

      const link = queryFirst(item, "itemThreadLink");
      const href = link ? link.getAttribute("href") || link.getAttribute("data-href") : "";
      let threadId = threadIdFromHref(href);
      const active = isActiveItem(item);
      if (!threadId && active && openThreadId) threadId = openThreadId;
      if (threadId && seenIds.has(threadId)) continue;
      if (threadId) seenIds.add(threadId);

      const base = nameKey(name);
      keyCounts[base] = (keyCounts[base] || 0) + 1;
      const key = keyCounts[base] === 1 ? base : base + "#" + keyCounts[base];

      const snippetEl = queryFirst(item, "itemSnippet");
      const snippet = cleanText(snippetEl && snippetEl.textContent);

      let lastMessage = null;
      if (snippet) {
        lastMessage = stripYouPrefix(snippet);
        if (!lastMessage.fromMe) lastMessage.text = stripSenderPrefix(lastMessage.text, name);
      }

      conversations.push({
        threadId,
        threadUrl: threadId ? threadUrlFor(threadId) : "",
        key,
        name,
        isGroup: isGroupName(name),
        lastMessage,
        unread: Boolean(queryFirst(item, "itemUnread")) || matchesAny(link, "itemUnread"),
        active,
      });
    }
    for (const c of conversations) c.ambiguous = keyCounts[nameKey(c.name)] > 1;
    return { conversations };
  }

  // ---- Open thread ----

  function isFromOther(item) {
    return matchesAny(item, "messageFromOther") || Boolean(queryFirst(item, "messageFromOther"));
  }

  function messageText(item) {
    const body = queryFirst(item, "messageBody");
    // Attachments, posts and stickers have no text body; keep them as "".
    return cleanText(body ? body.textContent : "");
  }

  // A receipt counts for this message if it sits inside the message itself, or
  // in its event wrapper when this is the last message of that wrapper.
  function hasSeenReceipt(item) {
    if (matchesAny(item, "seenReceipt") || queryFirst(item, "seenReceipt")) return true;
    const event = closestAny(item.parentElement, "messageEvent");
    if (!event) return false;
    const itemsInEvent = queryAll(event, "messageItem");
    return itemsInEvent[itemsInEvent.length - 1] === item && Boolean(queryFirst(event, "seenReceipt"));
  }

  // Returns null when no thread is open (URL is not /messaging/thread/<id>/).
  function parseOpenThread(doc, pathname) {
    const threadId = threadIdFromHref(pathname);
    if (!threadId) return null;

    const nameEl = queryFirst(doc, "threadName");
    const name = stripCredentials(nameEl && nameEl.textContent);
    const isGroup = isGroupName(name);
    const profileLink = queryFirst(doc, "threadProfileLink");
    const profileUrl = isGroup ? "" : profileUrlFromHref(profileLink && profileLink.getAttribute("href"));

    const listRoot = queryFirst(doc, "messageList");
    const all = queryAll(listRoot, "messageItem").map((item) => ({
      fromMe: !isFromOther(item),
      text: messageText(item),
      seen: hasSeenReceipt(item),
    }));
    const last = all.length ? all[all.length - 1] : null;

    return {
      threadId,
      threadUrl: threadUrlFor(threadId),
      name,
      profileUrl,
      isGroup,
      lastMessage: last ? { fromMe: last.fromMe, text: last.text } : null,
      // "Opened" only means something when our message is the latest one.
      seen: Boolean(last && last.fromMe && last.seen),
      messages: all.slice(-MAX_THREAD_MESSAGES).map((m) => ({ fromMe: m.fromMe, text: m.text })),
    };
  }

  // ---- Merge list + open thread into the payload shape ----

  function mergeConversations(list, thread, observedAt) {
    const out = (list || []).map((item) => ({
      threadId: item.threadId,
      threadUrl: item.threadUrl,
      key: item.key,
      ambiguous: item.ambiguous,
      name: item.name,
      profileUrl: "",
      isGroup: item.isGroup,
      fresh: false, // decided later by tracking.applyFreshness
      observedAt,
      lastMessage: item.lastMessage,
      seen: null,
      messages: [],
    }));
    if (!thread) return out;

    let entry = out.find((c) => c.threadId === thread.threadId);
    if (!entry) {
      // Open thread not in the rendered list: position unknown, so put it last.
      entry = {
        threadId: thread.threadId,
        threadUrl: thread.threadUrl,
        key: "thread:" + thread.threadId,
        ambiguous: false,
        name: "",
        profileUrl: "",
        isGroup: false,
        fresh: false,
        observedAt,
        lastMessage: null,
        seen: null,
        messages: [],
      };
      out.push(entry);
    }

    // The open thread is the most detailed view, so it wins.
    entry.name = thread.name || entry.name;
    entry.isGroup = entry.isGroup || thread.isGroup;
    entry.profileUrl = entry.isGroup ? "" : thread.profileUrl || entry.profileUrl;
    entry.seen = thread.seen;
    if (thread.messages.length) {
      entry.messages = thread.messages;
      // The text stays the list preview's, so the same message reads the same
      // whether or not its thread is open (the preview says "You sent an
      // attachment" where the thread shows the message text). Who sent it
      // comes from the thread: a message with a subject line previews as the
      // subject, without the "You:" that marks our own messages.
      entry.lastMessage = entry.lastMessage
        ? { fromMe: thread.lastMessage.fromMe, text: entry.lastMessage.text }
        : thread.lastMessage;
    }
    return out;
  }

  // ---- Diagnostics ----

  // For each selector key: how many elements each fallback matches on the page.
  function countSelectorMatches(doc) {
    const report = {};
    for (const key of Object.keys(SELECTORS)) {
      report[key] = SELECTORS[key].map((selector) => ({
        selector,
        count: safeQueryAll(doc, selector).length,
      }));
    }
    return report;
  }

  const api = {
    parseConversationList,
    parseOpenThread,
    mergeConversations,
    countSelectorMatches,
    threadIdFromHref,
    threadUrlFor,
    nameKey,
    profileUrlFromHref,
    stripYouPrefix,
    stripSenderPrefix,
    stripCredentials,
    isGroupName,
    signature,
    cleanText,
  };

  globalThis.LinkedInParser = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
