const STORAGE_KEY = "chatgptSavedTextChatsV1";
const PENDING_PREFIX = "chatgptSavedChatPending:";
const OPEN_PREFIX = "chatgptSavedChatOpen:";
const ROUTE_STORAGE_KEY = "codex.chromeExtensionSidepanel.routesByTab";
const ROUTE_SESSION_KEY = "codex.chromeExtensionSidepanel.routeSessionId";

const styles = document.createElement("style");
styles.textContent = `
  #chatgpt-save-selection-chat { position: fixed; left: 14px; top: 64px; z-index: 2147483647;
    display: none; align-items: center; gap: 7px; padding: 9px 12px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    border-radius: 999px; background: #111; color: white; box-shadow: 0 5px 20px rgba(0,0,0,.22);
    cursor: pointer; font: 600 13px/1.1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  #chatgpt-save-selection-chat:hover { background: #292929; }
  #chatgpt-save-selection-chat:disabled { cursor: default; opacity: .72; }
  #chatgpt-save-selection-chat[data-visible="true"] { display: inline-flex; }
  #chatgpt-save-selection-chat-status { position: fixed; left: 14px; top: 110px; z-index: 2147483647;
    max-width: 260px; padding: 8px 10px; border-radius: 9px; background: #fff; color: #222;
    box-shadow: 0 4px 18px rgba(0,0,0,.18); font: 12px/1.35 ui-sans-serif,sans-serif; }
  @media (prefers-color-scheme: dark) { #chatgpt-save-selection-chat-status { background:#2b2b2b; color:#f5f5f5; } }
`;
document.head.append(styles);

const button = document.createElement("button");
button.id = "chatgpt-save-selection-chat";
button.type = "button";
button.innerHTML = "<span aria-hidden=\"true\">✦</span><span>Save chat for selection</span>";
document.body.append(button);

let windowId = null;
let pending = null;

const pendingKey = () => `${PENDING_PREFIX}${windowId}`;
const openKey = () => `${OPEN_PREFIX}${windowId}`;

function status(message) {
  document.getElementById("chatgpt-save-selection-chat-status")?.remove();
  const element = document.createElement("div");
  element.id = "chatgpt-save-selection-chat-status";
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 3200);
}

async function activeConversation() {
  if (pending?.tabId == null) return null;
  const sessionId = (await chrome.storage.session.get(ROUTE_SESSION_KEY))[ROUTE_SESSION_KEY];
  let routes;
  try { routes = JSON.parse(localStorage.getItem(ROUTE_STORAGE_KEY) || "null"); }
  catch { return null; }
  if (!routes || routes.sessionId !== sessionId) return null;
  const route = routes.routesByTab?.[String(pending.tabId)];
  const match = typeof route === "string" ? route.match(/^\/local\/([0-9a-f-]{36})$/i) : null;
  return match ? { conversationId: match[1], route, tabId: pending.tabId } : null;
}

async function refreshPending() {
  if (windowId == null) return;
  pending = (await chrome.storage.session.get(pendingKey()))[pendingKey()] || null;
  button.dataset.visible = String(Boolean(pending));
  if (pending) button.title = `Save this conversation for “${pending.selectedText.slice(0, 100)}”`;
}

button.addEventListener("click", async () => {
  if (!pending) return;
  button.disabled = true;
  const label = button.lastElementChild;
  const original = label.textContent;
  label.textContent = "Saving…";
  try {
    let pageReady = false;
    try {
      const response = await chrome.tabs.sendMessage(pending.tabId, {
        type: "CHATGPT_SAVED_CHAT_ANNOTATIONS_READY",
      });
      pageReady = response?.ok === true;
    } catch {
      pageReady = false;
    }
    if (!pageReady) {
      status("Refresh the original webpage, then click Save again.");
      return;
    }
    const conversation = await activeConversation();
    if (!conversation) {
      status("Send a message in this chat first, then save it.");
      return;
    }
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const records = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    const record = {
      ...pending,
      anchor: pending.anchor || { exact: pending.selectedText, prefix: "", suffix: "" },
      conversationId: conversation.conversationId,
      savedAt: Date.now(),
    };
    const next = records.filter((item) => item.id !== record.id && !(
      item.conversationId === record.conversationId
      && item.tabUrl === record.tabUrl
      && item.selectedText === record.selectedText
    ));
    next.push(record);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    await chrome.storage.session.remove(pendingKey());
    pending = null;
    button.dataset.visible = "false";
    status("Chat saved. The selected text is now highlighted on the page.");
  } catch (error) {
    status(`Could not save the chat: ${String(error)}`);
  } finally {
    button.disabled = false;
    label.textContent = original;
  }
});

async function openRequestedConversation(request) {
  const tabId = request.tabId ?? (await chrome.tabs.query({ active: true, windowId }))[0]?.id;
  if (tabId == null) return;
  const sessionId = (await chrome.storage.session.get(ROUTE_SESSION_KEY))[ROUTE_SESSION_KEY];
  let routes;
  try { routes = JSON.parse(localStorage.getItem(ROUTE_STORAGE_KEY) || "null"); }
  catch { routes = null; }
  if (!routes || routes.sessionId !== sessionId) routes = { routesByTab: {}, sessionId };
  routes.routesByTab ||= {};
  routes.routesByTab[String(tabId)] = `/local/${request.conversationId}`;
  routes.recentConversationIds = [
    request.conversationId,
    ...(routes.recentConversationIds || []).filter((id) => id !== request.conversationId),
  ].slice(0, 4);
  localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(routes));
  await chrome.storage.session.remove(openKey());
  location.reload();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || windowId == null) return;
  if (changes[pendingKey()]) refreshPending().catch(() => {});
  const request = changes[openKey()]?.newValue;
  if (request) openRequestedConversation(request).catch(() => {});
});

windowId = (await chrome.windows.getCurrent()).id ?? null;
await refreshPending();
if (windowId != null) {
  const request = (await chrome.storage.session.get(openKey()))[openKey()];
  if (request) await openRequestedConversation(request);
}
