// Every LinkedIn DOM selector the extension relies on lives in this file.
//
// LinkedIn changes its markup without notice, so each key is a list of
// selectors tried in order: the first one that matches anything wins. When
// something stops working, open LinkedIn Messages, click "Check this page" in
// the popup, see which keys match 0 elements, and add a working selector to
// the front of that key's list. Nothing else should need to change.
//
// Status: checked against the live page on 2026-10-26. The first selector of
// each key is the one LinkedIn used that day; the rest are fallbacks. Where
// possible we also lean on sturdier signals than class names: profile links
// (/in/) and the "Seen by" alt/title text.

(function () {
  const SELECTORS = {
    // ---- Conversation list (left column of /messaging) ----

    // One element per conversation in the left-hand list.
    conversationItem: [
      "li.msg-conversation-listitem",
      "ul.msg-conversations-container__conversations-list > li",
    ],

    // Link to the conversation. Its href carries the thread id. In October 2026
    // LinkedIn renders the item as a clickable div with no href, so this matches
    // nothing and the id comes from the URL of the open thread instead (see
    // tracking.rememberThreads). Kept in case links come back.
    itemThreadLink: [
      "a[href*='/messaging/thread/']",
      "a.msg-conversation-listitem__link",
      "[data-href*='/messaging/thread/']",
    ],

    // Participant name(s). Group chats list several names ("A, B and 2 others").
    itemName: [
      ".msg-conversation-listitem__participant-names",
      ".msg-conversation-card__participant-names",
      "h3",
    ],

    // Last message preview. Our own messages start with "You: ".
    itemSnippet: [
      ".msg-conversation-card__message-snippet",
      ".msg-conversation-card__message-snippet-body",
      ".msg-conversation-listitem__message-snippet",
      "[class*='message-snippet']",
    ],

    // Unread marker (count badge or an "--unread" modifier).
    itemUnread: [
      ".msg-conversation-card__convo-item-container--unread",
      ".msg-conversation-card__unread-count",
      ".msg-conversation-card__message-snippet--unread",
      ".msg-conversation-listitem__link--unread",
      "[class*='--unread']",
    ],

    // Small labels on a list item. An item whose label reads exactly
    // "Sponsored" is an InMail ad and is skipped.
    itemSponsoredLabel: [
      ".msg-conversation-card__pill",
      "[class*='sponsored']",
    ],

    // Marks the list item of the thread that is currently open.
    itemActive: [
      ".msg-conversations-container__convo-item-link--active",
      ".msg-conversation-listitem__link--active",
      "[aria-current='page']",
      "[aria-current='true']",
    ],

    // ---- Open thread (right-hand pane, URL /messaging/thread/<id>/) ----

    // Name shown in the thread header.
    threadName: [
      ".msg-entity-lockup__entity-title",
      ".msg-thread__link-to-profile",
      ".msg-title-bar__title",
      ".msg-title-bar h2",
    ],

    // The other person's profile link. Only header / top-card areas are
    // searched: links inside the message list can point at our own profile.
    threadProfileLink: [
      "a.msg-thread__link-to-profile[href*='/in/']",
      ".msg-title-bar a[href*='/in/']",
      ".msg-entity-lockup a[href*='/in/']",
      ".msg-s-profile-card a[href*='/in/']",
    ],

    // Container holding the messages of the open thread.
    messageList: [
      ".msg-s-message-list-content",
      ".msg-s-message-list",
      "[class*='msg-s-message-list']",
    ],

    // One element per message inside the message list.
    messageItem: [
      ".msg-s-event-listitem",
      "li.msg-s-message-list__event",
    ],

    // Applied to a message item when the OTHER person sent it. Absence means
    // we sent it.
    messageFromOther: [
      ".msg-s-event-listitem--other",
      "[class*='event-listitem--other']",
    ],

    // Text of a single message.
    messageBody: [
      ".msg-s-event-listitem__body",
      "[class*='event-listitem__body']",
      "p",
    ],

    // Read receipt. LinkedIn attaches it to the latest message the other
    // person has seen: the message gets "--has-seen-receipts" and the receipt
    // sits beside it in the same event element. Not "[class*='seen-receipt']":
    // that also matches the always-present "...--without-seen-receipt".
    seenReceipt: [
      ".msg-s-event-listitem__seen-receipts",
      ".msg-s-event-listitem--has-seen-receipts",
      "img[alt^='Seen by']",
      "[title^='Seen by']",
      "[aria-label^='Seen by']",
    ],

    // Wrapper around one message event; receipts can sit beside the message
    // item rather than inside it, so we look for them at this level.
    messageEvent: ["li.msg-s-message-list__event", "li"],
  };

  globalThis.LinkedInSelectors = SELECTORS;
  if (typeof module === "object" && module.exports) module.exports = SELECTORS;
})();
