// Service worker: the only part that talks to the Apps Script web app.
// content.js hands it payloads; the popup asks it to test the connection.

importScripts("shared.js");

const { isValidScriptUrl, summarizeResults, mergePending } = globalThis.LeadTrackerShared;
const LOG = "[lead-tracker]";
const NO_URL_ERROR =
  "No Apps Script URL set. Click the extension icon and paste your web app URL.";

// Syncs run one at a time so two of them cannot overwrite each other's
// pending/lastSync records.
let syncChain = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "sync") {
    const run = syncChain.then(() => handleSync(message.payload));
    syncChain = run.catch(() => {});
    run.then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async response
  }
  if (message.type === "testConnection") {
    testConnection(message.url).then(sendResponse);
    return true;
  }
  return false;
});

async function getScriptUrl() {
  const { scriptUrl } = await chrome.storage.sync.get("scriptUrl");
  return String(scriptUrl || "").trim();
}

async function handleSync(payload) {
  const { pending } = await chrome.storage.local.get("pending");
  const conversations = mergePending(pending, payload && payload.conversations);
  if (conversations.length === 0) return { ok: true, sent: 0 };

  const body = Object.assign({}, payload, { conversations });
  const scriptUrl = await getScriptUrl();
  if (!isValidScriptUrl(scriptUrl)) return recordFailure(conversations, NO_URL_ERROR);

  try {
    const data = await requestJson(scriptUrl, {
      method: "POST",
      // text/plain keeps this a "simple" request; Apps Script reads the raw
      // body from e.postData.contents.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!data.ok) throw new Error(data.error || "The Apps Script reported an error.");

    const lastSync = {
      at: new Date().toISOString(),
      ok: true,
      sent: conversations.length,
      counts: summarizeResults(data.results),
      error: "",
    };
    await chrome.storage.local.set({ pending: [], lastSync });
    await chrome.action.setBadgeText({ text: "" });
    return { ok: true, sent: conversations.length, counts: lastSync.counts, results: data.results };
  } catch (err) {
    return recordFailure(conversations, err.message || String(err));
  }
}

// Keep what we failed to send so the next sync retries it, and flag the badge.
async function recordFailure(conversations, error) {
  console.warn(LOG, "sync failed:", error);
  const lastSync = { at: new Date().toISOString(), ok: false, sent: 0, counts: null, error };
  await chrome.storage.local.set({ pending: conversations, lastSync });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  await chrome.action.setBadgeText({ text: "!" });
  return { ok: false, error };
}

async function testConnection(url) {
  const scriptUrl = String(url || (await getScriptUrl())).trim();
  if (!isValidScriptUrl(scriptUrl)) {
    return {
      ok: false,
      error: "That doesn't look like an Apps Script web app URL (https://script.google.com/macros/s/.../exec).",
    };
  }
  try {
    const data = await requestJson(scriptUrl, { method: "GET" });
    if (data.app !== "linkedin-lead-tracker") {
      return { ok: false, error: "This URL answered, but it isn't the Lead Tracker Apps Script." };
    }
    return { ok: true, sheet: data.sheet || "", version: data.version };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// fetch + JSON parse with error messages a non-developer can act on. Apps
// Script answers with a redirect to script.googleusercontent.com; fetch follows it.
async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, Object.assign({ redirect: "follow" }, options));
  } catch (err) {
    throw new Error("Could not reach the Apps Script (network error). Are you online?");
  }
  const text = await response.text();
  if (!response.ok) throw new Error("The Apps Script returned HTTP " + response.status + ".");
  try {
    return JSON.parse(text);
  } catch (err) {
    // Usually a Google sign-in page: the deployment is not open to "Anyone".
    throw new Error(
      "The Apps Script did not return JSON. Check the deployment's \"Who has access\" is set to \"Anyone\"."
    );
  }
}
