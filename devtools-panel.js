(function () {
  "use strict";

  const STORAGE_KEY = "embedded-devtools-mocks";
  const DB_NAME = "embedded-devtools";
  const DB_VERSION = 1;
  const STORE_NAME = "settings";
  const MOCKS_RECORD_KEY = "mocks";
  const SNAPSHOTS_RECORD_KEY = "snapshots";
  const ACTIVE_SNAPSHOT_ID_KEY = "active_snapshot_id";
  const MAX_REQUESTS = 200;
  const state = {
    installed: false,
    expanded: false,
    selectedId: null,
    selectedMockId: null,
    savedMockId: null,
    contextMenu: null,
    persistenceReady: false,
    persistenceError: "",
    serviceWorkerReady: false,
    serviceWorkerRegistration: null,
    useServiceWorker: false,
    requests: [],
    mocks: [],
    requestSort: "newest",
    requestSearch: "",
    collapsedSections: new Set(["Request headers", "Request body", "Response headers", "Mock Headers"]),
    floatButtonTucked: false,
    requestSearchStatus: "",
    mockEnabled: safeLocalStorageGet("embedded-devtools-mock-enabled") !== "false",
    selectedMockGroupTab: "all",
    lastGroupKey: null,
    activeRightTab: "mocks",
    snapshots: [],
    activeSnapshotId: null,
    selectedSnapshotId: null,
    playbackIndices: {},
    snapshotSelectionMode: false,
    selectedSnapshotRequestIds: new Set(),
    mockGroupSelectionMode: false,
    selectedMockGroupKeys: new Set(),
    snapshotListSelectionMode: false,
    selectedSnapshotIds: new Set(),
    subscribers: new Set(),
    originalFetch: null,
    OriginalXHR: null,
    showSettingsModal: false,
    detailsLayout: safeLocalStorageGet("embedded-devtools-details-layout") || "sidebar",
    storageUsage: null,
    editingSnapshotId: null,
    editingSnapshotDraft: null,
    buttonPosition: null,
    savedSnapshotId: null
  };

  function init(options = {}) {
    if (state.installed) return api;
    const initOptions = options && typeof options === "object" ? options : {};
    try {
      state.originalFetch = window.fetch ? window.fetch.bind(window) : null;
      state.OriginalXHR = window.XMLHttpRequest;
      state.useServiceWorker = initOptions.useServiceWorker !== false && canUseServiceWorker();
      state.mocks = enforceSingleActivePerEndpoint(normalizeMocks(initOptions.seedMocks || []));
      state.selectedMockId = null;
      state.buttonPosition = initOptions.buttonPosition || initOptions.floatButtonPosition || null;
      mountPanel();
      installFetchInterceptor();
      installXhrInterceptor();
      state.installed = true;
      hydrateMocks(initOptions.seedMocks || []);
      updateStorageEstimate();
      setupServiceWorker();
    } catch (error) {
      state.installed = false;
      state.persistenceError = error.message || "MockTools initialization failed";
      throw error;
    }
    return api;
  }

  async function updateStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const usage = estimate.usage || 0;
        const quota = estimate.quota || 1;
        state.storageUsage = {
          usage: (usage / (1024 * 1024)).toFixed(2),
          quota: (quota / (1024 * 1024)).toFixed(2),
          remaining: ((quota - usage) / (1024 * 1024)).toFixed(2),
          percent: ((1 - (usage / quota)) * 100).toFixed(1)
        };
      } catch (_e) {
        state.storageUsage = null;
      }
    } else {
      state.storageUsage = null;
    }
  }

  async function hydrateMocks(seedMocks) {
    const persistedMocks = await readPersistedMocks();
    const mocks = persistedMocks.length ? persistedMocks : normalizeMocks(seedMocks);
    state.mocks = enforceSingleActivePerEndpoint(mocks);
    state.selectedMockId = null;

    const persistedSnapshots = await readPersistedSnapshots();
    state.snapshots = persistedSnapshots || [];
    state.activeSnapshotId = await readActiveSnapshotId();
    
    if (state.activeSnapshotId) {
      state.activeRightTab = "snapshots";
      state.selectedSnapshotId = state.activeSnapshotId;
    } else {
      state.selectedSnapshotId = state.snapshots[0]?.id || null;
    }
    startEditingSnapshot(state.selectedSnapshotId);

    state.persistenceReady = true;
    if (state.mocks.length) persistMocks(state.mocks);
    syncServiceWorkerMocks();
    syncServiceWorkerSnapshot();
    notify();
  }

  function normalizeMocks(mocks) {
    return Array.isArray(mocks) ? mocks.map((mock, index) => normalizeMock(mock, index)) : [];
  }

  function normalizeMock(mock, index) {
    mock = mock && typeof mock === "object" ? mock : {};
    return {
      id: mock.id || `mock-${Date.now()}-${index}`,
      name: mock.name || "",
      aliasName: mock.aliasName || "",
      enabled: mock.enabled !== false,
      method: (mock.method || "GET").toUpperCase(),
      pattern: mock.pattern || mock.url || "",
      status: Number(mock.status || 200),
      delay: Number(mock.delay || 0),
      headers: mock.headers || { "content-type": "application/json" },
      body: typeof mock.body === "string" ? mock.body : JSON.stringify(mock.body || {}, null, 2),
      group: mock.group || ""
    };
  }

  function saveMocks(mocks = state.mocks, options = {}) {
    persistMocks(mocks);
    syncServiceWorkerMocks();
    if (!options.silent) notify();
  }

  function canUseServiceWorker() {
    return Boolean(
      window.isSecureContext &&
        "serviceWorker" in navigator &&
        ["http:", "https:"].includes(window.location.protocol)
    );
  }

  async function setupServiceWorker() {
    if (!state.useServiceWorker) return;
    try {
      const registration = await navigator.serviceWorker.register("./mocktools-sw.js");
      state.serviceWorkerRegistration = registration;
      await navigator.serviceWorker.ready;
      state.serviceWorkerReady = Boolean(navigator.serviceWorker.controller);
      syncServiceWorkerMocks();
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        state.serviceWorkerReady = true;
        syncServiceWorkerMocks();
        notify();
      });
      notify();
    } catch (error) {
      state.serviceWorkerReady = false;
      state.useServiceWorker = false;
      state.persistenceError = error.message || "Service Worker unavailable";
      notify();
    }
  }

  function syncServiceWorkerMocks() {
    if (!state.useServiceWorker) return;
    const worker =
      navigator.serviceWorker.controller ||
      state.serviceWorkerRegistration?.active ||
      state.serviceWorkerRegistration?.waiting ||
      state.serviceWorkerRegistration?.installing;
    worker?.postMessage({
      type: "MOCKTOOLS_UPDATE_MOCKS",
      mocks: state.mockEnabled ? state.mocks : []
    });
  }

  function syncServiceWorkerSnapshot() {
    if (!state.useServiceWorker) return;
    const worker =
      navigator.serviceWorker.controller ||
      state.serviceWorkerRegistration?.active ||
      state.serviceWorkerRegistration?.waiting ||
      state.serviceWorkerRegistration?.installing;
    const activeSnap = state.snapshots.find(s => s.id === state.activeSnapshotId);
    worker?.postMessage({
      type: "MOCKTOOLS_UPDATE_SNAPSHOT",
      activeSnapshotRules: activeSnap ? activeSnap.rules : null
    });
  }

  async function readPersistedMocks() {
    try {
      const record = await readFromIndexedDb(MOCKS_RECORD_KEY);
      if (Array.isArray(record?.value)) return normalizeMocks(record.value);
      const legacyMocks = readLegacyLocalStorageMocks();
      if (legacyMocks.length) {
        await writeToIndexedDb(MOCKS_RECORD_KEY, legacyMocks);
        safeLocalStorageRemove(STORAGE_KEY);
        return legacyMocks;
      }
    } catch (error) {
      state.persistenceError = error.message || "IndexedDB unavailable";
      const legacyMocks = readLegacyLocalStorageMocks();
      if (legacyMocks.length) return legacyMocks;
    }
    return [];
  }

  async function persistMocks(mocks) {
    try {
      await writeToIndexedDb(MOCKS_RECORD_KEY, mocks);
      state.persistenceError = "";
    } catch (error) {
      state.persistenceError = error.message || "IndexedDB unavailable";
      try {
        safeLocalStorageSet(STORAGE_KEY, JSON.stringify(mocks));
      } catch (_fallbackError) {
        // If both persistent stores fail, keep the in-memory state alive for this session.
      }
    }
  }

  async function readPersistedSnapshots() {
    try {
      const record = await readFromIndexedDb(SNAPSHOTS_RECORD_KEY);
      if (Array.isArray(record?.value)) return record.value;
    } catch (error) {
      state.persistenceError = error.message || "IndexedDB unavailable";
    }
    try {
      const saved = safeJsonParse(safeLocalStorageGet("embedded-devtools-snapshots"), null);
      return Array.isArray(saved) ? saved : [];
    } catch (_error) {
      return [];
    }
  }

  async function persistSnapshots(snapshots) {
    try {
      await writeToIndexedDb(SNAPSHOTS_RECORD_KEY, snapshots);
    } catch (error) {
      state.persistenceError = error.message || "IndexedDB unavailable";
      try {
        safeLocalStorageSet("embedded-devtools-snapshots", JSON.stringify(snapshots));
      } catch (_fallbackError) {}
    }
  }

  async function readActiveSnapshotId() {
    try {
      const record = await readFromIndexedDb(ACTIVE_SNAPSHOT_ID_KEY);
      return record ? record.value : null;
    } catch (error) {
      state.persistenceError = error.message || "IndexedDB unavailable";
    }
    try {
      return safeLocalStorageGet("embedded-devtools-active-snapshot-id") || null;
    } catch (_error) {
      return null;
    }
  }

  async function persistActiveSnapshotId(id) {
    try {
      await writeToIndexedDb(ACTIVE_SNAPSHOT_ID_KEY, id);
    } catch (error) {
      state.persistenceError = error.message || "IndexedDB unavailable";
      try {
        if (id) {
          safeLocalStorageSet("embedded-devtools-active-snapshot-id", id);
        } else {
          safeLocalStorageRemove("embedded-devtools-active-snapshot-id");
        }
      } catch (_fallbackError) {}
    }
  }

  function safeLocalStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {}
  }

  function safeLocalStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {}
  }

  function readLegacyLocalStorageMocks() {
    try {
      const saved = safeJsonParse(safeLocalStorageGet(STORAGE_KEY), null);
      return Array.isArray(saved) ? normalizeMocks(saved) : [];
    } catch (_error) {
      return [];
    }
  }

  function openMockDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
    });
  }

  async function readFromIndexedDb(key) {
    const db = await openMockDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Failed to read IndexedDB"));
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("IndexedDB read transaction failed"));
      };
    });
  }

  async function writeToIndexedDb(key, value) {
    const db = await openMockDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.put({ value, updatedAt: new Date().toISOString() }, key);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("IndexedDB write transaction failed"));
      };
    });
  }

  function installFetchInterceptor() {
    if (!state.originalFetch) return;
    window.fetch = async function interceptedFetch(input, initOptions = {}) {
      const startedAt = performance.now();
      const request = createFetchRecord(input, initOptions);
      const snapshotMock = findSnapshotResponse(request.method, request.url);
      addRequest(request);

      if (snapshotMock && !shouldLetServiceWorkerMock()) {
        await wait(snapshotMock.delay);
        const response = new Response(snapshotMock.body, {
          status: snapshotMock.status,
          headers: snapshotMock.headers
        });
        finishRequest(request.id, {
          status: snapshotMock.status,
          duration: performance.now() - startedAt,
          responseHeaders: objectFromHeaders(response.headers),
          responseText: snapshotMock.body,
          mocked: true,
          snapshotted: true,
          mockId: snapshotMock.id
        });
        return response;
      }

      const mock = findMock(request.method, request.url);
      if (mock && !shouldLetServiceWorkerMock()) {
        await wait(mock.delay);
        const response = new Response(mock.body, {
          status: mock.status,
          headers: mock.headers
        });
        finishRequest(request.id, {
          status: mock.status,
          duration: performance.now() - startedAt,
          responseHeaders: objectFromHeaders(response.headers),
          responseText: mock.body,
          mocked: true,
          mockId: mock.id
        });
        return response;
      }

      try {
        const response = await state.originalFetch(input, initOptions);
        const cloned = response.clone();
        const responseText = await readResponseText(cloned);
        const mocked = response.headers.get("x-mocktools-mocked") === "1";
        const snapshotted = response.headers.get("x-mocktools-snapshotted") === "1";
        finishRequest(request.id, {
          status: response.status,
          duration: performance.now() - startedAt,
          responseHeaders: objectFromHeaders(response.headers),
          responseText,
          mocked,
          snapshotted,
          mockId: response.headers.get("x-mocktools-mock-id") || ""
        });
        return response;
      } catch (error) {
        finishRequest(request.id, {
          error: error.message,
          duration: performance.now() - startedAt
        });
        throw error;
      }
    };
  }

  function createFetchRecord(input, initOptions) {
    const requestLike = input instanceof Request ? input : null;
    return {
      id: createId(),
      type: "fetch",
      method: (initOptions.method || requestLike?.method || "GET").toUpperCase(),
      url: requestLike?.url || String(input),
      status: "pending",
      startedAt: new Date().toISOString(),
      duration: 0,
      requestHeaders: headersToObject(initOptions.headers || requestLike?.headers),
      requestBody: stringifyBody(initOptions.body),
      responseHeaders: {},
      responseText: "",
      mocked: false,
      error: ""
    };
  }

  function installXhrInterceptor() {
    if (!state.OriginalXHR) return;
    const OriginalXHR = state.OriginalXHR;
    window.XMLHttpRequest = function InterceptedXMLHttpRequest() {
      const xhr = new OriginalXHR();
      const meta = {
        id: createId(),
        type: "xhr",
        method: "GET",
        url: "",
        requestHeaders: {},
        requestBody: "",
        startedAt: "",
        startTime: 0
      };

      const originalOpen = xhr.open;
      const originalSend = xhr.send;
      const originalSetRequestHeader = xhr.setRequestHeader;

      xhr.open = function open(method, url) {
        meta.method = String(method || "GET").toUpperCase();
        meta.url = String(url || "");
        return originalOpen.apply(xhr, arguments);
      };

      xhr.setRequestHeader = function setRequestHeader(name, value) {
        meta.requestHeaders[name] = value;
        return originalSetRequestHeader.apply(xhr, arguments);
      };

      xhr.send = function send(body) {
        meta.requestBody = stringifyBody(body);
        meta.startedAt = new Date().toISOString();
        meta.startTime = performance.now();
        const record = {
          id: meta.id,
          type: "xhr",
          method: meta.method,
          url: meta.url,
          status: "pending",
          startedAt: meta.startedAt,
          duration: 0,
          requestHeaders: meta.requestHeaders,
          requestBody: meta.requestBody,
          responseHeaders: {},
          responseText: "",
          mocked: false,
          error: ""
        };
        const snapshotMock = findSnapshotResponse(meta.method, meta.url);
        addRequest(record);

        if (snapshotMock && !shouldLetServiceWorkerMock()) {
          respondWithMockXhr(xhr, record.id, snapshotMock, meta.startTime);
          return undefined;
        }

        const mock = findMock(meta.method, meta.url);
        if (mock && !shouldLetServiceWorkerMock()) {
          respondWithMockXhr(xhr, record.id, mock, meta.startTime);
          return undefined;
        }

        xhr.addEventListener("loadend", () => {
          finishRequest(meta.id, {
            status: xhr.status || 0,
            duration: performance.now() - meta.startTime,
            responseHeaders: parseRawHeaders(xhr.getAllResponseHeaders()),
            responseText: String(xhr.responseText || ""),
            mocked: xhr.getResponseHeader("x-mocktools-mocked") === "1",
            snapshotted: xhr.getResponseHeader("x-mocktools-snapshotted") === "1",
            mockId: xhr.getResponseHeader("x-mocktools-mock-id") || ""
          });
        });
        xhr.addEventListener("error", () => {
          finishRequest(meta.id, {
            error: "XHR network error",
            duration: performance.now() - meta.startTime
          });
        });
        return originalSend.apply(xhr, arguments);
      };

      return xhr;
    };
  }

  function respondWithMockXhr(xhr, requestId, mock, startTime) {
    wait(mock.delay).then(() => {
      defineReadonly(xhr, "readyState", 4);
      defineReadonly(xhr, "status", mock.status);
      defineReadonly(xhr, "statusText", statusText(mock.status));
      defineReadonly(xhr, "response", mock.body);
      defineReadonly(xhr, "responseText", mock.body);
      xhr.getAllResponseHeaders = () =>
        Object.entries(mock.headers || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n");
      finishRequest(requestId, {
        status: mock.status,
        duration: performance.now() - startTime,
        responseHeaders: mock.headers || {},
        responseText: mock.body,
        mocked: true,
        mockId: mock.id,
        snapshotted: !!mock.snapshotted
      });
      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new Event("load"));
      xhr.dispatchEvent(new Event("loadend"));
    });
  }

  function defineReadonly(target, key, value) {
    try {
      Object.defineProperty(target, key, { configurable: true, value });
    } catch (_error) {
      target[key] = value;
    }
  }

  function addRequest(request) {
    state.requests.unshift(request);
    state.requests = state.requests.slice(0, MAX_REQUESTS);
    state.selectedId = request.id;
    notify();
  }

  function finishRequest(id, patch) {
    state.requests = state.requests.map((request) =>
      request.id === id ? { ...request, ...patch } : request
    );
    notify();
  }

  function findSnapshotResponse(method, url) {
    if (!state.activeSnapshotId) return null;
    const activeSnap = state.snapshots.find((s) => s.id === state.activeSnapshotId);
    if (!activeSnap) return null;

    const rule = activeSnap.rules.find((r) => {
      const methodMatches = r.method === "ALL" || r.method === String(method || "GET").toUpperCase();
      return methodMatches && patternMatches(r.pattern, url);
    });
    if (!rule || !rule.responses || rule.responses.length === 0) return null;

    if (state.playbackIndices[rule.id] === undefined) {
      state.playbackIndices[rule.id] = 0;
    }
    const idx = state.playbackIndices[rule.id];
    let response = null;

    if (idx < rule.responses.length) {
      response = rule.responses[idx];
      state.playbackIndices[rule.id] = idx + 1;
    } else {
      const overflow = rule.overflow || "repeat-last";
      if (overflow === "repeat-last") {
        response = rule.responses[rule.responses.length - 1];
      } else if (overflow === "loop") {
        state.playbackIndices[rule.id] = 1;
        response = rule.responses[0];
      } else {
        return null; // bypass to normal mocks or network
      }
    }

    return {
      status: Number(response.status || 200),
      delay: Number(response.delay || 0),
      headers: response.headers || { "content-type": "application/json" },
      body: response.body || "",
      id: rule.id,
      mocked: true,
      snapshotted: true
    };
  }

  function findMock(method, url) {
    if (!state.mockEnabled) return null;
    return state.mocks.find((mock) => {
      if (!mock.enabled) return false;
      const methodMatches = mock.method === "ALL" || mock.method === method.toUpperCase();
      return methodMatches && patternMatches(mock.pattern, url);
    });
  }

  function shouldLetServiceWorkerMock() {
    return state.useServiceWorker && state.serviceWorkerReady;
  }

  function patternMatches(pattern, url) {
    if (!pattern) return false;
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      try {
        return new RegExp(pattern.slice(1, -1)).test(url);
      } catch (_error) {
        return url.includes(pattern);
      }
    }
    return url.includes(pattern);
  }

  function isLeftAligned(floatBtn) {
    const pos = state.buttonPosition;
    if (typeof pos === "string") {
      return pos.includes("left");
    }
    if (pos && typeof pos === "object") {
      if (pos.left !== undefined && pos.right === undefined) return true;
      if (pos.right !== undefined && pos.left === undefined) return false;
      if (pos.left !== undefined && pos.right !== undefined) {
        const leftVal = parseFloat(pos.left);
        const rightVal = parseFloat(pos.right);
        return leftVal < rightVal;
      }
    }
    if (floatBtn) {
      const rect = floatBtn.getBoundingClientRect();
      const viewWidth = document.documentElement.clientWidth;
      return (rect.left + rect.width / 2) < viewWidth / 2;
    }
    return false;
  }

  function getVerticalPosition(floatBtn) {
    const pos = state.buttonPosition;
    let topVal = "auto";
    let bottomVal = "auto";

    if (pos) {
      if (typeof pos === "string") {
        if (pos.startsWith("top")) {
          topVal = "24px";
        } else {
          bottomVal = "150px";
        }
      } else if (typeof pos === "object") {
        if (pos.top !== undefined) topVal = pos.top;
        if (pos.bottom !== undefined) bottomVal = pos.bottom;
      }
    } else {
      bottomVal = "150px";
    }

    return { top: topVal, bottom: bottomVal };
  }

  function applyUntuckedPosition(floatBtn) {
    const pos = state.buttonPosition;
    if (!pos) return;

    if (typeof pos === "string") {
      if (pos === "bottom-left") {
        floatBtn.style.left = "24px";
        floatBtn.style.right = "auto";
        floatBtn.style.bottom = "150px";
        floatBtn.style.top = "auto";
      } else if (pos === "bottom-right") {
        floatBtn.style.left = "auto";
        floatBtn.style.right = "24px";
        floatBtn.style.bottom = "150px";
        floatBtn.style.top = "auto";
      } else if (pos === "top-left") {
        floatBtn.style.left = "24px";
        floatBtn.style.right = "auto";
        floatBtn.style.bottom = "auto";
        floatBtn.style.top = "24px";
      } else if (pos === "top-right") {
        floatBtn.style.left = "auto";
        floatBtn.style.right = "24px";
        floatBtn.style.bottom = "auto";
        floatBtn.style.top = "24px";
      }
    } else if (typeof pos === "object") {
      floatBtn.style.left = pos.left !== undefined ? pos.left : "auto";
      floatBtn.style.right = pos.right !== undefined ? pos.right : "auto";
      floatBtn.style.top = pos.top !== undefined ? pos.top : "auto";
      floatBtn.style.bottom = pos.bottom !== undefined ? pos.bottom : "auto";
    }
  }

  function mountPanel() {
    const host = document.createElement("div");
    host.id = "embedded-devtools-host";
    const shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);

    const style = document.createElement("style");
    style.textContent = panelCss();
    const root = document.createElement("div");
    shadow.append(style, root);

    // Create elements once
    let floatBtn = root.querySelector(".float-button");
    let devtools = root.querySelector(".devtools");

    if (!floatBtn || !devtools) {
      root.innerHTML = `
        <button class="float-button" type="button" title="Open Network Mock panel"></button>
        <section class="devtools"></section>
      `;
      floatBtn = root.querySelector(".float-button");
      devtools = root.querySelector(".devtools");
    }

    const render = () => {
      const activeElement = shadow.activeElement;
      const focusedSelector = activeElement && (
        activeElement.hasAttribute("data-search-input") ? "[data-search-input]" :
        activeElement.hasAttribute("data-status-filter") ? "[data-status-filter]" :
        activeElement.hasAttribute("data-group-field") ? `[data-group-field="${activeElement.getAttribute("data-group-field")}"][data-group-key="${cssEscape(activeElement.getAttribute("data-group-key"))}"]` : null
      );
      const selectionStart = focusedSelector && activeElement.selectionStart !== undefined ? activeElement.selectionStart : null;
      const selectionEnd = focusedSelector && activeElement.selectionEnd !== undefined ? activeElement.selectionEnd : null;

      // Save scroll positions
      const selectedMock = state.mocks.find((mock) => mock.id === state.selectedMockId) || null;
      const currentGroupKey = selectedMock ? `${selectedMock.method}::${selectedMock.pattern}` : null;
      const isNewGroup = currentGroupKey !== state.lastGroupKey;
      state.lastGroupKey = currentGroupKey;

      const scrollPositions = {};
      root.querySelectorAll(".mock-detail, .request-items, .mock-list").forEach((el) => {
        if (el.classList.contains("mock-detail")) {
          scrollPositions[".mock-detail"] = isNewGroup ? 0 : el.scrollTop;
        } else if (el.classList.contains("request-items")) {
          scrollPositions[".request-items"] = el.scrollTop;
        } else if (el.classList.contains("mock-list")) {
          scrollPositions[".mock-list"] = el.scrollTop;
        }
      });

      // Update Float Button
      const activeMocks = state.mocks.filter((mock) => mock.enabled).length;
      if (state.floatButtonTucked) {
        const viewWidth = document.documentElement.clientWidth;
        const vPos = getVerticalPosition(floatBtn);

        floatBtn.style.top = vPos.top;
        floatBtn.style.bottom = vPos.bottom;

        if (isLeftAligned(floatBtn)) {
          floatBtn.style.left = "-30px";
          floatBtn.style.right = "auto";
          floatBtn.classList.add("tucked-left");
          floatBtn.classList.remove("tucked");
        } else {
          floatBtn.style.left = `${viewWidth - 12}px`;
          floatBtn.style.right = "auto";
          floatBtn.classList.add("tucked");
          floatBtn.classList.remove("tucked-left");
        }
        floatBtn.style.position = "fixed";
        floatBtn.style.opacity = "0.62";
      } else {
        if (state.buttonPosition) {
          applyUntuckedPosition(floatBtn);
        } else {
          floatBtn.style.left = "";
          floatBtn.style.top = "";
          floatBtn.style.bottom = "";
          floatBtn.style.right = "";
        }
        floatBtn.style.position = "";
        floatBtn.style.opacity = "";
        floatBtn.classList.remove("tucked");
        floatBtn.classList.remove("tucked-left");
      }

      const statusTitle = state.mockEnabled ? "Mock intercepting is active" : "Mock intercepting is paused";
      floatBtn.innerHTML = `
        <span class="indicator-dot ${state.mockEnabled ? "active" : ""}" title="${statusTitle}"></span>
        <span>Net</span>
        <b>${state.requests.length}</b>
        <small>${activeMocks} mock${activeMocks === 1 ? "" : "s"}</small>
      `;

      devtools.innerHTML = panelTemplate();

      if (state.expanded) {
        devtools.classList.add("expanded");
        floatBtn.classList.add("hidden");
      } else {
        devtools.classList.remove("expanded");
        floatBtn.classList.remove("hidden");
      }

      bindPanelEvents(root);

      // Restore scroll positions
      Object.keys(scrollPositions).forEach((selector) => {
        const el = root.querySelector(selector);
        if (el) el.scrollTop = scrollPositions[selector];
      });

      if (focusedSelector) {
        const newFocusedInput = root.querySelector(focusedSelector);
        if (newFocusedInput) {
          newFocusedInput.focus();
          if (selectionStart !== null && selectionEnd !== null) {
            newFocusedInput.setSelectionRange(selectionStart, selectionEnd);
          }
        }
      }
    };

    state.subscribers.add(render);
    render();
  }

  function bindPanelEvents(root) {
    const floatBtn = root.querySelector(".float-button");

    if (floatBtn && !floatBtn._eventsBound) {
      floatBtn._eventsBound = true;
      let idleTimer = null;

      const startIdleTimer = () => {
        stopIdleTimer();
        idleTimer = setTimeout(() => {
          tuckButtonIntoEdge();
        }, 3000);
      };

      const stopIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const tuckButtonIntoEdge = () => {
        const rect = floatBtn.getBoundingClientRect();

        floatBtn.style.transition = "none";
        floatBtn.style.left = `${rect.left}px`;
        floatBtn.style.top = `${rect.top}px`;
        floatBtn.style.bottom = "auto";
        floatBtn.style.right = "auto";

        floatBtn.offsetHeight;

        state.floatButtonTucked = true;
        const vPos = getVerticalPosition(floatBtn);
        const viewWidth = document.documentElement.clientWidth;

        floatBtn.style.transition = "left 0.4s cubic-bezier(0.4, 0, 0.2, 1), top 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease, visibility 0.4s ease, transform 0.3s ease";
        
        floatBtn.style.top = vPos.top;
        floatBtn.style.bottom = vPos.bottom;

        if (isLeftAligned(floatBtn)) {
          floatBtn.classList.add("tucked-left");
          floatBtn.classList.remove("tucked");
          floatBtn.style.left = "-30px";
        } else {
          floatBtn.classList.add("tucked");
          floatBtn.classList.remove("tucked-left");
          floatBtn.style.left = `${viewWidth - 12}px`;
        }
        floatBtn.style.right = "auto";
        floatBtn.style.opacity = "0.62";
      };

      const untuckButton = () => {
        state.floatButtonTucked = false;
        floatBtn.classList.remove("tucked");
        floatBtn.classList.remove("tucked-left");
        const rect = floatBtn.getBoundingClientRect();
        const btnWidth = rect.width || 88;
        const viewWidth = document.documentElement.clientWidth;
        const vPos = getVerticalPosition(floatBtn);

        floatBtn.style.transition = "left 0.4s cubic-bezier(0.4, 0, 0.2, 1), top 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease, visibility 0.4s ease, transform 0.3s ease";
        
        floatBtn.style.top = vPos.top;
        floatBtn.style.bottom = vPos.bottom;

        if (isLeftAligned(floatBtn)) {
          let leftDest = "24px";
          if (state.buttonPosition) {
            if (typeof state.buttonPosition === "string") {
              leftDest = "24px";
            } else if (typeof state.buttonPosition === "object" && state.buttonPosition.left !== undefined) {
              leftDest = state.buttonPosition.left;
            }
          }
          floatBtn.style.left = leftDest;
        } else {
          let rightDest = "24px";
          if (state.buttonPosition) {
            if (typeof state.buttonPosition === "string") {
              rightDest = "24px";
            } else if (typeof state.buttonPosition === "object" && state.buttonPosition.right !== undefined) {
              rightDest = state.buttonPosition.right;
            }
          }
          let rightPx = 24;
          if (typeof rightDest === "string" && rightDest.endsWith("px")) {
            rightPx = parseFloat(rightDest);
          }
          floatBtn.style.left = `${viewWidth - rightPx - btnWidth}px`;
        }
        floatBtn.style.right = "auto";
        floatBtn.style.opacity = "1";
      };

      floatBtn.onmouseenter = () => {
        stopIdleTimer();
        untuckButton();
      };

      floatBtn.onmouseleave = () => {
        startIdleTimer();
      };

      floatBtn.onclick = () => {
        state.expanded = true;
        if (state.activeSnapshotId) {
          state.activeRightTab = "snapshots";
          state.selectedSnapshotId = state.activeSnapshotId;
        } else {
          state.activeRightTab = "mocks";
        }
        notify();
      };

      startIdleTimer();
    }
    root.querySelector("[data-close]")?.addEventListener("click", () => {
      state.expanded = false;
      state.contextMenu = null;
      notify();
    });
    root.querySelector("[data-clear]")?.addEventListener("click", () => {
      state.requests = [];
      state.selectedId = null;
      notify();
    });
    root.querySelector("[data-enter-snapshot-mode]")?.addEventListener("click", () => {
      state.snapshotSelectionMode = !state.snapshotSelectionMode;
      if (state.snapshotSelectionMode) {
        let displayRequests = [...state.requests];
        if (state.requestSearch) {
          const q = state.requestSearch.toLowerCase();
          displayRequests = displayRequests.filter((req) => req.url.toLowerCase().includes(q));
        }
        if (state.requestSearchStatus) {
          const q = state.requestSearchStatus.toLowerCase();
          displayRequests = displayRequests.filter((req) => String(req.status).toLowerCase().includes(q));
        }
        state.selectedSnapshotRequestIds = new Set(displayRequests.map((r) => r.id));
      } else {
        state.selectedSnapshotRequestIds.clear();
      }
      notify();
    });
    root.querySelector("[data-snapshot-select-all]")?.addEventListener("click", () => {
      let displayRequests = [...state.requests];
      if (state.requestSearch) {
        const q = state.requestSearch.toLowerCase();
        displayRequests = displayRequests.filter((req) => req.url.toLowerCase().includes(q));
      }
      if (state.requestSearchStatus) {
        const q = state.requestSearchStatus.toLowerCase();
        displayRequests = displayRequests.filter((req) => String(req.status).toLowerCase().includes(q));
      }
      state.selectedSnapshotRequestIds = new Set(displayRequests.map((r) => r.id));
      notify();
    });
    root.querySelector("[data-snapshot-deselect-all]")?.addEventListener("click", () => {
      state.selectedSnapshotRequestIds.clear();
      notify();
    });
    root.querySelectorAll("[data-toggle-snapshot-select]").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const reqId = checkbox.getAttribute("data-toggle-snapshot-select");
        if (checkbox.checked) {
          state.selectedSnapshotRequestIds.add(reqId);
        } else {
          state.selectedSnapshotRequestIds.delete(reqId);
        }
        notify();
      });
    });
    root.querySelector("[data-save-snapshot-cancel]")?.addEventListener("click", () => {
      state.snapshotSelectionMode = false;
      state.selectedSnapshotRequestIds.clear();
      notify();
    });
    root.querySelector("[data-save-snapshot-confirm]")?.addEventListener("click", () => {
      const name = window.prompt("Enter a name for this snapshot:", `Scenario-${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
      if (!name) return;

      const selectedReqs = state.requests
        .filter((r) => state.selectedSnapshotRequestIds.has(r.id) && r.status !== "pending")
        .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

      if (selectedReqs.length === 0) {
        window.alert("No completed requests selected!");
        return;
      }

      const rulesMap = new Map();
      selectedReqs.forEach((req) => {
        const pattern = mockPatternFromUrl(req.url);
        const key = `${req.method}::${pattern}`;
        if (!rulesMap.has(key)) {
          rulesMap.set(key, {
            id: `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            method: req.method,
            pattern: pattern,
            overflow: "repeat-last",
            responses: []
          });
        }
        const rule = rulesMap.get(key);
        rule.responses.push({
          status: Number(req.status || 200),
          delay: 200,
          headers: req.responseHeaders || { "content-type": "application/json" },
          body: req.responseText || ""
        });
      });

      const newSnapshot = {
        id: `snap-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: name,
        createdAt: new Date().toISOString(),
        rules: Array.from(rulesMap.values())
      };

      state.snapshots.push(newSnapshot);
      state.selectedSnapshotId = newSnapshot.id;
      state.activeRightTab = "snapshots";
      state.snapshotSelectionMode = false;
      state.selectedSnapshotRequestIds.clear();

      persistSnapshots(state.snapshots);
      notify();
    });
    root.querySelector("[data-add-mock]")?.addEventListener("click", () => {
      const mock = normalizeMock(
        {
          enabled: true,
          method: "GET",
          pattern: "/api/example",
          status: 200,
          delay: 0,
          headers: { "content-type": "application/json" },
          body: { ok: true }
        },
        state.mocks.length
      );
      state.mocks = enforceSingleActiveForMock([mock, ...state.mocks], mock.id);
      state.selectedMockId = mock.id;
      saveMocks();
    });
    root.querySelector("[data-export-mocks]")?.addEventListener("click", exportMocks);
    root.querySelector("[data-import-mocks]")?.addEventListener("click", importMocksFromFile);
    root.querySelector("[data-export-snapshots]")?.addEventListener("click", exportSnapshots);
    root.querySelector("[data-import-snapshots]")?.addEventListener("click", importSnapshotsFromFile);
    root.querySelector("[data-start-mock-selection]")?.addEventListener("click", () => {
      state.mockGroupSelectionMode = true;
      state.selectedMockGroupKeys.clear();
      notify();
    });
    root.querySelector("[data-cancel-mock-selection]")?.addEventListener("click", () => {
      state.mockGroupSelectionMode = false;
      state.selectedMockGroupKeys.clear();
      notify();
    });
    root.querySelector("[data-select-all-mock-groups]")?.addEventListener("click", () => {
      const visibleKeys = getMockGroups()
        .filter((group) => state.selectedMockGroupTab === "all" || (group.group || "Default") === state.selectedMockGroupTab)
        .map((group) => group.key);
      state.selectedMockGroupKeys = new Set(visibleKeys);
      notify();
    });
    root.querySelector("[data-deselect-all-mock-groups]")?.addEventListener("click", () => {
      state.selectedMockGroupKeys.clear();
      notify();
    });
    root.querySelector("[data-delete-selected-mock-groups]")?.addEventListener("click", deleteSelectedMockGroups);
    root.querySelector("[data-start-snapshot-selection]")?.addEventListener("click", () => {
      state.snapshotListSelectionMode = true;
      state.selectedSnapshotIds.clear();
      notify();
    });
    root.querySelector("[data-cancel-snapshot-selection]")?.addEventListener("click", () => {
      state.snapshotListSelectionMode = false;
      state.selectedSnapshotIds.clear();
      notify();
    });
    root.querySelector("[data-toggle-all-snapshots]")?.addEventListener("click", () => {
      const visibleIds = state.snapshots.map((snapshot) => snapshot.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => state.selectedSnapshotIds.has(id));
      state.selectedSnapshotIds = allSelected ? new Set() : new Set(visibleIds);
      notify();
    });
    root.querySelector("[data-deselect-all-snapshots]")?.addEventListener("click", () => {
      state.selectedSnapshotIds.clear();
      notify();
    });
    root.querySelector("[data-delete-selected-snapshots]")?.addEventListener("click", deleteSelectedSnapshots);
    root.querySelectorAll("[data-request-id]").forEach((item) => {
      item.addEventListener("click", () => {
        state.selectedId = item.getAttribute("data-request-id");
        state.contextMenu = null;
        notify();
      });
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        state.selectedId = item.getAttribute("data-request-id");
        state.contextMenu = {
          type: "request",
          requestId: state.selectedId,
          ...contextMenuPosition(event)
        };
        notify();
      });
    });
    root.querySelectorAll("[data-create-mock-from-request]").forEach((item) => {
      item.addEventListener("click", () => {
        const requestId = item.getAttribute("data-create-mock-from-request");
        createMockFromRequest(requestId);
      });
    });
    root.querySelectorAll("[data-view-mock]").forEach((item) => {
      item.addEventListener("click", () => {
        const mockId = item.getAttribute("data-view-mock");
        if (mockId) {
          state.activeRightTab = "mocks";
          state.selectedMockId = mockId;
          if (state.detailsLayout === "modal") {
            state.editingMockId = mockId;
          }
          state.contextMenu = null;
          notify();
        }
      });
    });
    root.querySelectorAll("[data-navigate-to-source]").forEach((item) => {
      item.addEventListener("click", () => {
        const sourceId = item.getAttribute("data-navigate-to-source");
        const sourceType = item.getAttribute("data-source-type");
        if (!sourceId) return;
        if (sourceType === "snapshot") {
          // Navigate to the snapshot that contains this rule
          const snapshot = state.snapshots.find((s) =>
            s.rules && s.rules.some((r) => r.id === sourceId)
          );
          if (snapshot) {
            state.activeRightTab = "snapshots";
            state.selectedSnapshotId = snapshot.id;
            startEditingSnapshot(snapshot.id);
            if (state.detailsLayout === "modal") {
              state.editingSnapshotId = snapshot.id;
            }
            notify();
          }
        } else {
          // Navigate to the mock rule
          const mock = state.mocks.find((m) => m.id === sourceId);
          if (mock) {
            state.activeRightTab = "mocks";
            state.selectedMockId = sourceId;
            if (state.detailsLayout === "modal") {
              state.editingMockId = sourceId;
            }
            notify();
          }
        }
      });
    });
    root.querySelector("[data-close-menu]")?.addEventListener("click", () => {
      state.contextMenu = null;
      notify();
    });
    root.querySelectorAll("[data-delete-mock]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-delete-mock");
        const targetMock = state.mocks.find((mock) => mock.id === id);
        state.mocks = state.mocks.filter((mock) => mock.id !== id);
        state.mocks = enforceSingleActivePerEndpoint(state.mocks);
        if (state.selectedMockId === id) {
          if (targetMock) {
            const remainingMocksForGroup = state.mocks.filter(
              (mock) => mock.method === targetMock.method && mock.pattern === targetMock.pattern
            );
            if (remainingMocksForGroup.length > 0) {
              state.selectedMockId = remainingMocksForGroup[0].id;
            } else {
              state.selectedMockId = null;
            }
          } else {
            state.selectedMockId = null;
          }
        }
        saveMocks();
      });
    });
    root.querySelectorAll("[data-select-mock]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedMockId = button.getAttribute("data-select-mock");
        notify();
      });
    });
    root.querySelectorAll("[data-select-endpoint]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.getAttribute("data-select-endpoint");
        if (state.mockGroupSelectionMode) {
          toggleSetValue(state.selectedMockGroupKeys, key);
          notify();
          return;
        }
        const group = getMockGroups().find((item) => item.key === key);
        state.selectedMockId = group?.mocks[0]?.id || null;
        if (state.detailsLayout === "modal") {
          state.editingMockId = state.selectedMockId;
        }
        notify();
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const key = button.getAttribute("data-select-endpoint");
        state.contextMenu = {
          type: "mock-group",
          groupKey: key,
          ...contextMenuPosition(event)
        };
        notify();
      });
    });
    root.querySelectorAll("[data-toggle-mock-group-selection]").forEach((input) => {
      input.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleSetValue(state.selectedMockGroupKeys, input.getAttribute("data-toggle-mock-group-selection"));
        notify();
      });
    });
    root.querySelectorAll("[data-delete-mock-group]").forEach((item) => {
      item.addEventListener("click", () => {
        const groupKey = item.getAttribute("data-delete-mock-group");
        if (groupKey) {
          const group = getMockGroups().find((g) => g.key === groupKey);
          if (group) {
            state.mocks = state.mocks.filter(
              (mock) => !(mock.method === group.method && mock.pattern === group.pattern)
            );
            const hasSelected = group.mocks.some((m) => m.id === state.selectedMockId);
            if (hasSelected) {
              state.selectedMockId = null;
            }
            saveMocks();
          }
        }
        state.contextMenu = null;
        notify();
      });
    });
    root.querySelectorAll("[data-save-mock]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-save-mock");
        saveMockFromForm(root, id);
      });
    });
    const templates = {
      "200": {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: 200, success: true, data: {} }, null, 2)
      },
      "404": {
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: 404, message: "Not Found" }, null, 2)
      },
      "500": {
        status: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: 500, message: "Internal Server Error" }, null, 2)
      }
    };
    root.querySelectorAll("[data-template]").forEach((button) => {
      button.addEventListener("click", () => {
        const mockId = button.getAttribute("data-mock-id");
        const templateKey = button.getAttribute("data-template");
        const template = templates[templateKey];
        if (!template) return;

        const card = root.querySelector(`[data-mock-card="${cssEscape(mockId)}"]`);
        if (!card) return;

        const statusInput = card.querySelector('[data-mock-field="status"]');
        const headersTextarea = card.querySelector('[data-mock-field="headers"]');
        const bodyTextarea = card.querySelector('[data-mock-field="body"]');

        if (statusInput) statusInput.value = template.status;
        if (headersTextarea) headersTextarea.value = JSON.stringify(template.headers, null, 2);
        if (bodyTextarea) bodyTextarea.value = template.body;
      });
    });
    root.querySelectorAll("[data-fill-mock-status]").forEach((button) => {
      button.addEventListener("click", () => {
        const mockId = button.getAttribute("data-mock-id");
        const val = button.getAttribute("data-fill-mock-status");
        const card = root.querySelector(`[data-mock-card="${cssEscape(mockId)}"]`);
        if (card) {
          const statusInput = card.querySelector('[data-mock-field="status"]');
          if (statusInput) {
            statusInput.value = val;
            statusInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        const mock = state.mocks.find((m) => m.id === mockId);
        if (mock) {
          mock.status = Number(val);
        }
      });
    });
    root.querySelectorAll("[data-fill-mock-delay]").forEach((button) => {
      button.addEventListener("click", () => {
        const mockId = button.getAttribute("data-mock-id");
        const val = button.getAttribute("data-fill-mock-delay");
        const card = root.querySelector(`[data-mock-card="${cssEscape(mockId)}"]`);
        if (card) {
          const delayInput = card.querySelector('[data-mock-field="delay"]');
          if (delayInput) {
            delayInput.value = val;
            delayInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        const mock = state.mocks.find((m) => m.id === mockId);
        if (mock) {
          mock.delay = Number(val);
        }
      });
    });
    root.querySelectorAll("[data-format-field]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const mockId = btn.getAttribute("data-mock-id");
        const field = btn.getAttribute("data-format-field");
        const textarea = root.querySelector(`textarea[data-mock-id="${mockId}"][data-mock-field="${field}"]`);
        if (!textarea) return;

        try {
          const parsed = safeParseLooseJson(textarea.value);
          
          const sortObjectKeys = (obj) => {
            if (obj === null || typeof obj !== "object") return obj;
            if (Array.isArray(obj)) return obj.map(sortObjectKeys);
            return Object.keys(obj)
              .sort()
              .reduce((acc, key) => {
                acc[key] = sortObjectKeys(obj[key]);
                return acc;
              }, {});
          };

          const sorted = sortObjectKeys(parsed);
          const formatted = JSON.stringify(sorted, null, 2);
          textarea.value = formatted;
          
            const mock = state.mocks.find((m) => m.id === mockId);
            if (mock) {
              if (field === "headers") {
                mock.headers = sorted;
              } else if (field === "body") {
                mock.body = formatted;
              }
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              textarea.dispatchEvent(new Event("change", { bubbles: true }));
            }

            btn.innerText = "Formatted!";
            btn.classList.add("format-success");
            btn.disabled = true;
            setTimeout(() => {
              btn.innerText = "Format";
              btn.classList.remove("format-success");
              btn.disabled = false;
            }, 1500);
          } catch (error) {
            btn.innerText = "Error!";
            btn.classList.add("format-error");
            btn.disabled = true;
            setTimeout(() => {
              btn.innerText = "Format";
              btn.classList.remove("format-error");
              btn.disabled = false;
            }, 1500);
          }
      });
    });
    root.querySelectorAll("[data-add-config]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-add-config");
        addConfigFromMock(id);
      });
    });
    root.querySelectorAll("[data-copy-btn]").forEach((button) => {
      button.addEventListener("click", () => {
        const pre = button.parentElement?.querySelector("pre");
        if (pre) {
          navigator.clipboard.writeText(pre.textContent).then(() => {
            button.classList.add("copied");
            setTimeout(() => {
              button.classList.remove("copied");
            }, 1500);
          }).catch((err) => {
            console.error("Failed to copy text: ", err);
          });
        }
      });
    });
    const searchInput = root.querySelector("[data-search-input]");
    if (searchInput) {
      searchInput.addEventListener("input", (event) => {
        state.requestSearch = event.target.value;
        notify();
      });
    }
    const statusFilter = root.querySelector("[data-status-filter]");
    if (statusFilter) {
      statusFilter.addEventListener("input", (event) => {
        state.requestSearchStatus = event.target.value;
        notify();
      });
    }
    const sortSelect = root.querySelector("[data-sort-select]");
    if (sortSelect) {
      sortSelect.addEventListener("change", (event) => {
        state.requestSort = event.target.value;
        notify();
      });
    }
    root.querySelectorAll("[data-group-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedMockGroupTab = button.getAttribute("data-group-tab");
        notify();
      });
    });
    root.querySelectorAll("[data-section-toggle]").forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const section = toggle.closest("[data-section-title]");
        const title = section?.getAttribute("data-section-title");
        if (title) {
          if (state.collapsedSections.has(title)) {
            state.collapsedSections.delete(title);
          } else {
            state.collapsedSections.add(title);
          }
          notify();
        }
      });
    });
    const globalToggle = root.querySelector("[data-global-toggle-mock]");
    if (globalToggle) {
      globalToggle.addEventListener("change", (event) => {
        state.mockEnabled = event.target.checked;
        safeLocalStorageSet("embedded-devtools-mock-enabled", String(state.mockEnabled));
        saveMocks();
      });
    }

    root.querySelectorAll('[data-group-field="method"]').forEach((select) => {
      select.addEventListener("change", (e) => {
        const groupKey = select.getAttribute("data-group-key");
        const newMethod = e.target.value.toUpperCase();
        const [method, pattern] = groupKey.split("::");
        state.mocks = state.mocks.map((mock) => {
          if (mock.method === method && mock.pattern === pattern) {
            return { ...mock, method: newMethod };
          }
          return mock;
        });
        saveMocks();
        notify();
      });
    });

    root.querySelectorAll('[data-group-field="pattern"]').forEach((input) => {
      input.addEventListener("input", (e) => {
        const groupKey = input.getAttribute("data-group-key");
        const newPattern = e.target.value;
        const [method, pattern] = groupKey.split("::");
        state.mocks = state.mocks.map((mock) => {
          if (mock.method === method && mock.pattern === pattern) {
            return { ...mock, pattern: newPattern };
          }
          return mock;
        });
        saveMocks();
        notify();
      });
    });

    root.querySelectorAll('[data-group-field="group"]').forEach((input) => {
      input.addEventListener("input", (e) => {
        const groupKey = input.getAttribute("data-group-key");
        const newGroup = e.target.value;
        const [method, pattern] = groupKey.split("::");
        state.mocks = state.mocks.map((mock) => {
          if (mock.method === method && mock.pattern === pattern) {
            return { ...mock, group: newGroup };
          }
          return mock;
        });
        saveMocks();
        notify();
      });
    });

    root.querySelectorAll('[data-group-field="aliasName"]').forEach((input) => {
      const updateAliasName = (value) => {
        const method = input.getAttribute("data-group-method");
        const pattern = input.getAttribute("data-group-pattern");
        state.mocks = state.mocks.map((mock) => {
          if (mock.method === method && mock.pattern === pattern) {
            return { ...mock, aliasName: value };
          }
          return mock;
        });
      };

      input.addEventListener("input", (e) => {
        updateAliasName(e.target.value);
        saveMocks(state.mocks, { silent: true });
      });

      input.addEventListener("change", (e) => {
        updateAliasName(e.target.value);
        saveMocks();
      });
    });

    root.querySelectorAll("[data-mode-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeRightTab = button.getAttribute("data-mode-tab");
        state.mockGroupSelectionMode = false;
        state.selectedMockGroupKeys.clear();
        state.snapshotListSelectionMode = false;
        state.selectedSnapshotIds.clear();
        notify();
      });
    });

    root.querySelectorAll("[data-select-snapshot]").forEach((button) => {
      button.addEventListener("click", () => {
        const snapshotId = button.getAttribute("data-select-snapshot");
        if (state.snapshotListSelectionMode) {
          toggleSetValue(state.selectedSnapshotIds, snapshotId);
          notify();
          return;
        }
        state.selectedSnapshotId = snapshotId;
        startEditingSnapshot(state.selectedSnapshotId);
        if (state.detailsLayout === "modal") {
          state.editingSnapshotId = state.selectedSnapshotId;
        }
        notify();
      });
    });
    root.querySelectorAll("[data-toggle-snapshot-selection]").forEach((input) => {
      input.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleSetValue(state.selectedSnapshotIds, input.getAttribute("data-toggle-snapshot-selection"));
        notify();
      });
    });

    root.querySelector("[data-global-toggle-snapshot]")?.addEventListener("change", (e) => {
      if (e.target.checked) {
        state.activeSnapshotId = state.selectedSnapshotId || (state.snapshots[0] ? state.snapshots[0].id : null);
        if (state.activeSnapshotId) {
          state.selectedSnapshotId = state.activeSnapshotId;
        }
      } else {
        state.activeSnapshotId = null;
      }
      state.playbackIndices = {};
      persistActiveSnapshotId(state.activeSnapshotId);
      syncServiceWorkerSnapshot();
      notify();
    });

    root.querySelector("[data-rename-snapshot]")?.addEventListener("change", (e) => {
      if (state.editingSnapshotDraft) {
        state.editingSnapshotDraft.name = e.target.value;
        notify();
      }
    });

    root.querySelector("[data-toggle-active-snapshot]")?.addEventListener("click", () => {
      if (state.activeSnapshotId === state.selectedSnapshotId) {
        state.activeSnapshotId = null;
      } else {
        state.activeSnapshotId = state.selectedSnapshotId;
      }
      state.playbackIndices = {};
      persistActiveSnapshotId(state.activeSnapshotId);
      syncServiceWorkerSnapshot();
      notify();
    });

    root.querySelector("[data-delete-snapshot]")?.addEventListener("click", () => {
      if (!state.selectedSnapshotId) return;
      if (!window.confirm("Are you sure you want to delete this snapshot?")) return;

      state.snapshots = state.snapshots.filter((s) => s.id !== state.selectedSnapshotId);
      if (state.activeSnapshotId === state.selectedSnapshotId) {
        state.activeSnapshotId = null;
        persistActiveSnapshotId(null);
        syncServiceWorkerSnapshot();
      }
      state.selectedSnapshotId = state.snapshots[0]?.id || null;
      startEditingSnapshot(state.selectedSnapshotId);
      persistSnapshots(state.snapshots);
      notify();
    });

    root.querySelectorAll("[data-rule-field]").forEach((el) => {
      el.addEventListener("change", (e) => {
        const ruleIdx = parseInt(el.getAttribute("data-rule-idx"), 10);
        const field = el.getAttribute("data-rule-field");
        if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx]) {
          state.editingSnapshotDraft.rules[ruleIdx][field] = e.target.value;
          notify();
        }
      });
    });

    root.querySelectorAll("[data-delete-snapshot-rule]").forEach((button) => {
      button.addEventListener("click", () => {
        const ruleIdx = parseInt(button.getAttribute("data-delete-snapshot-rule"), 10);
        if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx]) {
          state.editingSnapshotDraft.rules.splice(ruleIdx, 1);
          notify();
        }
      });
    });

    root.querySelector("[data-add-snapshot-rule]")?.addEventListener("click", () => {
      if (state.editingSnapshotDraft) {
        state.editingSnapshotDraft.rules.push({
          id: `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          method: "GET",
          pattern: "/api/new-pattern",
          overflow: "repeat-last",
          responses: [
            { status: 200, delay: 200, headers: { "content-type": "application/json" }, body: "{}" }
          ]
        });
        notify();
      }
    });

    root.querySelectorAll("[data-delete-snapshot-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const val = button.getAttribute("data-delete-snapshot-step");
        const parts = val.split("-");
        const ruleIdx = parseInt(parts[0], 10);
        const stepIdx = parseInt(parts[1], 10);
        if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx] && state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx]) {
          state.editingSnapshotDraft.rules[ruleIdx].responses.splice(stepIdx, 1);
          notify();
        }
      });
    });

    root.querySelectorAll("[data-add-snapshot-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const ruleIdx = parseInt(button.getAttribute("data-add-snapshot-step"), 10);
        if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx]) {
          const lastResp = state.editingSnapshotDraft.rules[ruleIdx].responses[state.editingSnapshotDraft.rules[ruleIdx].responses.length - 1];
          state.editingSnapshotDraft.rules[ruleIdx].responses.push({
            status: lastResp ? lastResp.status : 200,
            delay: lastResp ? lastResp.delay : 0,
            headers: lastResp ? JSON.parse(JSON.stringify(lastResp.headers)) : { "content-type": "application/json" },
            body: lastResp ? lastResp.body : "{}"
          });
          notify();
        }
      });
    });

    root.querySelectorAll("[data-snapshot-field]").forEach((el) => {
      el.addEventListener("change", (e) => {
        const ruleIdx = parseInt(el.getAttribute("data-rule-idx"), 10);
        const stepIdx = parseInt(el.getAttribute("data-step-idx"), 10);
        const field = el.getAttribute("data-snapshot-field");
        if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx] && state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx]) {
          let val = e.target.value;
          if (field === "status" || field === "delay") {
            val = Number(val || 0);
          } else if (field === "headers") {
            try {
              val = JSON.parse(val);
            } catch (_err) {
              return;
            }
          }
          state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx][field] = val;
          notify();
        }
      });
    });
    root.querySelectorAll("[data-fill-snapshot-status]").forEach((button) => {
      button.addEventListener("click", () => {
        const ruleIdx = parseInt(button.getAttribute("data-rule-idx"), 10);
        const stepIdx = parseInt(button.getAttribute("data-step-idx"), 10);
        const val = parseInt(button.getAttribute("data-fill-snapshot-status"), 10);
        if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx] && state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx]) {
          state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx].status = val;
          notify();
        }
      });
    });
    root.querySelectorAll("[data-fill-snapshot-delay]").forEach((button) => {
      button.addEventListener("click", () => {
        const ruleIdx = parseInt(button.getAttribute("data-rule-idx"), 10);
        const stepIdx = parseInt(button.getAttribute("data-step-idx"), 10);
        const val = parseInt(button.getAttribute("data-fill-snapshot-delay"), 10);
        if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx] && state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx]) {
          state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx].delay = val;
          notify();
        }
      });
    });

    root.querySelectorAll("[data-create-snapshot-from-url]").forEach((item) => {
      item.addEventListener("click", () => {
        const targetUrl = item.getAttribute("data-create-snapshot-from-url");
        const pattern = mockPatternFromUrl(targetUrl);
        const name = window.prompt("Enter a name for this snapshot:", `Sequence-${pattern}`);
        if (!name) return;

        const method = state.requests.find(r => r.url === targetUrl)?.method || "GET";
        const selectedReqs = state.requests
          .filter((r) => r.method === method && mockPatternFromUrl(r.url) === pattern && r.status !== "pending")
          .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

        if (selectedReqs.length === 0) {
          window.alert("No matching requests found in log!");
          return;
        }

        const rule = {
          id: `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          method: method,
          pattern: pattern,
          overflow: "repeat-last",
          responses: selectedReqs.map((req) => ({
            status: Number(req.status || 200),
            delay: 200,
            headers: req.responseHeaders || { "content-type": "application/json" },
            body: req.responseText || ""
          }))
        };

        const newSnapshot = {
          id: `snap-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: name,
          createdAt: new Date().toISOString(),
          rules: [rule]
        };

        state.snapshots.push(newSnapshot);
        state.selectedSnapshotId = newSnapshot.id;
        state.activeRightTab = "snapshots";
        state.contextMenu = null;

        persistSnapshots(state.snapshots);
        notify();
      });
    });

    root.querySelector("[data-open-settings]")?.addEventListener("click", async () => {
      await updateStorageEstimate();
      state.showSettingsModal = true;
      notify();
    });

    root.querySelectorAll("[data-close-settings-modal]").forEach((el) => {
      el.addEventListener("click", () => {
        state.showSettingsModal = false;
        notify();
      });
    });

    root.querySelectorAll("[data-close-details-modal]").forEach((el) => {
      el.addEventListener("click", () => {
        state.selectedMockId = null;
        state.selectedSnapshotId = null;
        state.editingMockId = null;
        state.editingSnapshotId = null;
        state.editingSnapshotDraft = null;
        notify();
      });
    });

    root.querySelectorAll('input[name="details-layout"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        state.detailsLayout = e.target.value;
        safeLocalStorageSet("embedded-devtools-details-layout", state.detailsLayout);
        notify();
      });
    });
    root.querySelectorAll("[data-snapshot-format-field]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const ruleIdx = parseInt(btn.getAttribute("data-rule-idx"), 10);
        const stepIdx = parseInt(btn.getAttribute("data-step-idx"), 10);
        const field = btn.getAttribute("data-snapshot-format-field");
        const textarea = root.querySelector(`textarea[data-snapshot-rule-idx="${ruleIdx}"][data-snapshot-step-idx="${stepIdx}"][data-snapshot-field="${field}"]`);
        if (!textarea) return;

        try {
          const parsed = safeParseLooseJson(textarea.value);
          const formatted = JSON.stringify(parsed, null, 2);
          textarea.value = formatted;
          
          if (state.editingSnapshotDraft && state.editingSnapshotDraft.rules[ruleIdx] && state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx]) {
            state.editingSnapshotDraft.rules[ruleIdx].responses[stepIdx][field] = field === "headers" ? parsed : formatted;
          }

          btn.innerText = "Formatted!";
          btn.classList.add("format-success");
          btn.disabled = true;
          setTimeout(() => {
            btn.innerText = "Format";
            btn.classList.remove("format-success");
            btn.disabled = false;
          }, 1500);
        } catch (error) {
          btn.innerText = "Error!";
          btn.classList.add("format-error");
          btn.disabled = true;
          setTimeout(() => {
            btn.innerText = "Format";
            btn.classList.remove("format-error");
            btn.disabled = false;
          }, 1500);
        }
      });
    });
    root.querySelector("[data-save-snapshot-edit]")?.addEventListener("click", () => {
      if (!state.editingSnapshotDraft) return;
      const index = state.snapshots.findIndex((s) => s.id === state.editingSnapshotDraft.id);
      if (index !== -1) {
        state.snapshots[index] = state.editingSnapshotDraft;
        persistSnapshots(state.snapshots);
        if (state.editingSnapshotDraft.id === state.activeSnapshotId) {
          syncServiceWorkerSnapshot();
        }
        
        const id = state.editingSnapshotDraft.id;
        state.savedSnapshotId = id;
        notify();

        setTimeout(() => {
          if (state.savedSnapshotId !== id) return;
          state.savedSnapshotId = null;
          notify();
        }, 1500);
      }
    });

    root.querySelector("[data-cancel-snapshot-edit]")?.addEventListener("click", () => {
      const activeId = state.selectedSnapshotId || state.editingSnapshotId;
      startEditingSnapshot(activeId);
      notify();
    });

  }

  function saveMockFromForm(root, id) {
    const card = root.querySelector(`[data-mock-card="${cssEscape(id)}"]`);
    const currentMock = state.mocks.find((mock) => mock.id === id);
    if (!card || !currentMock) return;
    const getField = (field) => card.querySelector(`[data-mock-field="${field}"]`);
    const headers = safeJsonParse(getField("headers")?.value, currentMock.headers);
    const wantsActive = getField("enabled") ? getField("enabled").checked : currentMock.enabled;
    const patch = {
      name: getField("name")?.value || "",
      enabled: wantsActive,
      method: getField("method") ? getField("method").value.toUpperCase() : currentMock.method,
      pattern: getField("pattern") ? getField("pattern").value : currentMock.pattern,
      status: Number(getField("status")?.value || 200),
      delay: Number(getField("delay")?.value || 0),
      headers,
      body: getField("body")?.value || ""
    };
    state.mocks = state.mocks.map((mock) => {
      if (mock.id !== id) return mock;
      return { ...mock, ...patch };
    });
    state.mocks = enforceSingleActiveForMock(state.mocks, id);
    state.selectedMockId = id;
    state.savedMockId = id;
    saveMocks();
    window.setTimeout(() => {
      if (state.savedMockId !== id) return;
      state.savedMockId = null;
      notify();
    }, 1500);
  }

  function toggleSetValue(set, value) {
    if (!value) return;
    if (set.has(value)) {
      set.delete(value);
    } else {
      set.add(value);
    }
  }

  function deleteSelectedMockGroups() {
    const selectedKeys = new Set(state.selectedMockGroupKeys);
    if (!selectedKeys.size) return;

    state.mocks = state.mocks.filter((mock) => !selectedKeys.has(endpointKey(mock.method, mock.pattern)));
    state.mocks = enforceSingleActivePerEndpoint(state.mocks);
    if (state.selectedMockId && !state.mocks.some((mock) => mock.id === state.selectedMockId)) {
      state.selectedMockId = null;
    }
    state.mockGroupSelectionMode = false;
    state.selectedMockGroupKeys.clear();
    saveMocks();
  }

  function deleteSelectedSnapshots() {
    const selectedIds = new Set(state.selectedSnapshotIds);
    if (!selectedIds.size) return;
    const label = selectedIds.size === 1 ? "snapshot" : "snapshots";
    if (!window.confirm(`Delete ${selectedIds.size} selected ${label}?`)) return;

    state.snapshots = state.snapshots.filter((snapshot) => !selectedIds.has(snapshot.id));
    if (state.activeSnapshotId && selectedIds.has(state.activeSnapshotId)) {
      state.activeSnapshotId = null;
      state.playbackIndices = {};
      persistActiveSnapshotId(null);
      syncServiceWorkerSnapshot();
    }
    if (state.selectedSnapshotId && selectedIds.has(state.selectedSnapshotId)) {
      state.selectedSnapshotId = state.snapshots[0]?.id || null;
      startEditingSnapshot(state.selectedSnapshotId);
    }
    state.snapshotListSelectionMode = false;
    state.selectedSnapshotIds.clear();
    persistSnapshots(state.snapshots);
    notify();
  }

  function exportMocks() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      mocks: state.mocks
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `mocktools-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function importMocksFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const content = await file.text();
        const parsed = JSON.parse(content);
        const importedMocks = Array.isArray(parsed) ? parsed : parsed.mocks;
        if (!Array.isArray(importedMocks)) throw new Error("Invalid mock backup");
        state.mocks = enforceSingleActivePerEndpoint(normalizeMocks(importedMocks));
        state.selectedMockId = null;
        saveMocks();
      } catch (error) {
        window.alert(`Import failed: ${error.message || "invalid file"}`);
      }
    });
    input.click();
  }

  function exportSnapshots() {
    const selectedSnap = state.snapshots.find((s) => s.id === state.selectedSnapshotId);
    if (!selectedSnap) return;
    const payload = {
      version: 1,
      type: "snapshot-backup",
      exportedAt: new Date().toISOString(),
      snapshot: selectedSnap
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `mocktools-snapshot-${selectedSnap.name.replace(/[^a-zA-Z0-9]/g, "_")}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function importSnapshotsFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const content = await file.text();
        const parsed = JSON.parse(content);
        const importedSnap = parsed.snapshot;
        if (!importedSnap || !importedSnap.name || !Array.isArray(importedSnap.rules)) {
          throw new Error("Invalid snapshot backup file");
        }
        importedSnap.id = `snap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        importedSnap.rules.forEach((rule) => {
          rule.id = `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        });
        state.snapshots.push(importedSnap);
        state.selectedSnapshotId = importedSnap.id;
        state.activeRightTab = "snapshots";
        persistSnapshots(state.snapshots);
        notify();
      } catch (error) {
        window.alert(`Snapshot import failed: ${error.message || "invalid file"}`);
      }
    });
    input.click();
  }

  function addConfigFromMock(sourceId) {
    const source = state.mocks.find((mock) => mock.id === sourceId) || state.mocks[0];
    if (!source) return;
    const mock = normalizeMock(
      {
        id: `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: "",
        enabled: false,
        method: source.method,
        pattern: source.pattern,
        group: source.group,
        aliasName: source.aliasName,
        status: 200,
        delay: 0,
        headers: { "content-type": "application/json" },
        body: ""
      },
      state.mocks.length
    );
    state.mocks = [...state.mocks, mock];
    state.selectedMockId = mock.id;
    saveMocks();
  }

  function contextMenuPosition(event) {
    const panel = event.currentTarget?.closest(".devtools");
    const rect = panel?.getBoundingClientRect();
    if (!rect) {
      return {
        x: event.clientX,
        y: event.clientY,
        width: window.innerWidth,
        height: window.innerHeight
      };
    }

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function createMockFromRequest(requestId) {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) return;
    const pattern = mockPatternFromUrl(request.url);
    const requestMethod = String(request.method || "GET").toUpperCase();
    const existingGroup = getMockGroups().find((group) => group.key === endpointKey(requestMethod, pattern));
    const mock = normalizeMock(
      {
        name: "",
        enabled: true,
        method: requestMethod,
        pattern,
        aliasName: existingGroup?.aliasName || "",
        status: Number(request.status) || 200,
        delay: 0,
        headers: request.responseHeaders && Object.keys(request.responseHeaders).length
          ? request.responseHeaders
          : { "content-type": "application/json" },
        body: request.responseText || JSON.stringify({ ok: true }, null, 2)
      },
      state.mocks.length
    );
    state.mocks = enforceSingleActiveForMock([mock, ...state.mocks], mock.id);
    state.activeRightTab = "mocks";
    state.selectedMockId = mock.id;
    if (state.detailsLayout === "modal") {
      state.editingMockId = mock.id;
    }
    state.contextMenu = null;
    saveMocks();
  }

  function settingsModalTemplate() {
    if (!state.showSettingsModal) return "";
    const spaceText = state.storageUsage 
      ? `Remaining storage space: ${state.storageUsage.remaining} MB (estimate quota: ${state.storageUsage.quota} MB)`
      : "Estimate unavailable";
    
    return `
      <div class="modal-overlay" data-close-settings-modal style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); z-index: 11000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px);">
        <div class="modal-card" onclick="event.stopPropagation();" style="background: white; border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); display: flex; flex-direction: column; width: 440px; max-width: 90%; overflow: hidden;">
          <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e2e8f0;">
            <h3 style="margin: 0; font-size: 14px; color: #1e293b; font-weight: 700;">Settings</h3>
            <button type="button" class="close-btn" data-close-settings-modal style="background: transparent; border: none; font-size: 20px; cursor: pointer; color: #94a3b8;">&times;</button>
          </div>
          <div class="modal-body" style="padding: 16px; font-size: 12px; color: #334155;">
            <div class="settings-group" style="margin-bottom: 16px;">
              <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 8px;">Details Panel Layout</label>
              <div class="settings-radio-group" style="display: flex; gap: 16px; margin-top: 4px;">
                <label class="settings-radio-label">
                  <input type="radio" name="details-layout" value="sidebar" ${state.detailsLayout === "sidebar" ? "checked" : ""} />
                  <span>Sidebar (Split View)</span>
                </label>
                <label class="settings-radio-label">
                  <input type="radio" name="details-layout" value="modal" ${state.detailsLayout === "modal" ? "checked" : ""} />
                  <span>Modal Dialog</span>
                </label>
              </div>
            </div>
            
            <div class="settings-group" style="margin-top: 16px; border-top: 1px solid #edf2f7; padding-top: 16px;">
              <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px;">IndexedDB Storage</label>
              <div style="font-size: 11px; color: #64748b; margin-top: 4px;">
                ${spaceText}
              </div>
            </div>
          </div>
          <div class="modal-footer" style="padding: 10px 16px; border-top: 1px solid #e2e8f0; display: flex; justify-content: flex-end;">
            <button type="button" class="secondary-btn" data-close-settings-modal>Done</button>
          </div>
        </div>
      </div>
    `;
  }

  function detailsModalTemplate() {
    if (state.detailsLayout !== "modal") return "";
    
    // For Mock details
    if (state.activeRightTab === "mocks" && state.editingMockId) {
      const selectedGroup = state.mocks.find((m) => m.id === state.editingMockId);
      if (!selectedGroup) return "";
      const groupKey = `${selectedGroup.method}::${selectedGroup.pattern}`;
      const group = {
        key: groupKey,
        method: selectedGroup.method,
        pattern: selectedGroup.pattern,
        group: selectedGroup.group || "",
        aliasName: selectedGroup.aliasName || "",
        mocks: state.mocks.filter((mock) => mock.method === selectedGroup.method && mock.pattern === selectedGroup.pattern)
      };

      return `
        <div class="modal-overlay" data-close-details-modal style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); z-index: 10500; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px);">
          <div class="modal-card" onclick="event.stopPropagation();" style="background: white; border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); display: flex; flex-direction: column; width: 680px; max-width: 90vw; max-height: 85vh; overflow: hidden;">
            <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
              <h3 style="margin: 0; font-size: 14px; color: #1e293b; font-weight: 700;">Edit Mock Rule</h3>
              <button type="button" class="close-btn" data-close-details-modal style="background: transparent; border: none; font-size: 20px; cursor: pointer; color: #94a3b8;">&times;</button>
            </div>
            <div class="modal-body" style="padding: 16px; overflow-y: auto; flex-grow: 1; min-height: 0;">
              ${endpointDetailTemplate(group)}
            </div>
            <div class="modal-footer" style="padding: 10px 16px; border-top: 1px solid #e2e8f0; display: flex; justify-content: flex-end; flex-shrink: 0;">
              <button type="button" class="secondary-btn" data-close-details-modal>Close</button>
            </div>
          </div>
        </div>
      `;
    }

    // For Snapshot details
    if (state.activeRightTab === "snapshots" && state.editingSnapshotId) {
      return `
        <div class="modal-overlay" data-close-details-modal style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); z-index: 10500; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px);">
          <div class="modal-card" onclick="event.stopPropagation();" style="background: white; border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); display: flex; flex-direction: column; width: 780px; max-width: 90vw; max-height: 85vh; overflow: hidden;">
            <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;">
              <h3 style="margin: 0; font-size: 14px; color: #1e293b; font-weight: 700;">Edit Snapshot Rules</h3>
              <button type="button" class="close-btn" data-close-details-modal style="background: transparent; border: none; font-size: 20px; cursor: pointer; color: #94a3b8;">&times;</button>
            </div>
            <div class="modal-body" style="padding: 16px; overflow-y: auto; flex-grow: 1; min-height: 0;">
              ${snapshotDetailTemplate()}
            </div>
            <div class="modal-footer" style="padding: 10px 16px; border-top: 1px solid #e2e8f0; display: flex; justify-content: flex-end; flex-shrink: 0;">
              <button type="button" class="secondary-btn" data-close-details-modal>Close</button>
            </div>
          </div>
        </div>
      `;
    }

    return "";
  }

  function panelTemplate() {
    const selected = state.requests.find((request) => request.id === state.selectedId);
    const selectedMock =
      state.mocks.find((mock) => mock.id === state.selectedMockId) || null;
    const selectedGroup = selectedMock ? getEndpointGroupForMock(selectedMock) : null;

    let displayRequests = [...state.requests];
    if (state.requestSearch) {
      const q = state.requestSearch.toLowerCase();
      displayRequests = displayRequests.filter((req) => req.url.toLowerCase().includes(q));
    }
    if (state.requestSearchStatus) {
      const q = state.requestSearchStatus.toLowerCase();
      displayRequests = displayRequests.filter((req) => String(req.status).toLowerCase().includes(q));
    }
    if (state.requestSort === "oldest") {
      displayRequests.reverse();
    }

    const allGroups = getMockGroups();
    const uniqueGroups = Array.from(new Set(allGroups.map((g) => g.group || "Default"))).sort((a, b) => {
      if (a === "Default") return -1;
      if (b === "Default") return 1;
      return a.localeCompare(b);
    });

    const onlyDefaultGroups = uniqueGroups.length <= 1 && uniqueGroups[0] === "Default";
    const activeTab = onlyDefaultGroups ? "all" : state.selectedMockGroupTab || "all";
    if (onlyDefaultGroups && state.selectedMockGroupTab !== "all") {
      state.selectedMockGroupTab = "all";
    }
    const filteredGroups = allGroups.filter((g) => {
      if (activeTab === "all") return true;
      return (g.group || "Default") === activeTab;
    });
    const tabsList = onlyDefaultGroups ? ["all"] : ["all", ...uniqueGroups];
    const groupTabsHtml = `
      <div class="mock-group-tabs">
        ${tabsList.map((tab) => {
          const isActive = activeTab === tab ? " active" : "";
          const tabLabel = tab === "all" ? "All" : tab;
          return `<button class="mock-group-tab${isActive}" type="button" data-group-tab="${escapeAttr(tab)}">${escapeHtml(tabLabel)}</button>`;
        }).join("")}
      </div>
    `;

    return `
        <header class="topbar">
          <div>
            <strong>Network Mock</strong>
            <span>${state.requests.length} request${state.requests.length === 1 ? "" : "s"}</span>
          </div>
          <nav>
            <button type="button" data-enter-snapshot-mode class="icon-btn${state.snapshotSelectionMode ? " active" : ""}" title="Capture requests as Snapshot">
              <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                <circle cx="12" cy="13" r="4"></circle>
              </svg>
            </button>
            <button type="button" data-clear class="icon-btn" title="Clear requests">
              <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 5L12 12"></path>
                <path d="M12 12L7 14l-4 6a1 1 0 0 0 1 1.5h8a1 1 0 0 0 1-1.2l-2-4.3z"></path>
                <path d="M8 15.5l-3.5 4.5"></path>
                <path d="M9.5 15l-1.5 5"></path>
                <path d="M11 14.5l0.5 5.5"></path>
              </svg>
            </button>
            <button type="button" data-open-settings class="icon-btn" title="Open Settings">
              <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
            <button type="button" data-close class="icon-btn close-btn" title="Collapse panel">
              <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
          </nav>
        </header>
        <div class="grid">
          <aside class="request-list">
            ${state.snapshotSelectionMode ? `
              <div class="request-filter selection-toolbar" style="display: flex; gap: 8px; align-items: center; justify-content: space-between; padding: 8px; background: #e0f2fe; border-bottom: 1px solid #bae6fd; height: 43px; box-sizing: border-box;">
                <span style="font-size: 11px; font-weight: 700; color: #0369a1; white-space: nowrap;">Selected: ${state.selectedSnapshotRequestIds.size}</span>
                <div style="display: flex; gap: 4px;">
                  <button type="button" class="mini-btn" data-snapshot-select-all style="height: 26px; min-height: 26px; padding: 0 8px; font-size: 10px; cursor: pointer; border: 1px solid #93c5fd; border-radius: 4px; background: white; color: #1e3a8a; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">All</button>
                  <button type="button" class="mini-btn" data-snapshot-deselect-all style="height: 26px; min-height: 26px; padding: 0 8px; font-size: 10px; cursor: pointer; border: 1px solid #cbd5e1; border-radius: 4px; background: white; color: #475569; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">None</button>
                </div>
                <div style="display: flex; gap: 6px; margin-left: auto;">
                  <button type="button" data-save-snapshot-confirm style="background: #10b981; color: white; border: none; height: 26px; min-height: 26px; padding: 0 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">Save</button>
                  <button type="button" data-save-snapshot-cancel style="background: #cbd5e1; color: #334155; border: none; height: 26px; min-height: 26px; padding: 0 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">Cancel</button>
                </div>
              </div>
            ` : `
              <div class="request-filter">
                <input type="text" placeholder="Filter URL..." class="search-input" data-search-input value="${escapeAttr(state.requestSearch)}" />
                <input type="text" placeholder="Status" class="search-input" data-status-filter value="${escapeAttr(state.requestSearchStatus)}" style="flex: 0 0 54px; width: 54px; text-align: center; padding: 0 4px;" />
                <select class="sort-select" data-sort-select>
                  <option value="newest" ${state.requestSort === "newest" ? "selected" : ""}>Newest</option>
                  <option value="oldest" ${state.requestSort === "oldest" ? "selected" : ""}>Oldest</option>
                </select>
              </div>
            `}
            <div class="request-items">
              ${displayRequests.length ? displayRequests.map(requestRow).join("") : emptyState(state.requests.length ? "No matches" : "No requests yet")}
            </div>
          </aside>
          <section class="detail">
            ${selected ? detailTemplate(selected) : emptyState("Select a request")}
          </section>
          <aside class="mock-editor">
            <!-- Mode Tabs -->
            <div class="mode-tabs" style="display: flex; border-bottom: 1px solid #d9e1ee; background: #f8fafc;">
              <button class="mode-tab${state.activeRightTab === "mocks" ? " active" : ""}" type="button" data-mode-tab="mocks" style="flex: 1; padding: 10px; border: none; border-bottom: 2px solid ${state.activeRightTab === "mocks" ? "#2563eb" : "transparent"}; background: transparent; color: ${state.activeRightTab === "mocks" ? "#2563eb" : "#64748b"}; font-weight: 600; cursor: pointer; text-align: center; font-size: 12px;">Mock Rules</button>
              <button class="mode-tab${state.activeRightTab === "snapshots" ? " active" : ""}" type="button" data-mode-tab="snapshots" style="flex: 1; padding: 10px; border: none; border-bottom: 2px solid ${state.activeRightTab === "snapshots" ? "#2563eb" : "transparent"}; background: transparent; color: ${state.activeRightTab === "snapshots" ? "#2563eb" : "#64748b"}; font-weight: 600; cursor: pointer; text-align: center; font-size: 12px;">Snapshots</button>
            </div>
            
            ${state.activeRightTab === "mocks" ? `
              <!-- Mocks Mode UI -->
              <div class="tab-content mocks-content">
                <div class="mock-head${state.mockGroupSelectionMode ? " selection-mode" : ""}">
                  ${state.mockGroupSelectionMode ? "" : `
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <strong>Mock rules</strong>
                      <label class="toggle" style="margin-left: 2px;" title="Enable/Disable all mock rules">
                        <input type="checkbox" data-global-toggle-mock ${state.mockEnabled ? "checked" : ""} />
                        <span class="switch" aria-hidden="true"></span>
                      </label>
                    </div>
                  `}
                  <div class="mock-head-actions">
                    ${state.mockGroupSelectionMode ? `
                      <span style="font-size: 11px; font-weight: 700; color: #0369a1; white-space: nowrap;">Selected: ${state.selectedMockGroupKeys.size}</span>
                      <div style="display: flex; gap: 4px;">
                        <button type="button" class="mini-btn" data-select-all-mock-groups style="height: 26px; min-height: 26px; padding: 0 8px; font-size: 10px; cursor: pointer; border: 1px solid #93c5fd; border-radius: 4px; background: white; color: #1e3a8a; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;" ${filteredGroups.length ? "" : "disabled"}>All</button>
                        <button type="button" class="mini-btn" data-deselect-all-mock-groups style="height: 26px; min-height: 26px; padding: 0 8px; font-size: 10px; cursor: pointer; border: 1px solid #cbd5e1; border-radius: 4px; background: white; color: #475569; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;" ${state.selectedMockGroupKeys.size ? "" : "disabled"}>None</button>
                      </div>
                      <div style="display: flex; gap: 6px; margin-left: auto;">
                        <button type="button" data-delete-selected-mock-groups style="background: #dc2626; color: white; border: none; height: 26px; min-height: 26px; padding: 0 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;" title="Delete selected mock rule groups" ${state.selectedMockGroupKeys.size ? "" : "disabled"}>Delete ${state.selectedMockGroupKeys.size || ""}</button>
                        <button type="button" data-cancel-mock-selection style="background: #cbd5e1; color: #334155; border: none; height: 26px; min-height: 26px; padding: 0 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">Cancel</button>
                      </div>
                    ` : `
                      <button type="button" class="action-select-btn" data-start-mock-selection title="Select mock rules" ${filteredGroups.length ? "" : "disabled"}>Select</button>
                      <button type="button" class="action-add-btn" data-add-mock title="Add mock rule">Add</button>
                      <button type="button" class="action-import-btn" data-import-mocks title="Import mock backup">Import</button>
                      <button type="button" class="action-export-btn" data-export-mocks title="Export mock backup">Export</button>
                    `}
                  </div>
                </div>
                ${groupTabsHtml}
                <div class="mock-layout" style="${state.detailsLayout === "modal" ? "grid-template-rows: 1fr;" : ""}">
                  <div class="mock-list">
                    ${filteredGroups.length ? filteredGroups.sort((a, b) => {
                      const aActive = a.activeMock ? 1 : 0;
                      const bActive = b.activeMock ? 1 : 0;
                      if (aActive !== bActive) return bActive - aActive;
                      return a.key.localeCompare(b.key);
                    }).map(mockListRow).join("") : emptyState("No mock rules")}
                  </div>
                  ${state.detailsLayout === "sidebar" ? `
                    <div class="mock-detail">
                      ${selectedGroup ? endpointDetailTemplate(selectedGroup) : emptyState("Select a mock rule")}
                    </div>
                  ` : ""}
                </div>
              </div>
            ` : `
              <!-- Snapshots Mode UI -->
              <div class="tab-content snapshots-content">
                <div class="mock-head${state.snapshotListSelectionMode ? " selection-mode" : ""}">
                  ${state.snapshotListSelectionMode ? "" : `
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <strong>Snapshots</strong>
                      <label class="toggle" style="margin-left: 2px;" title="Enable/Disable active snapshot">
                        <input type="checkbox" data-global-toggle-snapshot ${state.activeSnapshotId ? "checked" : ""} />
                        <span class="switch" aria-hidden="true"></span>
                      </label>
                    </div>
                  `}
                  <div class="mock-head-actions">
                    ${state.snapshotListSelectionMode ? `
                      <span style="font-size: 11px; font-weight: 700; color: #0369a1; white-space: nowrap;">Selected: ${state.selectedSnapshotIds.size}</span>
                      <div style="display: flex; gap: 4px;">
                        <button type="button" class="mini-btn" data-toggle-all-snapshots style="height: 26px; min-height: 26px; padding: 0 8px; font-size: 10px; cursor: pointer; border: 1px solid #93c5fd; border-radius: 4px; background: white; color: #1e3a8a; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;" ${state.snapshots.length ? "" : "disabled"}>All</button>
                        <button type="button" class="mini-btn" data-deselect-all-snapshots style="height: 26px; min-height: 26px; padding: 0 8px; font-size: 10px; cursor: pointer; border: 1px solid #cbd5e1; border-radius: 4px; background: white; color: #475569; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;" ${state.selectedSnapshotIds.size ? "" : "disabled"}>None</button>
                      </div>
                      <div style="display: flex; gap: 6px; margin-left: auto;">
                        <button type="button" data-delete-selected-snapshots style="background: #dc2626; color: white; border: none; height: 26px; min-height: 26px; padding: 0 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;" title="Delete selected snapshots" ${state.selectedSnapshotIds.size ? "" : "disabled"}>Delete ${state.selectedSnapshotIds.size || ""}</button>
                        <button type="button" data-cancel-snapshot-selection style="background: #cbd5e1; color: #334155; border: none; height: 26px; min-height: 26px; padding: 0 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;">Cancel</button>
                      </div>
                    ` : `
                      <button type="button" class="action-select-btn" data-start-snapshot-selection title="Select snapshots" ${state.snapshots.length ? "" : "disabled"}>Select</button>
                      <button type="button" class="action-import-btn" data-import-snapshots title="Import snapshot backup">Import</button>
                      <button type="button" class="action-export-btn" data-export-snapshots title="Export snapshot backup" ${state.selectedSnapshotId ? "" : "disabled"}>Export</button>
                    `}
                  </div>
                </div>
                <div class="mock-layout" style="${state.detailsLayout === "modal" ? "grid-template-rows: 1fr;" : ""}">
                  <div class="mock-list">
                    ${state.snapshots.length ? state.snapshots.map(snapshotListRow).join("") : emptyState("No snapshots")}
                  </div>
                  ${state.detailsLayout === "sidebar" ? `
                    <div class="mock-detail">
                      ${state.selectedSnapshotId ? snapshotDetailTemplate() : emptyState("Select a snapshot")}
                    </div>
                  ` : ""}
                </div>
              </div>
            `}
          </aside>
        </div>
        ${state.contextMenu ? contextMenuTemplate(state.contextMenu) : ""}
        ${settingsModalTemplate()}
        ${detailsModalTemplate()}
      `;
    }



  function statusClass(status) {
    const s = String(status || "");
    if (s === "pending") return "status-pending";
    if (s.startsWith("2") || s.startsWith("3")) return "status-2xx";
    if (s.startsWith("4")) return "status-4xx";
    if (s.startsWith("5")) return "status-5xx";
    return "status-other";
  }

  function requestRow(request) {
    const active = request.id === state.selectedId ? " active" : "";
    const mocked = (request.mocked || request.snapshotted) ? " mocked" : "";
    const mockLabel = request.snapshotted ? "Snapshotted request" : request.mocked ? "Mocked request" : "Passthrough request";
    const selectionClass = state.snapshotSelectionMode ? " selection-active" : "";
    
    let checkboxHtml = "";
    if (state.snapshotSelectionMode) {
      const isChecked = state.selectedSnapshotRequestIds.has(request.id) ? "checked" : "";
      checkboxHtml = `<input type="checkbox" class="snapshot-select-checkbox" data-toggle-snapshot-select="${escapeAttr(request.id)}" ${isChecked} style="width: 12px; height: 12px; margin-right: 6px; cursor: pointer; flex-shrink: 0;" onclick="event.stopPropagation();" />`;
    }

    return `
      <button class="request-row${active}${mocked}${selectionClass}" type="button" data-request-id="${escapeAttr(request.id)}">
        ${checkboxHtml}
        <span class="mock-dot" title="${mockLabel}" aria-label="${mockLabel}"></span>
        <span class="method">${escapeHtml(request.method)}</span>
        <span class="url">${escapeHtml(shortUrl(request.url))}</span>
        <span class="status ${statusClass(request.status)}">${escapeHtml(String(request.status))}</span>
        <span class="duration">${Math.round(request.duration)}ms</span>
      </button>
    `;
  }

  function mockListRow(group) {
    const active = group.mocks.some((mock) => mock.id === state.selectedMockId) ? " active" : "";
    const enabled = group.activeMock ? " enabled" : "";
    const selectionMode = state.mockGroupSelectionMode ? " selection-active" : "";
    const checked = state.selectedMockGroupKeys.has(group.key);
    const selected = checked ? " selected" : "";
    const endpointLabel = `${group.method} ${group.pattern || "(empty pattern)"}`;
    return `
      <button class="mock-row${active}${enabled}${selectionMode}${selected}" type="button" data-select-endpoint="${escapeAttr(group.key)}">
        ${state.mockGroupSelectionMode ? `<input type="checkbox" class="row-select-checkbox" data-toggle-mock-group-selection="${escapeAttr(group.key)}" ${checked ? "checked" : ""} />` : ""}
        <span class="rule-dot" aria-hidden="true"></span>
        <span class="rule-main">
          <strong>${escapeHtml(group.aliasName || endpointLabel)}</strong>
          <em>${group.mocks.length} config${group.mocks.length === 1 ? "" : "s"}, active: ${escapeHtml(group.activeMock?.name || group.activeMock?.status || "none")}</em>
        </span>
        <span class="rule-status ${statusClass(group.activeMock?.status)}">${escapeHtml(String(group.activeMock?.status || "-"))}</span>
      </button>
    `;
  }

  function snapshotListRow(snapshot) {
    const active = snapshot.id === state.selectedSnapshotId ? " active" : "";
    const enabled = snapshot.id === state.activeSnapshotId ? " enabled" : "";
    const selectionMode = state.snapshotListSelectionMode ? " selection-active" : "";
    const checked = state.selectedSnapshotIds.has(snapshot.id);
    const selected = checked ? " selected" : "";
    const totalSteps = snapshot.rules.reduce((acc, r) => acc + (r.responses ? r.responses.length : 0), 0);
    return `
      <button class="mock-row${active}${enabled}${selectionMode}${selected}" type="button" data-select-snapshot="${escapeAttr(snapshot.id)}">
        ${state.snapshotListSelectionMode ? `<input type="checkbox" class="row-select-checkbox" data-toggle-snapshot-selection="${escapeAttr(snapshot.id)}" ${checked ? "checked" : ""} />` : ""}
        <span class="rule-dot" aria-hidden="true"></span>
        <span class="rule-main">
          <strong>${escapeHtml(snapshot.name)}</strong>
          <em>${snapshot.rules.length} rule${snapshot.rules.length === 1 ? "" : "s"}, ${totalSteps} step${totalSteps === 1 ? "" : "s"}</em>
        </span>
        <span class="rule-status ${enabled ? "status-2xx" : "status-other"}">${enabled ? "ON" : "OFF"}</span>
      </button>
    `;
  }

  function snapshotDetailTemplate() {
    const snapshot = state.editingSnapshotDraft;
    if (!snapshot) return emptyState("Select a snapshot");

    const isActive = snapshot.id === state.activeSnapshotId;
    const isSaved = snapshot.id === state.savedSnapshotId;

    const rulesHtml = snapshot.rules.map((rule, ruleIdx) => {
      const stepsHtml = (rule.responses || []).map((resp, stepIdx) => {
        const stepNum = stepIdx + 1;
        const headerTitle = `expanded-snapshot-headers-${ruleIdx}-${stepIdx}`;
        const bodyTitle = `collapsed-snapshot-body-${ruleIdx}-${stepIdx}`;
        const isHeadersCollapsed = !state.collapsedSections.has(headerTitle);
        const isBodyCollapsed = state.collapsedSections.has(bodyTitle);

        return `
          <div class="step-card" style="border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; margin-bottom: 8px; background: #fff;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="font-size: 11px; font-weight: 700; color: #475569;">Step ${stepNum}</span>
              <button type="button" class="danger-text-btn" data-delete-snapshot-step="${ruleIdx}-${stepIdx}">Delete Step</button>
            </div>
            <div style="display: flex; gap: 6px; margin-bottom: 6px;">
              <div style="flex: 1; display: flex; flex-direction: column; gap: 2px;">
                <span style="font-size: 10px; color: #475569; font-weight: 600;">Status</span>
                <div style="display: flex; gap: 4px; align-items: center;">
                  <input type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(String(resp.status))}" data-snapshot-field="status" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}" style="flex: 1; min-width: 0; font-size: 11px; padding: 2px 4px;" />
                  <div style="display: flex; gap: 2px; flex-shrink: 0;">
                    <button type="button" class="quick-fill-btn" data-fill-snapshot-status="200" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}">200</button>
                    <button type="button" class="quick-fill-btn" data-fill-snapshot-status="404" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}">404</button>
                    <button type="button" class="quick-fill-btn" data-fill-snapshot-status="500" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}">500</button>
                  </div>
                </div>
              </div>
              <div style="flex: 1; display: flex; flex-direction: column; gap: 2px;">
                <span style="font-size: 10px; color: #475569; font-weight: 600;">Delay (ms)</span>
                <div style="display: flex; gap: 4px; align-items: center;">
                  <input type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(String(resp.delay))}" data-snapshot-field="delay" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}" style="flex: 1; min-width: 0; font-size: 11px; padding: 2px 4px;" />
                  <div style="display: flex; gap: 2px; flex-shrink: 0;">
                    <button type="button" class="quick-fill-btn" data-fill-snapshot-delay="0" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}">0</button>
                    <button type="button" class="quick-fill-btn" data-fill-snapshot-delay="500" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}">500</button>
                    <button type="button" class="quick-fill-btn" data-fill-snapshot-delay="1000" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}">1000</button>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="code-section${isHeadersCollapsed ? " is-collapsed" : ""}" data-section-title="${headerTitle}" style="margin-top: 4px; margin-bottom: 4px;">
              <h3 data-section-toggle style="display: flex; align-items: center; justify-content: space-between; width: 100%; cursor: pointer;">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="icon-chevron">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                  <span>Headers (JSON)</span>
                </div>
                <button type="button" class="format-btn" data-snapshot-format-field="headers" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}" title="Format JSON" style="margin-left: auto;">Format</button>
              </h3>
              <textarea data-snapshot-field="headers" data-snapshot-rule-idx="${ruleIdx}" data-snapshot-step-idx="${stepIdx}" rows="3" style="width: 100%; font-size: 11px; padding: 2px 4px; font-family: monospace;">${escapeHtml(JSON.stringify(resp.headers || {}, null, 2))}</textarea>
            </div>

            <div class="code-section${isBodyCollapsed ? " is-collapsed" : ""}" data-section-title="${bodyTitle}" style="margin-top: 4px; margin-bottom: 4px;">
              <h3 data-section-toggle style="display: flex; align-items: center; justify-content: space-between; width: 100%; cursor: pointer;">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="icon-chevron">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                  <span>Body</span>
                </div>
                <button type="button" class="format-btn" data-snapshot-format-field="body" data-rule-idx="${ruleIdx}" data-step-idx="${stepIdx}" title="Format JSON" style="margin-left: auto;">Format</button>
              </h3>
              <textarea data-snapshot-field="body" data-snapshot-rule-idx="${ruleIdx}" data-snapshot-step-idx="${stepIdx}" rows="4" style="width: 100%; font-size: 11px; padding: 2px 4px; font-family: monospace;">${escapeHtml(resp.body)}</textarea>
            </div>
          </div>
        `;
      }).join("");

      return `
        <div class="snapshot-rule-card" style="border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; margin-bottom: 12px; background: #f8fafc;">
          <div style="display: flex; gap: 6px; margin-bottom: 8px;">
            <select data-rule-field="method" data-rule-idx="${ruleIdx}" style="width: 80px; font-weight: 700; font-size: 11px; flex-shrink: 0;">
              ${["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"].map((m) => `<option ${rule.method === m ? "selected" : ""}>${m}</option>`).join("")}
            </select>
            <input type="text" value="${escapeAttr(rule.pattern)}" data-rule-field="pattern" data-rule-idx="${ruleIdx}" style="flex-grow: 1; font-size: 11px; padding: 2px 6px;" placeholder="URL pattern" />
            <button type="button" class="danger-text-btn" data-delete-snapshot-rule="${ruleIdx}">Delete Rule</button>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="font-size: 10px; color: #64748b;">On overflow:</span>
            <select data-rule-field="overflow" data-rule-idx="${ruleIdx}" style="font-size: 10px; padding: 2px;">
              <option value="repeat-last" ${rule.overflow === "repeat-last" ? "selected" : ""}>Repeat last step</option>
              <option value="loop" ${rule.overflow === "loop" ? "selected" : ""}>Loop back to start</option>
            </select>
          </div>
          <div class="steps-container">
            ${stepsHtml}
          </div>
          <button type="button" data-add-snapshot-step="${ruleIdx}" class="dashed-btn">+ Add Response Step</button>
        </div>
      `;
    }).join("");

    return `
      <div style="padding: 12px;">
        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0;">
          <div style="display: flex; align-items: flex-end; gap: 12px; width: 100%;">
            <label style="font-size: 11px; font-weight: 700; flex-grow: 1; display: flex; flex-direction: column; gap: 4px; margin-bottom: 0;">
              Snapshot Name
              <input type="text" value="${escapeAttr(snapshot.name)}" data-rename-snapshot style="width: 100%; font-size: 13px; padding: 4px 8px; height: 30px; box-sizing: border-box;" />
            </label>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0;">
              <span style="font-size: 9px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Active</span>
              <label class="toggle" style="display: inline-flex; height: 30px; align-items: center;" title="Activate/Deactivate Snapshot">
                <input type="checkbox" data-toggle-active-snapshot ${isActive ? "checked" : ""} />
                <span class="switch" aria-hidden="true"></span>
              </label>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0;">
              <span style="font-size: 9px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Delete</span>
              <button type="button" data-delete-snapshot class="danger" style="font-size: 11px; height: 30px; width: 30px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; flex-shrink: 0;" title="Delete Snapshot">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2-2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
              </button>
            </div>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 8px; border-top: 1px solid #edf2f7; padding-top: 8px;">
            <button type="button" data-save-snapshot-edit class="${isSaved ? "primary saved" : "primary"}" style="flex: 1; font-size: 11px; min-height: 30px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
              ${isSaved ? `
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                Saved
              ` : `
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                Save Rules
              `}
            </button>
            <button type="button" data-cancel-snapshot-edit class="mini-btn" style="flex: 1; font-size: 11px; min-height: 30px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;">
              Reset Draft
            </button>
          </div>
        </div>
        <div class="snapshot-rules-list">
          ${rulesHtml}
        </div>
        <button type="button" data-add-snapshot-rule class="dashed-btn" style="margin-top: 8px;">+ Add Intercept Rule</button>
      </div>
    `;
  }

  function contextMenuTemplate(menu) {
    const menuWidth = 216;
    const menuHeight = menu.type === "mock-group" ? 80 : 150;
    const boundsWidth = menu.width || window.innerWidth;
    const boundsHeight = menu.height || window.innerHeight;

    if (menu.type === "mock-group") {
      const group = getMockGroups().find((g) => g.key === menu.groupKey);
      const top = Math.max(8, Math.min(menu.y, boundsHeight - menuHeight));
      const left = Math.max(8, Math.min(menu.x, boundsWidth - menuWidth - 8));
      return `
        <div class="menu-backdrop" data-close-menu></div>
        <div class="context-menu" style="left: ${left}px; top: ${top}px;" role="menu">
          <button
            type="button"
            data-delete-mock-group="${escapeAttr(menu.groupKey)}"
            role="menuitem"
          >
            <span class="menu-title" style="color: #df2222; font-weight: 800;">Delete mock rule</span>
            <span class="menu-subtitle">${group ? escapeHtml(`${group.method} ${group.pattern}`) : "Endpoint unavailable"}</span>
          </button>
        </div>
      `;
    }

    const request = state.requests.find((item) => item.id === menu.requestId);
    const source = currentRequestSource(request);
    const disabled = !request || request.status === "pending";
    const pattern = request ? mockPatternFromUrl(request.url) : "";
    const requestMethod = request ? String(request.method || "GET").toUpperCase() : "GET";
    const existingCount = request ? countMocksForEndpoint(requestMethod, pattern) : 0;
    const top = Math.max(8, Math.min(menu.y, boundsHeight - menuHeight));
    const left = Math.max(8, Math.min(menu.x, boundsWidth - menuWidth - 8));

    let buttonsHtml = "";
    if (request && source.mocked && !source.snapshotted) {
      buttonsHtml = `
        <button
          type="button"
          data-view-mock="${escapeAttr(source.mockId || "")}"
          role="menuitem"
        >
          <span class="menu-title">View mock config</span>
          <span class="menu-subtitle">Edit the active mock rule</span>
        </button>
        <button
          type="button"
          data-create-mock-from-request="${escapeAttr(menu.requestId)}"
          role="menuitem"
        >
          <span class="menu-title">Add another mock config</span>
          <span class="menu-subtitle">${escapeHtml(`${requestMethod} ${pattern}, ${existingCount} existing`)}</span>
        </button>
      `;
    } else {
      buttonsHtml = `
        <button
          type="button"
          data-create-mock-from-request="${escapeAttr(menu.requestId)}"
          ${disabled ? "disabled" : ""}
          role="menuitem"
        >
          <span class="menu-title">Add mock config</span>
          <span class="menu-subtitle">${request ? escapeHtml(`${requestMethod} ${pattern}${existingCount ? `, ${existingCount} existing` : ""}`) : "Request unavailable"}</span>
        </button>
      `;
    }

    return `
      <div class="menu-backdrop" data-close-menu></div>
      <div class="context-menu" style="left: ${left}px; top: ${top}px;" role="menu">
        ${buttonsHtml}
      </div>
    `;
  }

  function detailTemplate(request) {
    const source = requestDetailSource(request);
    return `
      <div class="detail-title">
        <span>${escapeHtml(request.method)}</span>
        <strong>${escapeHtml(request.url)}</strong>
      </div>
      <div class="meta">
        <span>Status: <strong class="${statusClass(request.status)}" style="font-weight: 700;">${escapeHtml(String(request.status))}</strong></span>
        <span>Type: ${escapeHtml(request.type)}</span>
        ${source.linkable && source.mockId
          ? `<button class="source-link" type="button" data-navigate-to-source="${escapeAttr(source.mockId)}" data-source-type="${source.snapshotted ? "snapshot" : "mock"}" title="View ${source.snapshotted ? "snapshot config" : "mock rule"}">${source.snapshotted ? "Snapshotted" : "Mocked"} ↗</button>`
          : `<span>${source.snapshotted ? "Snapshotted" : source.mocked ? "Mocked" : "Passthrough"}</span>`
        }
        <span>${Math.round(request.duration)}ms</span>
      </div>
      ${request.error ? `<p class="error">${escapeHtml(request.error)}</p>` : ""}
      ${codeBlock("Request headers", JSON.stringify(request.requestHeaders, null, 2))}
      ${codeBlock("Request body", request.requestBody || "(empty)")}
      ${codeBlock("Response headers", JSON.stringify(request.responseHeaders, null, 2))}
      ${codeBlock("Response body", request.responseText || "(empty)")}
    `;
  }

  function endpointDetailTemplate(group) {
    const selected = group.mocks.find((mock) => mock.id === state.selectedMockId) || group.mocks[0];
    return `
      <div class="endpoint-global-settings" style="border: 1px solid #d9e1ee; border-radius: 8px; padding: 10px; margin-bottom: 12px; background: #f8fafc;">
        <div style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px;">
          <label style="width: 80px; flex-shrink: 0; margin-bottom: 0;">Method
            <select data-group-field="method" data-group-key="${escapeAttr(group.key)}">
              ${["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"].map((method) => `<option ${group.method === method ? "selected" : ""}>${method}</option>`).join("")}
            </select>
          </label>
          <label style="flex-grow: 1; margin-bottom: 0;">URL contains or /regex/
            <input value="${escapeAttr(group.pattern)}" data-group-field="pattern" data-group-key="${escapeAttr(group.key)}" />
          </label>
        </div>
        <div style="display: flex; gap: 8px; align-items: flex-start;">
          <label style="flex-grow: 1; margin-bottom: 0;">Rule Group
            <input value="${escapeAttr(group.group || "")}" placeholder="e.g. User, Order (leave empty for Default)" data-group-field="group" data-group-key="${escapeAttr(group.key)}" />
          </label>
          <label style="flex-grow: 1; margin-bottom: 0;">Alias Name
            <input value="${escapeAttr(group.aliasName || "")}" placeholder="e.g. User list, Create order" data-group-field="aliasName" data-group-key="${escapeAttr(group.key)}" data-group-method="${escapeAttr(group.method)}" data-group-pattern="${escapeAttr(group.pattern)}" />
          </label>
        </div>
      </div>
      <div class="config-tabs">
        ${group.mocks.length > 1 ? group.mocks.map(configTabTemplate).join("") : ""}
        <button class="add-config-tab" type="button" data-add-config="${escapeAttr(selected.id)}">+ Config</button>
      </div>
      ${selected ? mockTemplate(selected) : ""}
    `;
  }

  function configTabTemplate(mock) {
    const active = mock.enabled ? " is-active" : "";
    const selected = mock.id === state.selectedMockId ? " is-selected" : "";
    const title = mock.name || `${mock.status} response`;
    return `
      <button class="config-tab${active}${selected}" type="button" data-select-mock="${escapeAttr(mock.id)}">
        <span>${escapeHtml(title)}</span>
        <b>${escapeHtml(String(mock.status))}</b>
      </button>
    `;
  }

  function mockTemplate(mock) {
    const isSaved = state.savedMockId === mock.id;
    const isHeadersCollapsed = state.collapsedSections.has("Mock Headers");
    const isBodyCollapsed = state.collapsedSections.has("Mock Body");

    return `
      <article class="mock-card" data-mock-card="${escapeAttr(mock.id)}">
        <label class="toggle">
          <input type="checkbox" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="enabled" ${mock.enabled ? "checked" : ""} />
          <span class="switch" aria-hidden="true"></span>
          <span>${mock.enabled ? "Active config" : "Set active"}</span>
        </label>
        <label>Config name
          <input value="${escapeAttr(mock.name || "")}" placeholder="${escapeAttr(`${mock.method} ${mock.pattern}`)}" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="name" />
        </label>
        <div class="pair">
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <span style="font-size: 12px; color: #526070;">Status</span>
            <div style="display: flex; gap: 4px; align-items: center;">
              <input type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(mock.status)}" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="status" style="flex: 1; min-width: 0; font-size: 11px; padding: 2px 4px;" />
              <div style="display: flex; gap: 2px; flex-shrink: 0;">
                <button type="button" class="quick-fill-btn" data-fill-mock-status="200" data-mock-id="${escapeAttr(mock.id)}">200</button>
                <button type="button" class="quick-fill-btn" data-fill-mock-status="404" data-mock-id="${escapeAttr(mock.id)}">404</button>
                <button type="button" class="quick-fill-btn" data-fill-mock-status="500" data-mock-id="${escapeAttr(mock.id)}">500</button>
              </div>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <span style="font-size: 12px; color: #526070;">Delay ms</span>
            <div style="display: flex; gap: 4px; align-items: center;">
              <input type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(mock.delay)}" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="delay" style="flex: 1; min-width: 0; font-size: 11px; padding: 2px 4px;" />
              <div style="display: flex; gap: 2px; flex-shrink: 0;">
                <button type="button" class="quick-fill-btn" data-fill-mock-delay="0" data-mock-id="${escapeAttr(mock.id)}">0</button>
                <button type="button" class="quick-fill-btn" data-fill-mock-delay="500" data-mock-id="${escapeAttr(mock.id)}">500</button>
                <button type="button" class="quick-fill-btn" data-fill-mock-delay="1000" data-mock-id="${escapeAttr(mock.id)}">1000</button>
              </div>
            </div>
          </div>
        </div>
        <div class="template-selector">
          <span class="template-selector-title">Template Preset</span>
          <div class="template-tabs">
            <button class="template-tab" type="button" data-template="200" data-mock-id="${escapeAttr(mock.id)}">200 OK</button>
            <button class="template-tab" type="button" data-template="404" data-mock-id="${escapeAttr(mock.id)}">404 Not Found</button>
            <button class="template-tab" type="button" data-template="500" data-mock-id="${escapeAttr(mock.id)}">500 Error</button>
          </div>
        </div>
        
        <div class="code-section${isHeadersCollapsed ? " is-collapsed" : ""}" data-section-title="Mock Headers" style="margin-top: 4px; margin-bottom: 4px;">
          <h3 data-section-toggle style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <div style="display: flex; align-items: center; gap: 4px;">
              <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="icon-chevron">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
              <span>Headers JSON</span>
            </div>
            <button type="button" class="format-btn" data-format-field="headers" data-mock-id="${escapeAttr(mock.id)}" title="Format JSON" style="margin-left: auto;">Format</button>
          </h3>
          <textarea rows="3" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="headers">${escapeHtml(JSON.stringify(mock.headers, null, 2))}</textarea>
        </div>

        <div class="code-section${isBodyCollapsed ? " is-collapsed" : ""}" data-section-title="Mock Body" style="margin-top: 4px; margin-bottom: 4px;">
          <h3 data-section-toggle style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <div style="display: flex; align-items: center; gap: 4px;">
              <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="icon-chevron">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
              <span>Response body</span>
            </div>
            <button type="button" class="format-btn" data-format-field="body" data-mock-id="${escapeAttr(mock.id)}" title="Format JSON" style="margin-left: auto;">Format</button>
          </h3>
          <textarea rows="6" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="body">${escapeHtml(mock.body)}</textarea>
        </div>
        <div class="mock-actions">
          <button type="button" class="primary${isSaved ? " saved" : ""}" data-save-mock="${escapeAttr(mock.id)}">${isSaved ? "Saved" : "Save"}</button>
          <button type="button" class="danger" data-delete-mock="${escapeAttr(mock.id)}">Delete</button>
        </div>
      </article>
    `;
  }

  function highlightJson(jsonStr) {
    if (!jsonStr) return "";
    let parsed;
    try {
      parsed = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
    } catch (_e) {
      return escapeHtml(String(jsonStr));
    }

    const formatted = JSON.stringify(parsed, null, 2);
    const regex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|(-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g;

    return formatted.replace(regex, (match, stringToken, escapedChar, colonToken, numberToken, keywordToken) => {
      if (stringToken) {
        const escapedStr = escapeHtml(stringToken);
        if (colonToken) {
          return `<span class="json-key">${escapedStr}</span>${colonToken}`;
        } else {
          return `<span class="json-string">${escapedStr}</span>`;
        }
      } else if (numberToken) {
        return `<span class="json-number">${numberToken}</span>`;
      } else if (keywordToken) {
        return `<span class="json-${keywordToken}">${keywordToken}</span>`;
      }
      return escapeHtml(match);
    });
  }

  function codeBlock(title, value) {
    const isCollapsed = state.collapsedSections.has(title);
    let contentHtml = "";
    try {
      if (value && typeof value === "string" && (value.trim().startsWith("{") || value.trim().startsWith("["))) {
        contentHtml = highlightJson(value);
      } else {
        contentHtml = escapeHtml(value);
      }
    } catch (_e) {
      contentHtml = escapeHtml(value);
    }

    return `
      <div class="code-section${isCollapsed ? " is-collapsed" : ""}" data-section-title="${escapeAttr(title)}">
        <h3 data-section-toggle>
          <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="icon-chevron">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span>${title}</span>
        </h3>
        <button type="button" class="copy-btn" data-copy-btn title="Copy to clipboard">
          <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="icon-copy">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="icon-check">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>
        <pre>${contentHtml}</pre>
      </div>
    `;
  }

  function emptyState(text) {
    return `
      <div class="empty">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
          <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
        </svg>
        <span>${escapeHtml(text)}</span>
      </div>
    `;
  }

  function panelCss() {
    return `
      :host { all: initial; color-scheme: light; }
      * { box-sizing: border-box; }
      button, input, select, textarea { font: inherit; }
      .float-button {
        align-items: center;
        background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 9999px;
        bottom: 150px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.1);
        color: #fff;
        cursor: pointer;
        display: flex;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        gap: 8px;
        height: 42px;
        padding: 0 16px;
        position: fixed;
        right: 24px;
        z-index: 2147483647;
        backdrop-filter: blur(8px);
        white-space: nowrap;
        transition: left 0.4s cubic-bezier(0.4, 0, 0.2, 1), top 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease, visibility 0.4s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        opacity: 1;
        visibility: visible;
      }
      .float-button.hidden {
        opacity: 0 !important;
        pointer-events: none !important;
        visibility: hidden !important;
        transform: scale(0.9);
      }
      .indicator-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #64748b;
        transition: background 0.3s ease, box-shadow 0.3s ease;
        flex-shrink: 0;
      }
      .indicator-dot.active {
        background: #10b981;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.8);
      }
      .float-button.tucked {
        width: 42px !important;
        min-width: 42px !important;
        overflow: hidden !important;
        padding-left: 2px !important;
        padding-right: 0 !important;
      }
      .float-button.tucked-left {
        width: 42px !important;
        min-width: 42px !important;
        overflow: hidden !important;
        flex-direction: row-reverse;
        padding-right: 2px !important;
        padding-left: 0 !important;
      }
      .float-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 10px 10px -5px rgba(0, 0, 0, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.15);
        background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      }
      .float-button:active {
        transform: translateY(0);
      }
      .float-button span { 
        font-size: 11px; 
        font-weight: 700; 
        text-transform: uppercase; 
        letter-spacing: 0.5px;
        background: rgba(255, 255, 255, 0.1);
        padding: 2px 6px;
        border-radius: 9999px;
        color: #e2e8f0;
      }
      .float-button b { color: #38bdf8; font-size: 13px; font-weight: 600; }
      .float-button small { 
        color: #94a3b8; 
        font-size: 11px; 
        border-left: 1px solid rgba(255, 255, 255, 0.15);
        padding-left: 8px;
      }
      .devtools {
        background: #f7f9fc;
        border: 1px solid #cdd7e6;
        border-radius: 8px 8px 0 0;
        bottom: 0;
        box-shadow: 0 -18px 50px rgba(10, 20, 40, .24);
        color: #18202f;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        height: 86vh;
        left: 16px;
        min-height: 520px;
        overflow: hidden;
        position: fixed;
        right: 16px;
        z-index: 2147483647;
        transform: translateY(105%);
        transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.4s ease;
        pointer-events: none;
        visibility: hidden;
      }
      .devtools.expanded {
        transform: translateY(0);
        pointer-events: auto;
        visibility: visible;
      }
      .topbar {
        align-items: center;
        background: #172033;
        color: #fff;
        display: flex;
        height: 46px;
        justify-content: space-between;
        padding: 0 12px;
      }
      .topbar div { display: flex; gap: 10px; align-items: baseline; }
      .topbar span { color: #aab8ce; font-size: 12px; }
      .topbar nav { display: flex; gap: 8px; }
      .mock-head button, .primary, .danger {
        background: #25344c;
        border: 1px solid #465771;
        border-radius: 6px;
        color: #fff;
        cursor: pointer;
        min-height: 30px;
        padding: 0 10px;
      }
      .topbar nav .icon-btn {
        align-items: center;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        color: #aab8ce;
        cursor: pointer;
        display: inline-flex;
        height: 28px;
        width: 28px;
        justify-content: center;
        padding: 0;
        transition: all 0.2s ease;
        box-sizing: border-box;
      }
      .topbar nav .icon-btn svg {
        width: 14px;
        height: 14px;
      }
      .topbar nav .icon-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.25);
        color: #fff;
      }
      .topbar nav .icon-btn.close-btn:hover {
        background: #ef4444;
        border-color: #ef4444;
        color: #fff;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(220px, .85fr) minmax(340px, 1.4fr) minmax(300px, .9fr);
        height: calc(100% - 46px);
      }
      .detail, .mock-editor {
        min-width: 0;
        overflow: auto;
      }
      .request-list {
        background: #fff;
        border-right: 1px solid #d9e1ee;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .request-items {
        flex: 1;
        overflow-y: auto;
      }
      .request-filter {
        display: flex;
        gap: 6px;
        padding: 8px;
        border-bottom: 1px solid #d9e1ee;
        background: #f8fafc;
        align-items: center;
        flex-shrink: 0;
      }
      .request-filter .search-input {
        flex: 1;
        height: 26px;
        border: 1px solid #d9e1ee;
        border-radius: 4px;
        padding: 0 8px;
        font-size: 11px;
        color: #243047;
        background: #fff;
      }
      .request-filter .search-input:focus {
        outline: none;
        border-color: #3b82f6;
      }
      .request-filter .sort-select {
        height: 26px;
        border: 1px solid #d9e1ee;
        border-radius: 4px;
        padding: 0 4px;
        font-size: 11px;
        color: #243047;
        background: #fff;
        cursor: pointer;
        width: 80px;
        flex-shrink: 0;
      }
      .request-filter .sort-select:focus {
        outline: none;
        border-color: #3b82f6;
      }
      .request-row {
        align-items: center;
        background: transparent;
        border: 0;
        border-bottom: 1px solid #edf1f6;
        color: #243047;
        cursor: pointer;
        display: grid;
        gap: 6px;
        grid-template-columns: 10px 42px minmax(0, 1fr) 42px 46px;
        min-height: 30px;
        padding: 0 8px;
        text-align: left;
        width: 100%;
      }
      .request-row:hover, .request-row.active { background: #eaf2ff; }
      .request-row.mocked .status { color: #0d7c5b; font-weight: 800; }
      .mock-dot {
        border: 1px solid #c6cfdc;
        border-radius: 999px;
        height: 6px;
        width: 6px;
      }
      .request-row.mocked .mock-dot {
        background: #18a67d;
        border-color: #18a67d;
        box-shadow: 0 0 0 3px rgba(24, 166, 125, .14);
      }
      .method {
        color: #9b3f23;
        font-size: 11px;
        font-weight: 800;
      }
      .url {
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status, .duration {
        color: #5e6a7b;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .status-2xx { color: #0d7c5b !important; font-weight: 700; }
      .status-4xx { color: #d97706 !important; font-weight: 700; }
      .status-5xx { color: #dc2626 !important; font-weight: 700; }
      .status-pending { color: #8a95a5 !important; }
      .status-other { color: #5e6a7b !important; }
      .detail {
        background: #f7f9fc;
        border-right: 1px solid #d9e1ee;
        padding: 14px;
      }
      .detail-title {
        align-items: center;
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
      }
      .detail-title span {
        background: #e8eef8;
        border-radius: 5px;
        color: #9b3f23;
        font-size: 12px;
        font-weight: 800;
        padding: 5px 7px;
      }
      .detail-title strong {
        overflow-wrap: anywhere;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 14px;
      }
      .meta span {
        background: #fff;
        border: 1px solid #d9e1ee;
        border-radius: 5px;
        color: #526070;
        font-size: 12px;
        padding: 5px 8px;
      }
      .meta .source-link {
        background: #ecfdf5;
        border: 1px solid #6ee7b7;
        border-radius: 5px;
        color: #047857;
        font-size: 12px;
        padding: 5px 8px;
        cursor: pointer;
        font-weight: 600;
        transition: all 0.15s ease;
        font-family: inherit;
      }
      .meta .source-link:hover {
        background: #d1fae5;
        border-color: #34d399;
        color: #065f46;
      }
      .error { color: #b42318; font-weight: 700; }
      .code-section { position: relative; margin-bottom: 14px; }
      .code-section .copy-btn {
        position: absolute;
        top: 0;
        right: 0;
        background: transparent;
        border: none;
        color: #64748b;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
      }
      .code-section .copy-btn svg {
        width: 12px;
        height: 12px;
      }
      .code-section .copy-btn .icon-copy { display: block; }
      .code-section .copy-btn .icon-check { display: none; }
      .code-section .copy-btn:hover {
        background: #eff6ff;
        color: #3b82f6;
      }
      .code-section .copy-btn.copied {
        color: #16a34a;
        background: #f0fdf4;
      }
      .code-section .copy-btn.copied .icon-copy { display: none; }
      .code-section .copy-btn.copied .icon-check { display: block; }
      .code-section h3 {
        color: #526070;
        font-size: 11px;
        margin: 0 0 6px;
        text-transform: uppercase;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        user-select: none;
      }
      .code-section h3:hover {
        color: #2563eb;
      }
      .code-section .icon-chevron {
        width: 10px;
        height: 10px;
        transition: transform 0.15s ease;
        transform: rotate(90deg);
        flex-shrink: 0;
      }
      .code-section.is-collapsed .icon-chevron {
        transform: rotate(0deg);
      }
      .code-section.is-collapsed pre {
        display: none;
      }
      .code-section.is-collapsed textarea, .code-section.is-collapsed .format-btn {
        display: none;
      }
      .code-section.is-collapsed .copy-btn {
        display: none;
      }
      pre {
        background: #111827;
        border-radius: 4px;
        color: #dce7f7;
        font-size: 12px;
        line-height: 1.55;
        margin: 0;
        max-height: 260px;
        overflow: auto;
        padding: 10px;
        white-space: pre-wrap;
        word-break: break-all;
        overflow-wrap: anywhere;
      }
      pre::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      pre::-webkit-scrollbar-track {
        background: transparent;
        border-radius: 0 4px 4px 0;
      }
      pre::-webkit-scrollbar-thumb {
        background: #374151;
        border-radius: 999px;
      }
      pre::-webkit-scrollbar-thumb:hover {
        background: #4b5563;
      }
      .json-key {
        color: #38bdf8;
        font-weight: 600;
      }
      .json-string {
        color: #34d399;
      }
      .json-number {
        color: #fbbf24;
      }
      .json-boolean {
        color: #c084fc;
        font-weight: 600;
      }
      .json-null {
        color: #94a3b8;
        font-style: italic;
      }
      .mock-editor {
        background: #fff;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
      }
      .tab-content {
        display: grid;
        min-height: 0;
        height: 100%;
      }
      .tab-content.mocks-content {
        grid-template-rows: auto auto minmax(0, 1fr);
      }
      .tab-content.snapshots-content {
        grid-template-rows: auto minmax(0, 1fr);
      }
      .mock-group-tabs {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        background: #f8fafc;
        border-bottom: 1px solid #d9e1ee;
        overflow-x: auto;
      }
      .mock-group-tab {
        padding: 4px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #fff;
        color: #475569;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        white-space: nowrap;
        transition: all 0.2s ease;
      }
      .mock-group-tab:hover {
        background: #f1f5f9;
        border-color: #cbd5e1;
        color: #1e293b;
      }
      .mock-group-tab.active {
        background: #1e293b;
        border-color: #1e293b;
        color: #fff;
        font-weight: 600;
      }
      .mock-head {
        align-items: center;
        border-bottom: 1px solid #d9e1ee;
        box-sizing: border-box;
        display: flex;
        gap: 8px;
        height: 46px;
        justify-content: space-between;
        min-height: 46px;
        padding: 8px 12px;
      }
      .mock-head strong {
        flex: 0 0 auto;
      }
      .mock-head.selection-mode {
        background: #e0f2fe;
        border-bottom-color: #bae6fd;
      }
      .mock-head-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        justify-content: flex-end;
      }
      .mock-head.selection-mode .mock-head-actions {
        align-items: center;
        justify-content: space-between;
        width: 100%;
      }
      .mock-head-actions button {
        font-size: 12px;
        min-height: 28px;
        padding: 0 8px;
      }
      .mock-head-actions button:disabled {
        cursor: not-allowed;
        opacity: .45;
      }
      .mock-head-actions .action-select-btn {
        background: #eff6ff;
        border-color: #93c5fd;
        color: #1d4ed8;
        font-weight: 700;
      }
      .mock-head-actions .action-select-btn:hover {
        background: #dbeafe;
        border-color: #60a5fa;
        color: #1e40af;
      }
      .mock-head-actions .action-add-btn {
        background: #ecfdf5;
        border-color: #86efac;
        color: #047857;
        font-weight: 700;
      }
      .mock-head-actions .action-add-btn:hover {
        background: #d1fae5;
        border-color: #34d399;
        color: #065f46;
      }
      .mock-head-actions .action-import-btn {
        background: #fffbeb;
        border-color: #fcd34d;
        color: #a16207;
        font-weight: 700;
      }
      .mock-head-actions .action-import-btn:hover {
        background: #fef3c7;
        border-color: #f59e0b;
        color: #854d0e;
      }
      .mock-head-actions .action-export-btn {
        background: #f5f3ff;
        border-color: #c4b5fd;
        color: #6d28d9;
        font-weight: 700;
      }
      .mock-head-actions .action-export-btn:hover {
        background: #ede9fe;
        border-color: #a78bfa;
        color: #5b21b6;
      }
      .mock-head-actions .selection-cancel-btn {
        background: #f8fafc;
        border-color: #cbd5e1;
        color: #475569;
        font-weight: 700;
      }
      .mock-head-actions .selection-cancel-btn:hover {
        background: #e2e8f0;
        border-color: #94a3b8;
        color: #334155;
      }
      .mock-head-actions .select-all-btn {
        background: #e0f2fe;
        border-color: #7dd3fc;
        color: #0369a1;
        font-weight: 700;
      }
      .mock-head-actions .select-all-btn:hover {
        background: #bae6fd;
        border-color: #38bdf8;
        color: #075985;
      }
      .mock-head-actions .bulk-delete-btn {
        background: #dc2626;
        border-color: #dc2626;
        color: #fff;
        font-weight: 800;
      }
      .mock-head-actions .bulk-delete-btn:hover {
        background: #b91c1c;
        border-color: #b91c1c;
        color: #fff;
      }
      .mock-layout {
        display: grid;
        grid-template-rows: minmax(120px, .42fr) minmax(220px, .58fr);
        min-height: 0;
      }
      .mock-list {
        background: #fbfcfe;
        border-bottom: 1px solid #d9e1ee;
        min-height: 0;
        overflow: auto;
      }
      .mock-detail {
        min-height: 0;
        overflow: auto;
        padding: 12px;
      }
      .mock-row {
        align-items: center;
        background: transparent;
        border: 0;
        border-bottom: 1px solid #edf1f6;
        box-sizing: border-box;
        color: #243047;
        cursor: pointer;
        display: grid;
        gap: 8px;
        grid-template-columns: 10px minmax(0, 1fr) 42px;
        height: 44px;
        min-height: 44px;
        padding: 7px 10px;
        text-align: left;
        width: 100%;
      }
      .mock-row:hover, .mock-row.active {
        background: #eaf2ff;
      }
      .mock-row.selection-active {
        grid-template-columns: 16px 10px minmax(0, 1fr) 42px;
      }
      .mock-row.selection-active.active:not(.selected) {
        background: transparent;
      }
      .mock-row.selection-active:hover,
      .mock-row.selected {
        background: #eef6ff;
      }
      .row-select-checkbox {
        align-self: center;
        cursor: pointer;
        justify-self: center;
        height: 13px;
        margin: 0;
        width: 13px;
      }
      .rule-dot {
        background: #c3ccd9;
        border-radius: 999px;
        height: 7px;
        width: 7px;
      }
      .mock-row.enabled .rule-dot {
        background: #18a67d;
      }
      .rule-main {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .rule-main strong {
        color: #9b3f23;
        font-size: 11px;
        line-height: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rule-main em {
        color: #526070;
        font-size: 12px;
        font-style: normal;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rule-status {
        color: #0d7c5b;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        font-weight: 800;
        text-align: right;
      }
      .mock-card {
        border: 1px solid #d9e1ee;
        border-radius: 8px;
        display: grid;
        gap: 9px;
        padding: 10px;
      }
      .mock-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .primary {
        background: #1e293b;
        border-color: #334155;
        color: #f8fafc;
        min-width: 72px;
        font-weight: 600;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .primary:hover {
        background: #334155;
        border-color: #475569;
        color: #fff;
      }
      .primary.saved {
        background: #0d9488;
        border-color: #0d9488;
        color: #fff;
      }
      .primary.saved:hover {
        background: #0f766e;
        border-color: #0f766e;
      }
      .endpoint-title {
        border: 1px solid #d9e1ee;
        border-radius: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        padding: 10px;
        overflow: hidden;
      }
      .endpoint-title strong {
        color: #9b3f23;
        font-size: 12px;
        flex-shrink: 0;
      }
      .endpoint-title span {
        color: #243047;
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
      }
      .config-tabs {
        display: flex;
        gap: 6px;
        margin-bottom: 10px;
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .config-tab, .add-config-tab {
        align-items: center;
        background: #fff;
        border: 1px solid #d9e1ee;
        border-radius: 8px;
        color: #243047;
        cursor: pointer;
        display: inline-grid;
        flex: 0 0 auto;
        gap: 4px;
        grid-template-columns: minmax(36px, max-content) auto;
        min-height: 22px;
        max-width: 170px;
        padding: 2px 8px 2px 18px;
        position: relative;
        text-align: left;
        font-size: 11px;
      }
      .add-config-tab {
        color: #1f6feb;
        font-size: 11px;
        font-weight: 800;
        grid-template-columns: auto;
        padding: 2px 8px;
      }
      .add-config-tab:hover {
        background: #eaf2ff;
        border-color: #a8c8f5;
      }
      .config-tab::before {
        background: #c3ccd9;
        border-radius: 999px;
        content: "";
        height: 5px;
        position: absolute;
        left: 7px;
        top: 50%;
        transform: translateY(-50%);
        width: 5px;
      }
      .config-tab.is-active {
        border-color: #18a67d;
      }
      .config-tab.is-active::before {
        background: #18a67d;
      }
      .config-tab.is-selected {
        background: #eaf2ff;
        border-color: #a8c8f5;
      }
      .config-tab span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .config-tab b {
        color: #0d7c5b;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .template-selector {
        margin-top: 10px;
        margin-bottom: 10px;
      }
      .template-selector-title {
        display: block;
        font-size: 11px;
        font-weight: 600;
        color: #475569;
        margin-bottom: 6px;
      }
      .template-tabs {
        display: flex;
        gap: 6px;
      }
      .template-tab {
        flex: 1;
        padding: 5px 8px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #fff;
        color: #475569;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        text-align: center;
        transition: all 0.2s ease;
      }
      .template-tab:hover {
        background: #f1f5f9;
        border-color: #cbd5e1;
        color: #1e293b;
      }
      .quick-fill-btn {
        background: #f1f5f9;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        color: #475569;
        cursor: pointer;
        font-size: 10px;
        font-weight: 600;
        padding: 0 6px;
        height: 30px;
        min-height: 30px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
        box-shadow: none;
      }
      .quick-fill-btn:hover {
        background: #e2e8f0;
        border-color: #94a3b8;
        color: #0f172a;
      }
      .quick-fill-btn:active {
        background: #cbd5e1;
      }

      .textarea-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
      }
      .format-btn {
        background: transparent;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        color: #475569;
        cursor: pointer;
        font-size: 10px;
        padding: 2px 6px;
        transition: all 0.2s ease;
        line-height: 1;
      }
      .format-btn:hover {
        background: #f1f5f9;
        border-color: #94a3b8;
        color: #0f172a;
      }
      .format-btn:active {
        background: #e2e8f0;
      }
      .format-btn.format-success {
        color: #0d9488;
        border-color: #0d9488;
        background: #f0fdf4;
      }
      .format-btn.format-error {
        color: #e11d48;
        border-color: #e11d48;
        background: #fff1f2;
      }
      label {
        color: #526070;
        display: grid;
        font-size: 12px;
        gap: 4px;
      }
      .toggle {
        align-items: center;
        display: flex;
        gap: 8px;
        justify-content: flex-start;
      }
      .toggle input {
        height: 1px;
        margin: 0;
        opacity: 0;
        position: absolute;
        width: 1px;
      }
      .switch {
        background: #d4dbe7;
        border: 1px solid #c5cfdd;
        border-radius: 999px;
        display: inline-flex;
        flex: 0 0 auto;
        height: 16px;
        position: relative;
        transition: background .16s ease, border-color .16s ease;
        width: 28px;
      }
      .switch::after {
        background: #fff;
        border-radius: 999px;
        box-shadow: 0 1px 2px rgba(24, 32, 47, .28);
        content: "";
        height: 12px;
        left: 1px;
        position: absolute;
        top: 1px;
        transition: transform .16s ease;
        width: 12px;
      }
      .toggle input:checked + .switch {
        background: #18a67d;
        border-color: #18a67d;
      }
      .toggle input:checked + .switch::after {
        transform: translateX(12px);
      }
      .toggle input:focus-visible + .switch {
        box-shadow: 0 0 0 3px rgba(31, 111, 235, .22);
      }
      .pair {
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr 1fr;
      }
      .triple-row {
        display: grid;
        gap: 8px;
        grid-template-columns: 1.2fr 1fr 1fr;
      }
      input, select, textarea {
        background: #fff;
        border: 1px solid #cdd7e6;
        border-radius: 6px;
        color: #18202f;
        min-height: 30px;
        padding: 6px 8px;
        width: 100%;
      }
      textarea {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        line-height: 1.45;
        resize: vertical;
        tab-size: 2;
      }
      .danger {
        background: #fef2f2;
        border-color: #fee2e2;
        color: #ef4444;
        font-weight: 600;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .danger:hover {
        background: #ef4444;
        border-color: #ef4444;
        color: #ffffff;
      }
      .danger:active {
        background: #dc2626;
        border-color: #dc2626;
      }
      .menu-backdrop {
        bottom: 0;
        left: 0;
        position: absolute;
        right: 0;
        top: 0;
        z-index: 1;
      }
      .context-menu {
        background: #fff;
        border: 1px solid #cdd7e6;
        border-radius: 8px;
        box-shadow: 0 12px 34px rgba(10, 20, 40, .22);
        min-width: 216px;
        overflow: hidden;
        padding: 4px;
        position: absolute;
        z-index: 2;
      }
      .context-menu button {
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: #18202f;
        cursor: pointer;
        display: grid;
        gap: 3px;
        padding: 8px 10px;
        text-align: left;
        width: 100%;
      }
      .context-menu button:hover {
        background: #eaf2ff;
      }
      .context-menu button:disabled {
        color: #8a95a5;
        cursor: not-allowed;
      }
      .context-menu button:disabled:hover {
        background: transparent;
      }
      .menu-title {
        font-size: 12px;
        font-weight: 800;
      }
      .menu-subtitle {
        color: #647084;
        font-size: 11px;
        max-width: 190px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .empty {
        align-items: center;
        color: #778397;
        display: flex;
        flex-direction: column;
        height: 100%;
        justify-content: center;
        padding: 20px;
        text-align: center;
        gap: 10px;
      }
      .empty-icon {
        width: 32px;
        height: 32px;
        color: #94a3b8;
      }
      .request-row.selection-active {
        grid-template-columns: 20px 10px 42px minmax(0, 1fr) 42px 46px !important;
      }
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(2px);
      }
      .modal-card {
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
        display: flex;
        flex-direction: column;
        width: 440px;
        max-width: 90%;
        overflow: hidden;
      }
      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid #e2e8f0;
      }
      .modal-header h3 {
        margin: 0;
        font-size: 14px;
        color: #1e293b;
      }
      .modal-header .close-btn {
        background: transparent;
        border: none;
        font-size: 20px;
        cursor: pointer;
        color: #94a3b8;
      }
      .modal-header .close-btn:hover {
        color: #475569;
      }
      .modal-body {
        padding: 16px;
        font-size: 12px;
      }
      .modal-footer {
        padding: 8px 16px;
        border-top: 1px solid #e2e8f0;
        display: flex;
        justify-content: flex-end;
      }
      .primary-btn {
        background: #1e293b;
        color: #fff;
        border: 1px solid #334155;
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .primary-btn:hover {
        background: #334155;
        border-color: #475569;
        color: #fff;
      }
      .secondary-btn {
        background: #fff;
        color: #475569;
        border: 1px solid #cbd5e1;
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .secondary-btn:hover {
        background: #f1f5f9;
        border-color: #cbd5e1;
        color: #1e293b;
      }
      .dashed-btn {
        width: 100%;
        padding: 6px;
        border: 1px dashed #cbd5e1;
        border-radius: 6px;
        background: #fff;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        color: #475569;
        transition: all 0.2s ease;
      }
      .dashed-btn:hover {
        background: #f8fafc;
        border-color: #94a3b8;
        color: #1e293b;
      }
      .danger-text-btn {
        background: transparent;
        border: none;
        color: #ef4444;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        padding: 2px 6px;
        border-radius: 4px;
        transition: all 0.2s ease;
      }
      .danger-text-btn:hover {
        background: #fef2f2;
        color: #dc2626;
      }
      .settings-radio-label {
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: 6px !important;
        font-size: 12px !important;
        color: #334155 !important;
        cursor: pointer;
      }
      .settings-radio-label input {
        appearance: none;
        -webkit-appearance: none;
        width: 14px !important;
        height: 14px !important;
        min-height: 14px !important;
        padding: 0 !important;
        border: 1.5px solid #cbd5e1 !important;
        border-radius: 50% !important;
        outline: none !important;
        margin: 0 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer;
        transition: all 0.2s ease;
        background: #fff !important;
        box-sizing: border-box !important;
      }
      .settings-radio-label input:checked {
        border-color: #18a67d !important;
        background: #18a67d !important;
      }
      .settings-radio-label input:checked::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #fff;
        display: block;
      }
      .settings-radio-label input:hover {
        border-color: #94a3b8 !important;
      }
      .settings-radio-label input:checked:hover {
        border-color: #118160 !important;
        background: #118160 !important;
      }
      .icon-btn.active {
        background: #e0f2fe !important;
        color: #0369a1 !important;
        border-color: #bae6fd !important;
        box-shadow: 0 0 6px rgba(3, 105, 161, 0.3);
      }
      .mode-tab:hover {
        background: #f1f5f9;
        color: #1e293b !important;
      }
      .mode-tab.active {
        border-bottom-color: #2563eb !important;
        background: #fff !important;
      }
      .mini-btn {
        border: 1px solid #cbd5e1;
        background: #fff;
        color: #475569;
        border-radius: 4px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .mini-btn:hover {
        background: #f1f5f9;
        color: #1e293b;
        border-color: #94a3b8;
      }
      .snapshot-rule-card select, .snapshot-rule-card input {
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        background: #fff;
        color: #1e293b;
        outline: none;
        transition: border-color 0.2s ease;
      }
      .snapshot-rule-card select:focus, .snapshot-rule-card input:focus {
        border-color: #2563eb;
      }
      .step-card label {
        font-weight: 600;
        color: #64748b;
      }
      .step-card input, .step-card textarea {
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        background: #fff;
        color: #1e293b;
        outline: none;
        transition: border-color 0.2s ease;
      }
      .step-card input:focus, .step-card textarea:focus {
        border-color: #2563eb;
      }
      @media (max-width: 900px) {
        .devtools { left: 0; right: 0; height: 92vh; }
        .grid { grid-template-columns: 1fr; grid-template-rows: 150px 1fr 440px; }
        .request-list, .detail { border-bottom: 1px solid #d9e1ee; border-right: 0; }
        .mock-layout { grid-template-rows: 120px 1fr; }
      }
    `;
  }

  function notify() {
    state.subscribers.forEach((subscriber) => subscriber());
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms || 0)));
  }

  function createId() {
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function stringifyBody(body) {
    if (!body) return "";
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) return "[FormData]";
    if (body instanceof Blob) return `[Blob ${body.type || "unknown"}]`;
    try {
      return JSON.stringify(body, null, 2);
    } catch (_error) {
      return String(body);
    }
  }

  function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return objectFromHeaders(headers);
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...headers };
  }

  function objectFromHeaders(headers) {
    const result = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  function parseRawHeaders(rawHeaders) {
    return String(rawHeaders || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((headers, line) => {
        const index = line.indexOf(":");
        if (index > -1) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        return headers;
      }, {});
  }

  async function readResponseText(response) {
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/octet-stream")) return "[binary response]";
    return response.text();
  }

  function safeJsonParse(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  }

  function safeParseLooseJson(text, fallback = null) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return fallback || {};
    try {
      return JSON.parse(trimmed);
    } catch (_err) {
      try {
        const parsed = new Function(`return (${trimmed});`)();
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } catch (_inner) {
        throw _inner;
      }
    }
    throw new Error("Invalid JSON");
  }

  function startEditingSnapshot(id) {
    const original = state.snapshots.find(s => s.id === id);
    if (original) {
      state.editingSnapshotDraft = JSON.parse(JSON.stringify(original));
    } else {
      state.editingSnapshotDraft = null;
    }
  }

  function statusText(status) {
    return {
      200: "OK",
      201: "Created",
      204: "No Content",
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      500: "Internal Server Error"
    }[status] || "Mocked";
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.pathname + parsed.search;
    } catch (_error) {
      return url;
    }
  }

  function mockPatternFromUrl(url) {
    return shortUrl(url) || String(url || "");
  }

  function countMocksForEndpoint(method, pattern) {
    const normalizedMethod = String(method || "GET").toUpperCase();
    return state.mocks.filter((mock) => {
      return mock.method === normalizedMethod && mock.pattern === pattern;
    }).length;
  }

  function currentRequestSource(request) {
    if (!request) return { mocked: false, snapshotted: false, mockId: "" };
    const mockId = request.mockId || "";

    if (request.snapshotted && mockId) {
      const hasSnapshotRule = state.snapshots.some((snapshot) =>
        Array.isArray(snapshot.rules) && snapshot.rules.some((rule) => rule.id === mockId)
      );
      if (hasSnapshotRule) {
        return { mocked: true, snapshotted: true, mockId };
      }
    }

    if (request.mocked && mockId && state.mocks.some((mock) => mock.id === mockId)) {
      return { mocked: true, snapshotted: false, mockId };
    }

    const pattern = mockPatternFromUrl(request.url);
    const method = String(request.method || "GET").toUpperCase();
    const currentMock = getMockGroups().find((group) => group.key === endpointKey(method, pattern))?.activeMock;
    if (currentMock) {
      return { mocked: true, snapshotted: false, mockId: currentMock.id };
    }

    return { mocked: false, snapshotted: false, mockId: "" };
  }

  function requestDetailSource(request) {
    if (!request) {
      return { mocked: false, snapshotted: false, mockId: "", linkable: false };
    }

    const mockId = request.mockId || "";
    const snapshotted = Boolean(request.snapshotted);
    const mocked = Boolean(request.mocked || snapshotted);
    let linkable = false;

    if (snapshotted && mockId) {
      linkable = state.snapshots.some((snapshot) =>
        Array.isArray(snapshot.rules) && snapshot.rules.some((rule) => rule.id === mockId)
      );
    } else if (request.mocked && mockId) {
      linkable = state.mocks.some((mock) => mock.id === mockId);
    }

    return {
      mocked,
      snapshotted,
      mockId: linkable ? mockId : "",
      linkable
    };
  }

  function endpointKey(method, pattern) {
    return `${String(method || "GET").toUpperCase()}::${String(pattern || "")}`;
  }

  function getMockGroups(mocks = state.mocks) {
    const groups = [];
    const byKey = new Map();
    mocks.forEach((mock) => {
      const key = endpointKey(mock.method, mock.pattern);
      if (!byKey.has(key)) {
        const group = {
          key,
          method: mock.method,
          pattern: mock.pattern,
          mocks: [],
          activeMock: null,
          group: mock.group || "",
          aliasName: mock.aliasName || ""
        };
        byKey.set(key, group);
        groups.push(group);
      }
      const group = byKey.get(key);
      if (!group.aliasName && mock.aliasName) group.aliasName = mock.aliasName;
      group.mocks.push(mock);
      if (mock.enabled && !group.activeMock) group.activeMock = mock;
    });
    return groups;
  }

  function getEndpointGroupForMock(mock) {
    return getMockGroups().find((group) => group.key === endpointKey(mock.method, mock.pattern));
  }

  function enforceSingleActivePerEndpoint(mocks) {
    const seenActive = new Set();
    return mocks.map((mock) => {
      const key = endpointKey(mock.method, mock.pattern);
      if (mock.enabled) {
        if (!seenActive.has(key)) {
          seenActive.add(key);
          return mock;
        } else {
          return { ...mock, enabled: false };
        }
      }
      return mock;
    });
  }

  function enforceSingleActiveForMock(mocks, activeMockId) {
    const activeMock = mocks.find((mock) => mock.id === activeMockId);
    if (!activeMock) return enforceSingleActivePerEndpoint(mocks);

    if (activeMock.enabled) {
      const activeKey = endpointKey(activeMock.method, activeMock.pattern);
      const nextMocks = mocks.map((mock) => {
        if (mock.id === activeMockId) return mock;
        if (endpointKey(mock.method, mock.pattern) === activeKey) {
          return { ...mock, enabled: false };
        }
        return mock;
      });
      return enforceSingleActivePerEndpoint(nextMocks);
    }

    return enforceSingleActivePerEndpoint(mocks);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  const api = {
    init,
    addMock(mock) {
      const nextMock = normalizeMock(mock, state.mocks.length);
      state.mocks.unshift(nextMock);
      state.selectedMockId = nextMock.id;
      saveMocks();
    },
    clearRequests() {
      state.requests = [];
      state.selectedId = null;
      notify();
    },
    getRequests() {
      return [...state.requests];
    },
    getMocks() {
      return [...state.mocks];
    }
  };

  window.MockTools = api;
})();
