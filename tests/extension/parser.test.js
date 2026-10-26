import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const parser = require("../../extension/parser.js");

function loadFixture(name) {
  const html = readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
  return new JSDOM(html).window.document;
}

const ALEX = "2-QUxFWDEyMw==";
const BEA = "2-QkVBNDU2";
const GROUP = "2-R1JPVVA3ODk=";
const EVE = "2-RVZFOTk5";
const FRANK = "2-RlJBTks=";
const AT = "2026-10-26T10:00:00.000Z";

describe("URL and text helpers", () => {
  it("extracts and decodes thread ids from relative and absolute links", () => {
    expect(parser.threadIdFromHref("/messaging/thread/2-ABC==/")).toBe("2-ABC==");
    expect(parser.threadIdFromHref("https://www.linkedin.com/messaging/thread/2-ABC%3D%3D/?x=1")).toBe("2-ABC==");
    expect(parser.threadIdFromHref("/messaging/")).toBe("");
    expect(parser.threadIdFromHref(null)).toBe("");
  });

  it("builds a readable thread URL", () => {
    expect(parser.threadUrlFor("2-ABC==")).toBe("https://www.linkedin.com/messaging/thread/2-ABC==/");
  });

  it("normalizes profile links and keeps member ids as-is", () => {
    expect(parser.profileUrlFromHref("/in/priya-sharma?trk=x")).toBe("https://www.linkedin.com/in/priya-sharma/");
    expect(parser.profileUrlFromHref("https://www.linkedin.com/in/ACoAAB12/")).toBe("https://www.linkedin.com/in/ACoAAB12/");
    expect(parser.profileUrlFromHref("/company/acme/")).toBe("");
  });

  it("strips the 'You:' prefix and marks the message as ours", () => {
    expect(parser.stripYouPrefix("You:  Hi there")).toEqual({ fromMe: true, text: "Hi there" });
    expect(parser.stripYouPrefix("Hi there")).toEqual({ fromMe: false, text: "Hi there" });
    expect(parser.stripYouPrefix("You sent an attachment")).toEqual({ fromMe: true, text: "You sent an attachment" });
    expect(parser.stripYouPrefix("Simar sent a post")).toEqual({ fromMe: false, text: "Simar sent a post" });
  });

  it("strips the contact's first name prefix only", () => {
    expect(parser.stripSenderPrefix("Bea: Sounds good", "Bea Example")).toBe("Sounds good");
    expect(parser.stripSenderPrefix("Note: read this", "Bea Example")).toBe("Note: read this");
  });

  it("recognizes group chat names", () => {
    expect(parser.isGroupName("Cara Demo, Dan Sample and 2 others")).toBe(true);
    expect(parser.isGroupName("Cara Demo and Dan Sample")).toBe(true);
    expect(parser.isGroupName("Alex Tester")).toBe(false);
  });

  it("strips credentials after a name but keeps other names", () => {
    expect(parser.stripCredentials("Priya Sharma, MBA")).toBe("Priya Sharma");
    expect(parser.stripCredentials("Sam Lee, Ph.D., PMP")).toBe("Sam Lee");
    expect(parser.stripCredentials("Jo Bloggs Jr.")).toBe("Jo Bloggs Jr.");
    expect(parser.stripCredentials("Cara Demo, Dan Sample")).toBe("Cara Demo, Dan Sample");
    expect(parser.stripCredentials("Ana, Ben")).toBe("Ana, Ben");
  });

  it("builds signatures that tolerate truncated previews", () => {
    const full = { lastMessage: { fromMe: true, text: "Following up on my note about the pilot. Here is more." } };
    const preview = { lastMessage: { fromMe: true, text: "Following up on my note about the pi…" } };
    expect(parser.signature(full)).toBe(parser.signature(preview));
    expect(parser.signature({ lastMessage: { fromMe: false, text: "Following up on my note about the pilot" } })).not.toBe(
      parser.signature(full)
    );
    expect(parser.signature({ lastMessage: null })).toBe("none");
  });
});

