(() => {
  "use strict";

  const STORAGE_KEY = "chatgptSavedTextChatsV1";
  const LAYER_ID = "chatgpt-saved-chat-layer";
  const HIGHLIGHT_NAME = "chatgpt-saved-text-chats";
  const INACTIVE_HIGHLIGHT_NAME = "chatgpt-saved-text-chats-inactive";
  const ACTIVE_HIGHLIGHT_NAME = "chatgpt-saved-text-chat-active";
  const MAX_CONTEXT = 48;
  const MARKER_SIZE = 25;
  const GROUP_DISTANCE = 18;
  let lastAnchor = null;
  let rendered = [];
  let markerGroups = [];
  let activeItems = [];
  let openPopover = null;
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

  const rangeRects = (item) => [...item.range.getClientRects()].filter((rect) => rect.width || rect.height);

  const endpointPlacement = (item) => {
    const rect = rangeRects(item).at(-1);
    if (!rect) return null;
    return { left: rect.right + 5, rect, top: rect.top - 3 };
  };

  const isMarkerPlacementVisible = ({ left, rect, top }, markerWidth = MARKER_SIZE) => rect.top >= 0
    && rect.bottom <= innerHeight
    && rect.left >= 0
    && rect.right <= innerWidth
    && left >= 0
    && top >= 0
    && left + markerWidth <= innerWidth
    && top + MARKER_SIZE <= innerHeight;

  const positionStartCap = (item) => {
    const rects = [...item.range.getClientRects()].filter((rect) => rect.width || rect.height);
    const rect = rects[0];
    if (!rect) {
      item.startCap.hidden = true;
      return;
    }
    const left = rect.left - 4;
    const isFullyVisible = rect.top >= 0
      && rect.bottom <= innerHeight
      && rect.left >= 0
      && rect.right <= innerWidth
      && left >= 0
      && left + 3 <= innerWidth;
    item.startCap.hidden = !isFullyVisible;
    if (!isFullyVisible) return;
    item.startCap.style.height = `${Math.max(12, Math.min(24, rect.height))}px`;
    item.startCap.style.left = `${left}px`;
    item.startCap.style.top = `${rect.top}px`;
  };

  const clearActiveItems = () => {
    activeItems = [];
    CSS.highlights?.delete(ACTIVE_HIGHLIGHT_NAME);
    CSS.highlights?.delete(INACTIVE_HIGHLIGHT_NAME);
    if (CSS.highlights && rendered.length) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...rendered.map((item) => item.range)));
    }
    for (const item of rendered) item.startCap.dataset.active = "false";
    for (const group of markerGroups) group.marker.dataset.active = "false";
  };

  const activateItems = (items) => {
    activeItems = items;
    if (CSS.highlights && items.length) {
      const activeSet = new Set(items);
      const inactiveRanges = rendered
        .filter((item) => !activeSet.has(item))
        .map((item) => item.range);
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.delete(INACTIVE_HIGHLIGHT_NAME);
      CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
      if (inactiveRanges.length) {
        CSS.highlights.set(INACTIVE_HIGHLIGHT_NAME, new Highlight(...inactiveRanges));
      }
      CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, new Highlight(...items.map((item) => item.range)));
    }
    const activeSet = new Set(items);
    for (const item of rendered) item.startCap.dataset.active = String(activeSet.has(item));
    for (const group of markerGroups) {
      group.marker.dataset.active = String(group.items.some((item) => activeSet.has(item)));
    }
  };

  const closePopover = () => {
    openPopover?.remove();
    openPopover = null;
    clearActiveItems();
  };

  const removeAnnotation = async (id) => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const records = (stored[STORAGE_KEY] || []).filter((record) => record.id !== id);
    await chrome.storage.local.set({ [STORAGE_KEY]: records });
  };

  const openConversation = (item) => {
    chrome.runtime.sendMessage({
      type: "CHATGPT_OPEN_SAVED_TEXT_CHAT",
      conversationId: item.record.conversationId,
    }).catch(() => {});
    closePopover();
  };

  const excerpt = (text, length = 110) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1)}…`;
  };

  const showPopover = (group) => {
    const layer = ensureLayer();
    closePopover();
    const popover = document.createElement("div");
    popover.className = "chatgpt-saved-chat-popover";
    openPopover = popover;

    if (group.items.length === 1) {
      const [item] = group.items;
      const quote = document.createElement("blockquote");
      quote.textContent = `“${item.record.selectedText}”`;
      const actions = document.createElement("div");
      actions.className = "chatgpt-saved-chat-popover-actions";
      const open = document.createElement("button");
      open.className = "chatgpt-saved-chat-open";
      open.textContent = "Open saved chat";
      open.addEventListener("click", () => openConversation(item));
      const remove = document.createElement("button");
      remove.className = "chatgpt-saved-chat-delete";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        closePopover();
        await removeAnnotation(item.record.id);
      });
      actions.append(open, remove);
      popover.append(quote, actions);
      activateItems([item]);
    } else {
      const heading = document.createElement("div");
      heading.className = "chatgpt-saved-chat-popover-heading";
      heading.textContent = `${group.items.length} saved chats here`;
      const list = document.createElement("div");
      list.className = "chatgpt-saved-chat-popover-list";
      for (const item of group.items) {
        const row = document.createElement("div");
        row.className = "chatgpt-saved-chat-popover-row";
        const choice = document.createElement("button");
        choice.className = "chatgpt-saved-chat-choice";
        choice.textContent = excerpt(item.record.selectedText);
        choice.title = item.record.selectedText;
        choice.addEventListener("pointerenter", () => activateItems([item]));
        choice.addEventListener("focus", () => activateItems([item]));
        choice.addEventListener("click", () => openConversation(item));
        const remove = document.createElement("button");
        remove.className = "chatgpt-saved-chat-row-delete";
        remove.textContent = "×";
        remove.title = "Remove this saved chat";
        remove.setAttribute("aria-label", `Remove saved chat about: ${excerpt(item.record.selectedText, 70)}`);
        remove.addEventListener("pointerenter", () => activateItems([item]));
        remove.addEventListener("focus", () => activateItems([item]));
        remove.addEventListener("click", async () => {
          closePopover();
          await removeAnnotation(item.record.id);
        });
        row.append(choice, remove);
        list.append(row);
      }
      list.addEventListener("pointerleave", () => activateItems(group.items));
      popover.append(heading, list);
      activateItems(group.items);
    }

    layer.append(popover);
    const markerRect = group.marker.getBoundingClientRect();
    popover.style.left = `${Math.min(innerWidth - popover.offsetWidth - 12, Math.max(12, markerRect.left - popover.offsetWidth + 25))}px`;
    popover.style.top = `${Math.min(innerHeight - popover.offsetHeight - 12, markerRect.bottom + 8)}px`;
  };

  const makeMarkerGroup = (items) => {
    const marker = document.createElement("button");
    marker.className = "chatgpt-saved-chat-marker";
    marker.type = "button";
    marker.textContent = items.length > 1 ? `✦${items.length}` : "✦";
    marker.dataset.count = String(items.length);
    marker.title = items.length > 1
      ? `${items.length} saved ChatGPT conversations here`
      : "Open saved ChatGPT conversation";
    marker.setAttribute("aria-label", marker.title);
    const group = { items, marker };
    marker.addEventListener("pointerenter", () => activateItems(items));
    marker.addEventListener("pointerleave", () => {
      if (!openPopover) clearActiveItems();
    });
    marker.addEventListener("focus", () => activateItems(items));
    marker.addEventListener("blur", () => {
      if (!openPopover) clearActiveItems();
    });
    marker.addEventListener("click", () => showPopover(group));
    ensureLayer().append(marker);
    return group;
  };

  const groupMarkers = (items) => {
    const remaining = items.map((item) => ({ item, placement: endpointPlacement(item) }));
    const groups = [];
    while (remaining.length) {
      const seed = remaining.shift();
      if (!seed.placement) continue;
      const members = [seed.item];
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const candidate = remaining[i];
        if (!candidate.placement) continue;
        const nearX = Math.abs(candidate.placement.left - seed.placement.left) <= GROUP_DISTANCE;
        const nearY = Math.abs(candidate.placement.top - seed.placement.top) <= GROUP_DISTANCE;
        if (nearX && nearY) {
          members.push(candidate.item);
          remaining.splice(i, 1);
        }
      }
      groups.push(makeMarkerGroup(members));
    }
    return groups;
  };

  const positionDecorations = () => {
    for (const item of rendered) positionStartCap(item);
    for (const group of markerGroups) {
      const placements = group.items.map(endpointPlacement).filter(Boolean);
      const placement = placements.find((candidate) => isMarkerPlacementVisible(
        candidate,
        group.items.length > 1 ? 32 : MARKER_SIZE,
      ));
      group.marker.hidden = placement == null;
      if (!placement) continue;
      group.marker.style.left = `${placement.left}px`;
      group.marker.style.top = `${placement.top}px`;
    }
  };

  const render = async () => {
    renderTimer = null;
    renderedUrl = canonicalUrl();
    const layer = ensureLayer();
    closePopover();
    layer.replaceChildren();
    rendered = [];
    markerGroups = [];
    CSS.highlights?.delete(HIGHLIGHT_NAME);
    CSS.highlights?.delete(INACTIVE_HIGHLIGHT_NAME);
    CSS.highlights?.delete(ACTIVE_HIGHLIGHT_NAME);
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
      const startCap = document.createElement("span");
      startCap.className = "chatgpt-saved-chat-start-cap";
      startCap.setAttribute("aria-hidden", "true");
      const item = { range, record, startCap };
      layer.append(startCap);
      ranges.push(range);
      rendered.push(item);
    }
    if (CSS.highlights && ranges.length) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
    markerGroups = groupMarkers(rendered);
    positionDecorations();
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
  addEventListener("resize", scheduleRender, { passive: true });
  addEventListener("scroll", () => {
    if (openPopover) closePopover();
    positionDecorations();
  }, { capture: true, passive: true });
  document.addEventListener("pointerdown", (event) => {
    if (openPopover && !openPopover.contains(event.target)
      && !event.target.closest?.(".chatgpt-saved-chat-marker")) closePopover();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openPopover) closePopover();
  }, true);
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
