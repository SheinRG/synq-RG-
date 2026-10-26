// The whole path in one place: LinkedIn-shaped HTML -> the extension's parser
// and tracking -> the payload -> Code.js doPost -> rows in a fake Sheet.
// Each step does what content.js does on a scan, so this follows a lead
// through the demo: baseline, Message sent, Opened, Replied, with threads
// opened and closed in between. All names and messages are fake.

import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { addHumanRows, code, installGlobals } from "./apps-script/fakes.js";

const require = createRequire(import.meta.url);
const parser = require("../extension/parser.js");
const tracking = require("../extension/tracking.js");

// ---- LinkedIn-shaped pages (same markup as the live page on 2026-10-26) ----

function listItem({ name, preview, active }) {
  const activeClass = active ? " msg-conversations-container__convo-item-link--active" : "";
  return `<li class="msg-conversation-listitem">
    <div class="msg-conversation-listitem__link msg-conversations-container__convo-item-link${activeClass}" tabindex="0">
      <h3 class="msg-conversation-listitem__participant-names">${name}</h3>
      <p class="msg-conversation-card__message-snippet">${preview}</p>
    </div>
  </li>`;
}

function threadPane({ name, profile, messages }) {
  const events = messages
    .map(
      (m) => `<li class="msg-s-message-list__event clearfix">
        <div class="msg-s-event-listitem${m.fromMe ? "" : " msg-s-event-listitem--other"}${m.seen ? " msg-s-event-listitem--has-seen-receipts" : ""}">
          <p class="msg-s-event-listitem__body">${m.text}</p>
        </div>
        ${m.seen ? `<div class="msg-s-event-listitem__seen-receipts"><img alt="Seen by ${name} at 10:02 AM." src="data:," /></div>` : ""}
      </li>`,
    )
    .join("");
  return `<div class="msg-thread">
    <div class="msg-title-bar">
      <a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/${profile}">
        <h2 class="msg-entity-lockup__entity-title">${name}</h2>
      </a>
    </div>
    <ul class="msg-s-message-list-content">${events}
      <li class="msg-s-message-list__typing-indicator-container--without-seen-receipt"></li>
    </ul>
  </div>`;
}

/** items: list items, newest first. open: { threadId, name, profile, messages } or none. */
function page(items, open) {
  const list = items.map((item) => listItem({ ...item, active: open && item.name === open.name })).join("");
  const html = `<ul class="msg-conversations-container__conversations-list">${list}</ul>${open ? threadPane(open) : ""}`;
  return {
    doc: new JSDOM(`<!doctype html><body>${html}</body>`).window.document,
    pathname: open ? `/messaging/thread/${open.threadId}/` : "/messaging/",
  };
}

// ---- One browser session ----------------------------------------------------

let ss;
let session;
let clock;

beforeEach(() => {
  ss = installGlobals().spreadsheet;
  code.setUpSpreadsheet(ss);
  addHumanRows(ss, [{ name: "Priya Sharma", company: "Acme" }, { name: "Arjun Mehta", company: "Globex" }]);
  session = { memory: undefined, fresh: undefined, lastSent: {} };
  clock = Date.now() - 60 * 60 * 1000;
});

/** One automatic scan, as content.js runs it. Returns doPost's answer, or null when nothing was sent. */
function scan({ doc, pathname }) {
  clock += 60 * 1000;
  const observedAt = new Date(clock).toISOString();
  const list = parser.parseConversationList(doc, pathname).conversations;
  const merged = parser.mergeConversations(list, parser.parseOpenThread(doc, pathname), observedAt);
  const remembered = tracking.rememberThreads(merged, session.memory);
  session.memory = remembered.memory;
  const marked = tracking.applyFreshness(remembered.conversations, session.fresh);
  session.fresh = marked.state;

  const toSend = tracking.pickChanged(marked.conversations.filter((c) => c.threadId), session.lastSent);
  if (!toSend.length) return null;
  const payload = tracking.buildPayload(toSend, observedAt);
  session.lastSent = tracking.markSent(session.lastSent, payload.conversations);
  const out = code.doPost({ postData: { contents: JSON.stringify(payload) } });
  return JSON.parse(out.getContent());
}

const lead = (name) => {
  const sheet = ss.getSheetByName("Leads");
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    const obj = sheet.rowObject(row);
    if (obj.Name === name) return obj;
  }
  return null;
};
const leadCount = () => ss.getSheetByName("Leads").getLastRow() - 1;
// Status changes from LinkedIn activity, leaving out the "lead added" lines
// the script writes when it first sees a typed row.
const events = () => {
  const sheet = ss.getSheetByName("Events");
  const out = [];
  for (let row = 2; row <= sheet.getLastRow(); row++) out.push(sheet.rowObject(row));
  return out.filter((e) => e["New Status"] !== "Not contacted");
};