describe("parseConversationList", () => {
  const { conversations } = parser.parseConversationList(loadFixture("list.html"), "/messaging/");
  const byName = (name) => conversations.filter((c) => c.name === name);

  it("reads every named item, with a thread id only where the page shows one", () => {
    expect(conversations.map((c) => c.name)).toEqual([
      "Alex Tester",
      "Bea Example",
      "Cara Demo, Dan Sample and 2 others",
      "Eve Placeholder",
      "Finn Mock",
      "Gus Twin",
      "Gus Twin",
    ]);
    expect(conversations.map((c) => c.threadId)).toEqual(["", "", "", "", "2-RklOTg==", "", ""]);
    expect(byName("Finn Mock")[0].threadUrl).toBe("https://www.linkedin.com/messaging/thread/2-RklOTg==/");
  });

  it("skips sponsored InMail ads and empty placeholders", () => {
    expect(conversations.some((c) => c.name === "Some Brand")).toBe(false);
    expect(conversations).toHaveLength(7);
  });

  it("keys items by name and flags names that appear twice", () => {
    expect(conversations.map((c) => c.key)).toEqual([
      "alex tester",
      "bea example",
      "cara demo, dan sample and 2 others",
      "eve placeholder",
      "finn mock",
      "gus twin",
      "gus twin#2",
    ]);
    expect(conversations.map((c) => c.ambiguous)).toEqual([false, false, false, false, false, true, true]);
  });

  it("drops credentials from a name instead of treating it as a group", () => {
    expect(byName("Finn Mock")[0]).toMatchObject({ isGroup: false });
  });

  it("reads an outbound preview without the 'You:' prefix", () => {
    expect(conversations[0]).toMatchObject({
      name: "Alex Tester",
      isGroup: false,
      unread: false,
      lastMessage: { fromMe: true, text: "Following up on my note about the pilot" },
    });
  });

  it("reads 'You sent an attachment' as our message", () => {
    expect(byName("Eve Placeholder")[0].lastMessage).toEqual({ fromMe: true, text: "You sent an attachment" });
  });

  it("reads an unread inbound preview", () => {
    expect(conversations[1]).toMatchObject({
      name: "Bea Example",
      unread: true,
      lastMessage: { fromMe: false, text: "Sounds good, Tuesday works for me" },
    });
  });

  it("flags group chats and keeps the other sender's prefix", () => {
    expect(conversations[2]).toMatchObject({ isGroup: true, lastMessage: { fromMe: false, text: "Dan: See you all there" } });
  });

  it("returns nothing on an unrelated page instead of throwing", () => {
    const doc = new JSDOM("<p>feed</p>").window.document;
    expect(parser.parseConversationList(doc, "/feed/")).toEqual({ conversations: [] });
  });
});

describe("parseOpenThread", () => {
  it("returns null when no thread is open", () => {
    expect(parser.parseOpenThread(loadFixture("list.html"), "/messaging/")).toBeNull();
  });

  it("our last message carries the receipt: seen", () => {
    const thread = parser.parseOpenThread(loadFixture("thread-seen-last.html"), "/messaging/thread/" + ALEX + "/");
    expect(thread).toMatchObject({
      threadId: ALEX,
      name: "Alex Tester",
      profileUrl: "https://www.linkedin.com/in/alex-tester-fake/",
      isGroup: false,
      seen: true,
      lastMessage: { fromMe: true, text: "Following up on my note about the pilot. Here is a short summary." },
    });
    expect(thread.messages.map((m) => m.fromMe)).toEqual([true, false, true]);
  });

  it("the always-present 'without-seen-receipt' container is not a receipt", () => {
    const thread = parser.parseOpenThread(loadFixture("thread-seen-earlier.html"), "/messaging/thread/2-RlJBTks=/");
    expect(thread.seen).toBe(false);
  });

  it("receipt on an earlier message only: not seen", () => {
    const thread = parser.parseOpenThread(loadFixture("thread-seen-earlier.html"), "/messaging/thread/2-RlJBTks%3D/");
    expect(thread.threadId).toBe(FRANK);
    expect(thread.profileUrl).toBe("https://www.linkedin.com/in/ACoAAFakeMemberId123/");
    expect(thread.seen).toBe(false);
    expect(thread.lastMessage).toEqual({ fromMe: true, text: "Sharing the deck I mentioned." });
  });

  it("lead replied last: not seen, last message is theirs", () => {
    const thread = parser.parseOpenThread(loadFixture("thread-lead-last.html"), "/messaging/thread/" + EVE + "/");
    expect(thread.seen).toBe(false);
    expect(thread.lastMessage).toEqual({ fromMe: false, text: "Happy to help, send it over" });
    expect(thread.profileUrl).toBe("https://www.linkedin.com/in/eve-placeholder-fake/");
  });

  it("keeps only the last 10 messages, oldest first", () => {
    const items = Array.from({ length: 14 }, (_, i) => {
      const other = i % 2 ? " msg-s-event-listitem--other" : "";
      return `<li class="msg-s-message-list__event"><div class="msg-s-event-listitem${other}"><p class="msg-s-event-listitem__body">m${i}</p></div></li>`;
    }).join("");
    const doc = new JSDOM(`<ul class="msg-s-message-list-content">${items}</ul>`).window.document;
    const thread = parser.parseOpenThread(doc, "/messaging/thread/2-X/");
    expect(thread.messages).toHaveLength(10);
    expect(thread.messages[0]).toEqual({ fromMe: true, text: "m4" });
    expect(thread.messages[9]).toEqual({ fromMe: false, text: "m13" });
  });

  it("thread with no rendered messages yet: empty, not seen", () => {
    const doc = new JSDOM("<div></div>").window.document;
    expect(parser.parseOpenThread(doc, "/messaging/thread/2-X/")).toMatchObject({ messages: [], lastMessage: null, seen: false });
  });
});

