(() => {
  "use strict";

  const STORAGE_KEY = "chatgptSavedTextChatsV1";
  const LAYER_ID = "chatgpt-saved-chat-layer";
  const HIGHLIGHT_NAME = "chatgpt-saved-text-chats";
  const MAX_CONTEXT = 48;
  let lastAnchor = null;
  let rendered = [];
  let renderTimer = null;
  let selectionTimer = null;
  let renderedUrl = "";

  const canonicalUrl = (value = location.href) => {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  };

  const ignored = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !element || element.closest(`#${LAYER_ID}, script, style, noscript, textarea, input, select, option, [contenteditable="true"]`);
  };

  const textNodes = () => {
    const nodes = [];
    if (!document.body) return nodes;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return !ignored(node) && node.data.length
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  };

  const pageTextIndex = () => {
    const nodes = textNodes();
    let text = "";
    const starts = [];
    for (const node of nodes) {
      starts.push(text.length);
      text += node.data;
    }
    return { nodes, starts, text };
  };

  const pointOffset = (node, offset, index) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const position = index.nodes.indexOf(node);
      return position < 0 ? null : index.starts[position] + offset;
    }
    const range = document.createRange();
    range.setStart(document.body, 0);
    try {
      range.setEnd(node, offset);
    } catch {
      return null;
    }
    return range.toString().length;
  };

  const nodePath = (node) => {
    const path = [];
    for (let current = node; current && current !== document.body; current = current.parentNode) {
      const parent = current.parentNode;
      if (!parent) return null;
      const position = [...parent.childNodes].indexOf(current);
      if (position < 0) return null;
      path.push(position);
    }
    return node === document.body || path.length ? path.reverse() : null;
  };

  const nodeAtPath = (path) => {
    if (!Array.isArray(path) || !document.body) return null;
    let node = document.body;
    for (const position of path) {
      if (!Number.isInteger(position) || position < 0) return null;
      node = node.childNodes[position];
      if (!node) return null;
    }
    return node;
  };

  const rangeFromStructuralAnchor = (anchor) => {
    const start = nodeAtPath(anchor?.startPath);
    const end = nodeAtPath(anchor?.endPath);
    if (!start || !end) return null;
    const maxOffset = (node) => node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length;
    if (!Number.isInteger(anchor.startOffset) || !Number.isInteger(anchor.endOffset)) return null;
    if (anchor.startOffset < 0 || anchor.startOffset > maxOffset(start)) return null;
    if (anchor.endOffset < 0 || anchor.endOffset > maxOffset(end)) return null;
    try {
      const range = document.createRange();
      range.setStart(start, anchor.startOffset);
      range.setEnd(end, anchor.endOffset);
      return range.collapsed ? null : range;
    } catch {
      return null;
    }
  };

  const anchorFromSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!document.body?.contains(range.commonAncestorContainer) || ignored(range.commonAncestorContainer)) return null;
    const exact = selection.toString().trim();
    if (!exact) return null;
    const index = pageTextIndex();
    const rawStart = pointOffset(range.startContainer, range.startOffset, index);
    if (rawStart == null) return { exact, prefix: "", suffix: "" };
    const selected = range.toString();
    const trimStart = selected.indexOf(exact);
    const start = rawStart + Math.max(0, trimStart);
    return {
      exact,
      prefix: index.text.slice(Math.max(0, start - MAX_CONTEXT), start),
      suffix: index.text.slice(start + exact.length, start + exact.length + MAX_CONTEXT),
      startPath: nodePath(range.startContainer),
      startOffset: range.startOffset,
      endPath: nodePath(range.endContainer),
      endOffset: range.endOffset,
    };
  };

  const rangeAt = (index, start, length) => {
    const range = document.createRange();
    const end = start + length;
    let startSet = false;
    for (let i = 0; i < index.nodes.length; i += 1) {
      const nodeStart = index.starts[i];
      const nodeEnd = nodeStart + index.nodes[i].data.length;
      if (!startSet && start >= nodeStart && start <= nodeEnd) {
        range.setStart(index.nodes[i], start - nodeStart);
        startSet = true;
      }
      if (startSet && end >= nodeStart && end <= nodeEnd) {
        range.setEnd(index.nodes[i], end - nodeStart);
        return range;
      }
    }
    return null;
  };

  const resolveAnchor = (anchor, fallbackText, index) => {
    const exact = anchor?.exact?.trim() || fallbackText?.trim();
    if (!exact) return null;
    let best = -1;
    let bestScore = -1;
    for (let from = 0; ; ) {
      const at = index.text.indexOf(exact, from);
      if (at < 0) break;
      let score = 0;
      if (anchor?.prefix) {
        const prefix = index.text.slice(Math.max(0, at - anchor.prefix.length), at);
        for (let i = 1; i <= Math.min(prefix.length, anchor.prefix.length); i += 1) {
          if (prefix.at(-i) !== anchor.prefix.at(-i)) break;
          score += 1;
        }
      }
      if (anchor?.suffix) {
        const suffix = index.text.slice(at + exact.length, at + exact.length + anchor.suffix.length);
        for (let i = 0; i < Math.min(suffix.length, anchor.suffix.length); i += 1) {
          if (suffix[i] !== anchor.suffix[i]) break;
          score += 1;
        }
      }
      if (score > bestScore) {
        best = at;
        bestScore = score;
      }
      from = at + Math.max(1, exact.length);
    }
    return best < 0 ? null : rangeAt(index, best, exact.length);
  };

  const ensureLayer = () => {
    let layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = LAYER_ID;
      layer.setAttribute("aria-label", "Saved ChatGPT conversations");
      document.documentElement.append(layer);
    }
    return layer;
  };

  const positionMarker = (item) => {
    const rects = [...item.range.getClientRects()].filter((rect) => rect.width || rect.height);
    const rect = rects.at(-1);
    if (!rect || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      item.marker.hidden = true;
      return;
    }
    item.marker.hidden = false;
    item.marker.style.left = `${Math.min(innerWidth - 29, Math.max(4, rect.right + 5))}px`;
    item.marker.style.top = `${Math.min(innerHeight - 29, Math.max(4, rect.top - 3))}px`;
  };

  const removeAnnotation = async (id) => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const records = (stored[STORAGE_KEY] || []).filter((record) => record.id !== id);
    await chrome.storage.local.set({ [STORAGE_KEY]: records });
  };

  const showPopover = (item) => {
    const layer = ensureLayer();
    layer.querySelector(".chatgpt-saved-chat-popover")?.remove();
    const popover = document.createElement("div");
    popover.className = "chatgpt-saved-chat-popover";
    const quote = document.createElement("blockquote");
    quote.textContent = `“${item.record.selectedText}”`;
    const actions = document.createElement("div");
    actions.className = "chatgpt-saved-chat-popover-actions";
    const open = document.createElement("button");
    open.className = "chatgpt-saved-chat-open";
    open.textContent = "Open saved chat";
    open.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "CHATGPT_OPEN_SAVED_TEXT_CHAT",
        conversationId: item.record.conversationId,
      }).catch(() => {});
      popover.remove();
    });
    const remove = document.createElement("button");
    remove.className = "chatgpt-saved-chat-delete";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeAnnotation(item.record.id));
    actions.append(open, remove);
    popover.append(quote, actions);
    layer.append(popover);
    const markerRect = item.marker.getBoundingClientRect();
    popover.style.left = `${Math.min(innerWidth - popover.offsetWidth - 12, Math.max(12, markerRect.left - popover.offsetWidth + 25))}px`;
    popover.style.top = `${Math.min(innerHeight - popover.offsetHeight - 12, markerRect.bottom + 8)}px`;
  };

  const render = async () => {
    renderTimer = null;
    renderedUrl = canonicalUrl();
    const layer = ensureLayer();
    layer.replaceChildren();
    rendered = [];
    CSS.highlights?.delete(HIGHLIGHT_NAME);
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const records = (stored[STORAGE_KEY] || []).filter((record) => {
      try { return canonicalUrl(record.tabUrl || record.url) === canonicalUrl(); }
      catch { return false; }
    });
    if (!records.length) return;
    const index = pageTextIndex();
    const ranges = [];
    for (const record of records) {
      const range = rangeFromStructuralAnchor(record.anchor)
        || resolveAnchor(record.anchor, record.selectedText, index);
      if (!range) continue;
      const marker = document.createElement("button");
      marker.className = "chatgpt-saved-chat-marker";
      marker.type = "button";
      marker.textContent = "✦";
      marker.title = "Open saved ChatGPT conversation";
      marker.setAttribute("aria-label", `Open saved ChatGPT conversation about: ${record.selectedText.slice(0, 80)}`);
      const item = { marker, range, record };
      marker.addEventListener("click", () => showPopover(item));
      layer.append(marker);
      ranges.push(range);
      rendered.push(item);
    }
    if (CSS.highlights && ranges.length) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
    rendered.forEach(positionMarker);
  };

  const scheduleRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => render().catch(() => {}), 120);
  };

  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const anchor = anchorFromSelection();
      if (anchor) lastAnchor = anchor;
    }, 80);
  });
  document.addEventListener("pointerup", () => {
    const anchor = anchorFromSelection();
    if (anchor) {
      lastAnchor = anchor;
      chrome.runtime.sendMessage({
        type: "CHATGPT_TEXT_SELECTION_ANCHOR_CHANGED",
        anchor,
      }).catch(() => {});
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CHATGPT_SAVED_CHAT_ANNOTATIONS_READY") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "CHATGPT_CAPTURE_TEXT_ANCHOR") return false;
    const current = anchorFromSelection();
    const requested = message.selectedText?.trim();
    const anchor = current?.exact === requested ? current : lastAnchor?.exact === requested ? lastAnchor : null;
    sendResponse({ ok: true, anchor: anchor || { exact: requested, prefix: "", suffix: "" } });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) scheduleRender();
  });
  addEventListener("resize", () => rendered.forEach(positionMarker), { passive: true });
  addEventListener("scroll", () => rendered.forEach(positionMarker), { capture: true, passive: true });
  addEventListener("popstate", scheduleRender);
  addEventListener("hashchange", scheduleRender);
  setInterval(() => {
    if (canonicalUrl() !== renderedUrl) scheduleRender();
  }, 1000);
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => !document.getElementById(LAYER_ID)?.contains(mutation.target))) scheduleRender();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  render().catch(() => {});
})();
