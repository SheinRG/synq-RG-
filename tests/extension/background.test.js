import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs background.js in a sandbox with a fake chrome.* and fetch, the way
// Chrome runs the service worker, and talks to it through its message listener.

const SOURCE = readFileSync(new URL("../../extension/background.js", import.meta.url), "utf8");
const SHARED = readFileSync(new URL("../../extension/shared.js", import.meta.url), "utf8");
const URL_OK = "https://script.google.com/macros/s/AKfycbxFake/exec";

function loadWorker({ scriptUrl = URL_OK, fetchImpl }) {
  const local = {};
  const badge = { text: "" };
  let listener;
  const sandbox = {
    console: { warn() {}, log() {} },
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
      storage: {
        sync: { get: async () => ({ scriptUrl }) },
        local: {
          get: async (key) => ({ [key]: local[key] }),
          set: async (values) => Object.assign(local, values),
        },
      },
      action: {
        setBadgeText: async ({ text }) => (badge.text = text),
        setBadgeBackgroundColor: async () => {},
      },
    },
    fetch: fetchImpl,
  };
  sandbox.globalThis = sandbox;
  sandbox.importScripts = () => vm.runInContext(SHARED, sandbox);
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  const send = (message) =>
    new Promise((resolve) => {
      listener(message, {}, resolve);
    });
  return { send, local, badge };
}

const reply = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const convo = (threadId, text) => ({ threadId, name: "Fake " + threadId, lastMessage: { fromMe: true, text } });
const payload = (...conversations) => ({ version: 1, observedAt: "2026-10-26T10:00:00.000Z", conversations });

let requests;
beforeEach(() => {
  requests = [];
});

function recording(handler) {
  return async (url, options) => {
    requests.push({ url, options });
    return handler(url, options);
  };
}

describe("background sync", () => {
  it("posts the payload as text/plain and records the result", async () => {
    const worker = loadWorker({ fetchImpl: recording(reply({ ok: true, results: [{ action: "updated" }] })) });
    const res = await worker.send({ type: "sync", payload: payload(convo("a", "hi")) });

    expect(res).toMatchObject({ ok: true, sent: 1, counts: { updated: 1, added: 0, unchanged: 0, ignored: 0 } });
    expect(requests[0].url).toBe(URL_OK);
    expect(requests[0].options.headers["Content-Type"]).toBe("text/plain;charset=utf-8");
    expect(JSON.parse(requests[0].options.body).conversations).toHaveLength(1);
    expect(worker.local.lastSync).toMatchObject({ ok: true, sent: 1 });
    expect(worker.local.pending).toEqual([]);
  });

  it("keeps a failed send and retries it with the next one, newest reading per thread", async () => {
    let fail = true;
    const worker = loadWorker({
      fetchImpl: recording(async () => (fail ? reply({ ok: false, error: "No \"Leads\" tab." })() : reply({ ok: true, results: [] })())),
    });

    const first = await worker.send({ type: "sync", payload: payload(convo("a", "old a"), convo("b", "b")) });
    expect(first).toEqual({ ok: false, error: 'No "Leads" tab.' });
    expect(worker.badge.text).toBe("!");
    expect(worker.local.pending).toHaveLength(2);

    fail = false;
    const second = await worker.send({ type: "sync", payload: payload(convo("a", "new a")) });
    expect(second).toMatchObject({ ok: true, sent: 2 });
    const sent = JSON.parse(requests[1].options.body).conversations;
    expect(sent.map((c) => [c.threadId, c.lastMessage.text])).toEqual([
      ["b", "b"],
      ["a", "new a"],
    ]);
    expect(worker.badge.text).toBe("");
  });

  it("explains a missing URL instead of calling anything", async () => {
    const worker = loadWorker({ scriptUrl: "", fetchImpl: recording(reply({})) });
    const res = await worker.send({ type: "sync", payload: payload(convo("a", "hi")) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No Apps Script URL set");
    expect(requests).toHaveLength(0);
  });

  it("turns a Google sign-in page into an access hint", async () => {
    const worker = loadWorker({ fetchImpl: recording(reply("<html>Sign in</html>")) });
    const res = await worker.send({ type: "sync", payload: payload(convo("a", "hi")) });
    expect(res.error).toContain('"Who has access" is set to "Anyone"');
  });
});

describe("background test connection", () => {
  it("returns the Sheet's name for the Lead Tracker script", async () => {
    const worker = loadWorker({ fetchImpl: recording(reply({ ok: true, app: "linkedin-lead-tracker", version: 1, sheet: "LinkedIn Spreadsheet" })) });
    expect(await worker.send({ type: "testConnection", url: URL_OK })).toEqual({ ok: true, sheet: "LinkedIn Spreadsheet", version: 1 });
    expect(requests[0].options.method).toBe("GET");
  });

  it("rejects a Sheet link or another script", async () => {
    const worker = loadWorker({ fetchImpl: recording(reply({ ok: true, app: "something-else" })) });
    const sheetLink = await worker.send({ type: "testConnection", url: "https://docs.google.com/spreadsheets/d/abc/edit" });
    expect(sheetLink.error).toContain("doesn't look like an Apps Script web app URL");
    expect(requests).toHaveLength(0);

    const other = await worker.send({ type: "testConnection", url: URL_OK });
    expect(other.error).toContain("isn't the Lead Tracker Apps Script");
  });

  it("reports a network failure in plain words", async () => {
    const worker = loadWorker({
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect((await worker.send({ type: "testConnection", url: URL_OK })).error).toContain("network error");
  });
});