const OLD_FRIEND = { name: "Old Friend", preview: "Old: See you at the reunion" };
const PRIYA = "2-UFJJWUE=";
const OLD = "2-T0xE";

describe("end to end: LinkedIn page to Sheet row", () => {
  it("follows a lead from Not contacted to Message sent, Opened and Replied", () => {
    // Install: the inbox only has an old chat. It becomes the baseline.
    expect(scan(page([OLD_FRIEND]))).toBeNull();

    // We message Priya. Her thread is open, so its id comes from the URL.
    const sent = { fromMe: true, text: "Hi Priya, quick question about your team" };
    const priyaOpen = (messages) => ({ threadId: PRIYA, name: "Priya Sharma", profile: "ACoAAPriyaFake", messages });
    let res = scan(page([{ name: "Priya Sharma", preview: "You: Hi Priya, quick question about your team" }, OLD_FRIEND], priyaOpen([sent])));
    expect(res.results).toEqual([expect.objectContaining({ threadId: PRIYA, status: "Message sent" })]);
    expect(lead("Priya Sharma")).toMatchObject({ Status: "Message sent", "Thread ID": PRIYA, "Last Message From": "Us" });

    // The same screen again sends nothing.
    expect(scan(page([{ name: "Priya Sharma", preview: "You: Hi Priya, quick question about your team" }, OLD_FRIEND], priyaOpen([sent])))).toBeNull();

    // She reads it while the thread is open.
    res = scan(page([{ name: "Priya Sharma", preview: "You: Hi Priya, quick question about your team" }, OLD_FRIEND], priyaOpen([{ ...sent, seen: true }])));
    expect(lead("Priya Sharma").Status).toBe("Opened");

    // We switch to the old chat. Priya is now known by name only; nothing about her changes.
    scan(
      page(
        [{ name: "Priya Sharma", preview: "You: Hi Priya, quick question about your team" }, OLD_FRIEND],
        { threadId: OLD, name: "Old Friend", profile: "old-friend", messages: [{ fromMe: false, text: "See you at the reunion" }] },
      ),
    );
    expect(lead("Priya Sharma").Status).toBe("Opened");
    // The old chat was baseline, so it never becomes a lead.
    expect(lead("Old Friend")).toBeNull();

    // She replies while her thread is closed: the list alone is enough.
    scan(page([{ name: "Priya Sharma", preview: "Priya: Sounds good, can we talk Monday?" }, OLD_FRIEND]));
    expect(lead("Priya Sharma")).toMatchObject({ Status: "Replied", "Last Message From": "Lead", "Reply Category": "Unclassified" });

    expect(events().map((e) => e["New Status"])).toEqual(["Message sent", "Opened", "Replied"]);
    expect(leadCount()).toBe(2);
  });

  it("an attachment reads the same with the thread open or closed, so it is one event", () => {
    scan(page([OLD_FRIEND]));
    const arjun = { threadId: "2-QVJK", name: "Arjun Mehta", profile: "arjun-fake", messages: [{ fromMe: true, text: "Sharing my deck, have a look" }] };
    const preview = { name: "Arjun Mehta", preview: "You sent an attachment" };

    scan(page([preview, OLD_FRIEND], arjun));
    scan(page([preview, OLD_FRIEND]));
    scan(page([preview, OLD_FRIEND], arjun));

    expect(lead("Arjun Mehta")).toMatchObject({ Status: "Message sent", "Last Message Snippet": "You sent an attachment" });
    expect(events()).toHaveLength(1);
  });

  it("a subject-line message is ours once its thread has been opened, even when the preview lacks 'You:'", () => {
    scan(page([OLD_FRIEND]));
    const subject = { name: "Arjun Mehta", preview: "Applying for the intern role" };
    const open = { threadId: "2-QVJK", name: "Arjun Mehta", profile: "arjun-fake", messages: [{ fromMe: true, text: "Here are my projects" }] };

    scan(page([subject, OLD_FRIEND], open));
    scan(page([subject, OLD_FRIEND]));

    expect(lead("Arjun Mehta")).toMatchObject({ Status: "Message sent", "Last Message From": "Us" });
    expect(events().map((e) => e["New Status"])).toEqual(["Message sent"]);
  });

  it("a stranger who writes after install is added as a lead; one in the old inbox is not", () => {
    scan(page([OLD_FRIEND]));
    const stranger = { threadId: "2-TkVX", name: "New Person", profile: "new-person", messages: [{ fromMe: false, text: "Hi, saw your post" }] };
    scan(page([{ name: "New Person", preview: "New: Hi, saw your post" }, OLD_FRIEND], stranger));

    expect(lead("New Person")).toMatchObject({ Status: "Replied", Source: "Auto-added", "LinkedIn URL": "https://www.linkedin.com/in/new-person/" });
    expect(lead("Old Friend")).toBeNull();
  });
});
