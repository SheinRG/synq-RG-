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

function renderDiagnostics(report) {
  const box = diagnosticsBox;
  const waiting = report.waitingNames || [];
  box.append(el("div", "", "Conversations read: " + report.listCount + ", tracked: " + (report.listCount - waiting.length)));
  if (waiting.length) {
    box.append(
      el(
        "div",
        "muted",
        "Not tracked until opened once (LinkedIn's list has no thread links): " +
          waiting.slice(0, 6).join(", ") + (waiting.length > 6 ? " and " + (waiting.length - 6) + " more" : "")
      )
    );
  }

  const thread = report.openThread;
  box.append(
    el(
      "div",
      "",
      thread
        ? "Open thread: " + (thread.name || "(no name found)") + ", " + thread.messageCount + " message(s), last from " +
            (thread.lastFromMe === null ? "?" : thread.lastFromMe ? "you" : "them") + ", seen: " + (thread.seen ? "yes" : "no") +
            ", profile: " + (thread.profileUrl || "not found")
        : "Open thread: none"
    )
  );

  // One row per selector key: the first fallback that matched, or 0 in red.
  const table = el("table");
  for (const [key, entries] of Object.entries(report.selectorCounts)) {
    const hit = entries.find((e) => e.count > 0);
    const row = el("tr");
    row.append(el("td", "", key));
    row.append(el("td", "muted", hit ? hit.selector : "no selector matched"));
    row.append(el("td", "count" + (hit ? "" : " zero"), String(hit ? hit.count : 0)));
    table.append(row);
  }
  box.append(el("label", "", "Selectors"), table);

  const list = el("ul");
  for (const c of report.conversations.slice(0, 8)) {
    const last = c.lastMessage ? (c.lastMessage.fromMe ? "You: " : "Them: ") + c.lastMessage.text.slice(0, 50) : "(no preview)";
    list.append(el("li", "", (c.name || "(no name)") + (c.isGroup ? " [group]" : "") + " - " + last));
  }
  box.append(el("label", "", "Parsed conversations"), list);

  const raw = el("details");
  raw.append(el("summary", "", "Raw report"), el("pre", "", JSON.stringify(report, null, 2)));
  box.append(raw);
}

function renderLastSync(lastSync) {
  if (!lastSync) {
    lastSyncBox.textContent = "Not synced yet.";
    lastSyncBox.className = "muted";
    return;
  }
  const when = new Date(lastSync.at).toLocaleString();
  if (lastSync.ok) {
    lastSyncBox.textContent = when + ": OK, " + lastSync.sent + " conversation(s) sent." + countsText(lastSync.counts);
    lastSyncBox.className = "ok";
  } else {
    lastSyncBox.textContent = when + ": failed. " + lastSync.error + " Unsent changes will be retried on the next sync.";
    lastSyncBox.className = "error";
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastSync) renderLastSync(changes.lastSync.newValue);
});

loadUrl();
chrome.storage.local.get("lastSync").then(({ lastSync }) => renderLastSync(lastSync));