describe("mergeConversations", () => {
  function readPage(fixture, pathname) {
    const doc = loadFixture(fixture);
    const list = parser.parseConversationList(doc, pathname).conversations;
    return parser.mergeConversations(list, parser.parseOpenThread(doc, pathname), AT);
  }

  it("list-only conversations get the payload shape with no thread details", () => {
    const merged = readPage("list.html", "/messaging/");
    expect(merged[1]).toEqual({
      threadId: "",
      threadUrl: "",
      key: "bea example",
      ambiguous: false,
      name: "Bea Example",
      profileUrl: "",
      isGroup: false,
      fresh: false,
      observedAt: AT,
      lastMessage: { fromMe: false, text: "Sounds good, Tuesday works for me" },
      seen: null,
      messages: [],
    });
  });

  it("the open thread's item gets its id from the URL and the thread's details", () => {
    const merged = readPage("thread-seen-last.html", "/messaging/thread/" + ALEX + "/");
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      threadId: ALEX,
      threadUrl: "https://www.linkedin.com/messaging/thread/2-QUxFWDEyMw==/",
      profileUrl: "https://www.linkedin.com/in/alex-tester-fake/",
      seen: true,
    });
    expect(merged[0].messages).toHaveLength(3);
    expect(merged[1]).toMatchObject({ threadId: "", name: "Bea Example", seen: null, messages: [] });
  });

  it("keeps the list preview text, so the same message reads the same with the thread open or closed", () => {
    const merged = readPage("thread-seen-last.html", "/messaging/thread/" + ALEX + "/");
    expect(merged[0].lastMessage).toEqual({ fromMe: true, text: "Following up on my note about the pilot. Here is a sh…" });
  });

  it("takes who sent the last message from the thread, not the preview", () => {
    const list = [{ threadId: EVE, threadUrl: "u", key: "eve", name: "Eve", isGroup: false, lastMessage: { fromMe: false, text: "Subject line" } }];
    const thread = { threadId: EVE, threadUrl: "u", name: "Eve", profileUrl: "", isGroup: false, lastMessage: { fromMe: true, text: "Body" }, seen: false, messages: [{ fromMe: true, text: "Body" }] };
    expect(parser.mergeConversations(list, thread, AT)[0].lastMessage).toEqual({ fromMe: true, text: "Subject line" });
  });

  it("an open thread missing from the list is appended with the thread's last message", () => {
    const merged = readPage("thread-seen-earlier.html", "/messaging/thread/2-RlJBTks=/");
    expect(merged.map((c) => c.threadId)).toEqual(["", FRANK]);
    expect(merged[1]).toMatchObject({
      key: "thread:" + FRANK,
      name: "Frank Mock",
      seen: false,
      observedAt: AT,
      lastMessage: { fromMe: true, text: "Sharing the deck I mentioned." },
    });
  });

  it("the lead's reply in the open thread", () => {
    const merged = readPage("thread-lead-last.html", "/messaging/thread/" + EVE + "/");
    expect(merged.map((c) => c.threadId)).toEqual([EVE, ""]);
    expect(merged[0]).toMatchObject({ name: "Eve Placeholder", lastMessage: { fromMe: false, text: "Happy to help, send it over" } });
  });

  it("group chats never carry a single profile URL", () => {
    const list = [{ threadId: GROUP, threadUrl: "u", name: "A, B", isGroup: true, lastMessage: null }];
    const thread = { threadId: GROUP, threadUrl: "u", name: "A, B", profileUrl: "https://www.linkedin.com/in/a/", isGroup: true, lastMessage: null, seen: false, messages: [] };
    expect(parser.mergeConversations(list, thread, AT)[0].profileUrl).toBe("");
  });
});

describe("countSelectorMatches", () => {
  it("reports a count for every fallback of every key", () => {
    const report = parser.countSelectorMatches(loadFixture("thread-seen-last.html"));
    expect(report.conversationItem[0]).toEqual({ selector: "li.msg-conversation-listitem", count: 2 });
    expect(report.seenReceipt[0].count).toBe(1);
    expect(Object.values(report).every((entries) => entries.every((e) => typeof e.count === "number"))).toBe(true);
  });
});
