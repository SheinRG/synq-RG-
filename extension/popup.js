// Popup: save the Apps Script URL, test it, trigger a sync, and show
// diagnostics. Page data is always inserted as text (never innerHTML), since
// names and messages come from LinkedIn.

const { isValidScriptUrl } = globalThis.LeadTrackerShared;

const urlInput = document.getElementById("scriptUrl");
const connectionStatus = document.getElementById("connectionStatus");
const syncStatus = document.getElementById("syncStatus");
const diagnosticsBox = document.getElementById("diagnostics");
const lastSyncBox = document.getElementById("lastSync");

function showStatus(target, text, kind) {
  target.textContent = text;
  target.className = "status " + (kind || "muted");
}

// Tiny element builder so we never need innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- Apps Script URL ----

async function loadUrl() {
  const { scriptUrl } = await chrome.storage.sync.get("scriptUrl");
  urlInput.value = scriptUrl || "";
}

document.getElementById("save").addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!isValidScriptUrl(url)) {
    showStatus(connectionStatus, "Paste the web app URL ending in /exec (from Deploy > Manage deployments).", "error");
    return;
  }
  await chrome.storage.sync.set({ scriptUrl: url });
  showStatus(connectionStatus, "Saved.", "ok");
});

document.getElementById("test").addEventListener("click", async (event) => {
  event.target.disabled = true;
  showStatus(connectionStatus, "Testing...");
  try {
    const result = await chrome.runtime.sendMessage({ type: "testConnection", url: urlInput.value.trim() });
    if (result && result.ok) {
      showStatus(connectionStatus, "Connected to sheet \"" + (result.sheet || "unnamed") + "\".", "ok");
    } else {
      showStatus(connectionStatus, (result && result.error) || "Test failed.", "error");
    }
  } finally {
    event.target.disabled = false;
  }
});

// ---- Talking to the LinkedIn tab ----

async function getMessagingTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is only visible to us on linkedin.com (our host permission).
  const url = (tab && tab.url) || "";
  if (!url.startsWith("https://www.linkedin.com/")) return { tab: null, reason: "notLinkedIn" };
  if (!new URL(url).pathname.startsWith("/messaging")) return { tab, reason: "notMessaging" };
  return { tab, reason: "" };
}

async function sendToTab(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    // The tab was opened before the extension was installed or reloaded.
    return { ok: false, error: "Couldn't reach the page. Reload the LinkedIn tab and try again." };
  }
}

document.getElementById("syncNow").addEventListener("click", async (event) => {
  const { tab, reason } = await getMessagingTab();
  if (reason) {
    showStatus(syncStatus, "Open LinkedIn Messages (linkedin.com/messaging) in this tab, then try again.", "error");
    return;
  }
  event.target.disabled = true;
  showStatus(syncStatus, "Syncing...");
  try {
    const result = await sendToTab(tab, { type: "syncNow" });
    if (result && result.ok) {
      const text = result.sent
        ? "Sent " + result.sent + " conversation(s)." + countsText(result.counts)
        : result.note || "Nothing to send.";
      showStatus(syncStatus, text, "ok");
    } else {
      showStatus(syncStatus, (result && result.error) || "Sync failed.", "error");
    }
  } finally {
    event.target.disabled = false;
  }
});

document.getElementById("diagnose").addEventListener("click", async () => {
  diagnosticsBox.replaceChildren();
  const { tab, reason } = await getMessagingTab();
  if (reason === "notLinkedIn") {
    showStatus(syncStatus, "This tab isn't LinkedIn. Open LinkedIn Messages first.", "error");
    return;
  }
  const result = await sendToTab(tab, { type: "diagnose" });
  if (!result || !result.ok) {
    showStatus(syncStatus, (result && result.error) || "Check failed.", "error");
    return;
  }
  showStatus(syncStatus, reason === "notMessaging" ? "Not a Messages page: the tracker stays idle here." : "", "muted");
  renderDiagnostics(result.report);
});

// ---- Rendering ----

function countsText(counts) {
  if (!counts) return "";
  return " Updated " + counts.updated + ", added " + counts.added + ", unchanged " + counts.unchanged + ", ignored " + counts.ignored + ".";
}

// Selectors that legitimately match nothing on many pages: no thread links on
// today's LinkedIn, no unread or sponsored items, a thread with no receipt or
// no message from the other person. Zero is shown in grey for these.
const OPTIONAL_SELECTORS = new Set(["itemThreadLink", "itemUnread", "itemSponsoredLabel", "messageFromOther", "seenReceipt"]);

function stat(value, label) {
  const box = el("div", "stat");
  box.append(el("b", "", String(value)), el("span", "", label));
  return box;
}

