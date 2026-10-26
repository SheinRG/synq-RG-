import { beforeEach, describe, expect, it } from "vitest";
import { addHumanRows, code, completion, installGlobals } from "./fakes.js";

const { doPost, doGet, onEdit, runScheduledCheck, setUpSpreadsheet } = code;

let globals;
let ss;

beforeEach(() => {
  globals = installGlobals();
  ss = globals.spreadsheet;
  setUpSpreadsheet(ss);
  addHumanRows(ss, [{ name: "Priya Sharma", company: "Acme" }]);
});

const post = (body) => {
  const out = doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body), type: "text/plain" } });
  expect(out.mimeType).toBe("application/json");
  return JSON.parse(out.getContent());
};

const payload = (conversations) => ({ version: 1, observedAt: new Date().toISOString(), conversations });
const leadRow = () => ss.getSheetByName("Leads").rowObject(2);

describe("doGet", () => {
  it("answers the extension's Test connection", () => {
    const out = JSON.parse(doGet({}).getContent());
    expect(out).toEqual({ ok: true, app: "linkedin-lead-tracker", version: 1, sheet: "Lead Tracker CRM" });
  });
});

describe("doPost", () => {
  it("syncs conversations and returns one result per conversation", () => {
    const res = post(
      payload([
        { threadId: "2-P", name: "Priya Sharma", fresh: true, lastMessage: { fromMe: true, text: "Hi Priya" }, seen: null, messages: [] },
        { threadId: "2-G", name: "Team chat", isGroup: true, lastMessage: { fromMe: false, text: "yo" } },
      ]),
    );
    expect(res).toEqual({
      ok: true,
      results: [
        { threadId: "2-P", leadId: "L-0001", status: "Message sent", action: "updated" },
        { threadId: "2-G", leadId: "", status: "", action: "ignored", reason: "group conversation" },
      ],
    });
    expect(leadRow().Status).toBe("Message sent");
    expect(globals.lock.held).toBe(false);
  });

  it("labels a reply with the configured LLM and returns ok", () => {
    globals = installGlobals({
      spreadsheet: ss,
      properties: { LLM_API_KEY: "xai-test" },
      fetchAll: (requests) => requests.map(() => completion({ category: "Later", confidence: 0.7, summary: "Next quarter", suggested_reply: "Sure, I'll ping you in January" })),
    });
    const res = post(payload([{ threadId: "2-P", name: "Priya Sharma", fresh: true, lastMessage: { fromMe: false, text: "Maybe next quarter" } }]));
    expect(res.results[0]).toMatchObject({ status: "Replied", action: "updated" });
    expect(leadRow()).toMatchObject({ "Reply Category": "Later", "Suggested Follow-up": "Sure, I'll ping you in January" });
    const request = globals.urlFetch.calls[0][0];
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer xai-test");
  });

  it.each([
    [undefined, "Empty request body"],
    ["", "Empty request body"],
    ["{not json", "not valid JSON"],
    [JSON.stringify({ version: 9, observedAt: "2026-10-26T10:00:00Z", conversations: [] }), "Unsupported payload version"],
    [JSON.stringify({ version: 1, observedAt: "2026-10-26T10:00:00Z", conversations: "nope" }), "conversations must be an array"],
  ])("rejects a bad body %j without throwing", (contents, error) => {
    const out = JSON.parse(doPost(contents === undefined ? {} : { postData: { contents } }).getContent());
    expect(out.ok).toBe(false);
    expect(out.error).toContain(error);
  });

  it("returns ok:false instead of throwing when the sheet is not set up", () => {
    ss.sheets.splice(0, ss.sheets.length);
    const res = post(payload([]));
    expect(res).toEqual({ ok: false, error: expect.stringContaining("Set up sheet") });
    expect(globals.lock.held).toBe(false);
  });

  it("returns ok:false when the lock cannot be taken", () => {
    globalThis.LockService = {
      getScriptLock: () => ({
        waitLock() {
          throw new Error("Lock timeout: another process was holding the lock for too long.");
        },
        releaseLock() {},
      }),
    };
    expect(post(payload([]))).toEqual({ ok: false, error: expect.stringContaining("Lock timeout") });
  });
});

describe("runScheduledCheck", () => {
  it("uses DEMO_MODE minutes and shows a toast", () => {
    globals = installGlobals({ spreadsheet: ss, properties: { DEMO_MODE: "true", NOT_REPLIED_AFTER_DAYS: "2" } });
    const sentAt = new Date(Date.now() - 3 * 60_000).toISOString();
    post({ version: 1, observedAt: sentAt, conversations: [{ threadId: "2-P", name: "Priya Sharma", fresh: true, lastMessage: { fromMe: true, text: "Hi" } }] });
    const summary = runScheduledCheck();
    expect(summary).toMatchObject({ checked: 1, changed: 1, drafted: 0 });
    expect(leadRow()).toMatchObject({ Status: "Follow-up due", "Suggested Follow-up": "" });
    expect(ss.toasts.at(-1)).toContain("Checked 1 leads");
  });
});

describe("onEdit", () => {
  it("gives a freshly typed row its Lead ID and Not contacted", () => {
    const sheet = ss.getSheetByName("Leads");
    onEdit({ source: ss, range: sheet.getRange(2, 2) });
    expect(leadRow()).toMatchObject({ "Lead ID": "L-0001", Status: "Not contacted", Source: "Manual" });
    expect(globals.lock.held).toBe(false);
  });

  it("ignores edits on other tabs and never throws", () => {
    onEdit({ source: ss, range: ss.getSheetByName("Summary").getRange(2, 2) });
    expect(leadRow()["Lead ID"]).toBe("");
    expect(() => onEdit(undefined)).not.toThrow();
    expect(() => onEdit({ range: { getSheet: () => { throw new Error("boom"); } } })).not.toThrow();
  });
});
