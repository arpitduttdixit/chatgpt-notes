(() => {
  "use strict";

  const ASK_MENU_ID = "ask-chatgpt";
  const PENDING_PREFIX = "chatgptSavedChatPending:";
  const OPEN_PREFIX = "chatgptSavedChatOpen:";

  const pendingKey = (windowId) => `${PENDING_PREFIX}${windowId}`;
  const openKey = (windowId) => `${OPEN_PREFIX}${windowId}`;

  const captureAnchor = async (tabId, selectedText) => {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "CHATGPT_CAPTURE_TEXT_ANCHOR",
        selectedText,
      });
      return response?.ok ? response.anchor : null;
    } catch {
      return null;
    }
  };

  const savePendingSelection = async ({ anchor = null, selectedText, tab, url }) => {
    if (!selectedText?.trim() || tab?.id == null || tab.windowId == null || !tab.url) return;
    const pending = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      pageTitle: tab.title || "",
      selectedText: selectedText.trim(),
      tabId: tab.id,
      tabUrl: tab.url,
      url: url || tab.url,
      anchor,
    };
    await chrome.storage.session.set({ [pendingKey(tab.windowId)]: pending });
  };

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== ASK_MENU_ID || !info.selectionText?.trim()) return;
    if (tab?.id == null || tab.windowId == null || !tab.url) return;

    const anchor = await captureAnchor(tab.id, info.selectionText);

    await savePendingSelection({
      anchor,
      selectedText: info.selectionText,
      tab,
      url: info.frameUrl || info.pageUrl || tab.url,
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "CHATGPT_TEXT_SELECTION_ANCHOR_CHANGED") {
      savePendingSelection({
        anchor: message.anchor,
        selectedText: message.anchor?.exact,
        tab: sender.tab,
      }).then(() => sendResponse({ ok: true })).catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });
      return true;
    }

    // The built-in side-panel selection observer emits this while the panel is open.
    // Retaining it makes the normal "Explain this" workflow saveable too.
    if (message?.type === "CODEX_PAGE_SELECTION_CHANGED" && message.selectedText?.trim()) {
      (async () => {
        const anchor = sender.tab?.id == null
          ? null
          : await captureAnchor(sender.tab.id, message.selectedText);
        await savePendingSelection({
          anchor,
          selectedText: message.selectedText,
          tab: sender.tab,
        });
        sendResponse({ ok: true });
      })().catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type !== "CHATGPT_OPEN_SAVED_TEXT_CHAT") return false;

    (async () => {
      const windowId = sender.tab?.windowId ?? (await chrome.windows.getCurrent()).id;
      if (windowId == null || typeof message.conversationId !== "string") {
        sendResponse({ ok: false });
        return;
      }
      // Call open while the marker click's user gesture is still active.
      const opening = chrome.sidePanel.open({ windowId });
      await chrome.storage.session.set({
        [openKey(windowId)]: {
          conversationId: message.conversationId,
          tabId: sender.tab?.id ?? message.tabId ?? null,
          requestedAt: Date.now(),
        },
      });
      await opening;
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  });
})();