function renderDiagnostics(report) {
  const box = diagnosticsBox;
  const waiting = report.waitingNames || [];

  const stats = el("div", "stats");
  stats.append(stat(report.listCount, "read"), stat(report.listCount - waiting.length, "tracked"), stat(waiting.length, "not opened yet"));
  box.append(stats);

  if (waiting.length) {
    const note = el("div", "note", "Open these once so the tracker learns their thread:");
    const chips = el("div", "chips");
    for (const name of waiting) chips.append(el("span", "chip", name));
    note.append(chips);
    box.append(note);
  }

  const thread = report.openThread;
  if (thread) {
    const card = el("div", "thread");
    card.append(el("b", "", thread.name || "(no name found)"));
    const from = thread.lastFromMe === null ? "?" : thread.lastFromMe ? "you" : "them";
    card.append(el("div", "muted", thread.messageCount + " message(s), last from " + from + (thread.seen ? ", seen" : ", not seen")));
    if (thread.profileUrl) {
      const link = el("a", "", thread.profileUrl.replace("https://www.", ""));
      link.href = thread.profileUrl;
      link.target = "_blank";
      card.append(link);
    }
    box.append(card);
  } else {
    box.append(el("div", "note", "No thread open. Open a conversation to see its details."));
  }

  const convos = el("details");
  convos.append(el("summary", "", "Parsed conversations"));
  const list = el("ul", "convos");
  for (const c of report.conversations.slice(0, 12)) {
    const row = el("li");
    const fromMe = c.lastMessage && c.lastMessage.fromMe;
    row.append(el("span", "who" + (fromMe ? " me" : ""), c.lastMessage ? (fromMe ? "You" : "Them") : "?"));
    row.append(el("span", "name", (c.name || "(no name)") + (c.isGroup ? " (group)" : "")));
    row.append(el("span", "text", c.lastMessage ? c.lastMessage.text : "(no preview)"));
    list.append(row);
  }
  convos.append(list);
  box.append(convos);

  // One row per selector key: the first fallback that matched, or 0.
  const table = el("table");
  let missing = 0;
  for (const [key, entries] of Object.entries(report.selectorCounts)) {
    const hit = entries.find((e) => e.count > 0);
    const optional = OPTIONAL_SELECTORS.has(key);
    if (!hit && !optional) missing++;
    const row = el("tr");
    row.append(el("td", "", key));
    row.append(el("td", "sel", hit ? hit.selector : optional ? "none on this page" : "no selector matched"));
    row.append(el("td", "count" + (hit ? "" : optional ? " optional" : " zero"), String(hit ? hit.count : 0)));
    table.append(row);
  }
  const selectors = el("details");
  const summary = el("summary", "", "Selector health");
  summary.append(el("span", "pill " + (missing ? "error" : "ok"), missing ? missing + " missing" : "All good"));
  selectors.append(summary, table);
  if (missing) selectors.open = true;
  box.append(selectors);

  const raw = el("details");
  raw.append(el("summary", "", "Raw report"), el("pre", "", JSON.stringify(report, null, 2)));
  box.append(raw);
}

function renderLastSync(lastSync) {
  const pill = document.getElementById("statusPill");
  if (!lastSync) {
    lastSyncBox.textContent = "Not synced yet.";
    lastSyncBox.className = "muted";
    pill.textContent = "Not synced";
    pill.className = "pill";
    return;
  }
  const when = new Date(lastSync.at).toLocaleString();
  if (lastSync.ok) {
    lastSyncBox.textContent = "Last sync " + when + ": " + lastSync.sent + " conversation(s) sent." + countsText(lastSync.counts);
    lastSyncBox.className = "muted";
    pill.textContent = "Synced";
    pill.className = "pill ok";
  } else {
    lastSyncBox.textContent = "Last sync " + when + " failed: " + lastSync.error + " Unsent changes are retried on the next sync.";
    lastSyncBox.className = "error";
    pill.textContent = "Sync failed";
    pill.className = "pill error";
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastSync) renderLastSync(changes.lastSync.newValue);
});

// Forget which conversations count as new activity, so everything in the inbox
// right now becomes the starting point again (as on install). Thread ids
// learned so far are kept. Handy after clearing test rows from the Sheet.
document.getElementById("startFresh").addEventListener("click", async () => {
  await chrome.storage.local.remove(["freshStateV2", "pending"]);
  const status = document.getElementById("startFreshStatus");
  status.textContent = " Done. Conversations in your inbox now are the new starting point.";
});

loadUrl();
chrome.storage.local.get("lastSync").then(({ lastSync }) => renderLastSync(lastSync));
