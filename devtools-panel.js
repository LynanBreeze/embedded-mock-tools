(function () {
  "use strict";

  const STORAGE_KEY = "embedded-devtools-mocks";
  const DB_NAME = "embedded-devtools";
  const DB_VERSION = 1;
  const STORE_NAME = "settings";
  const MOCKS_RECORD_KEY = "mocks";
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
    mockEnabled: window.localStorage.getItem("embedded-devtools-mock-enabled") !== "false",
    subscribers: new Set(),
    originalFetch: null,
    OriginalXHR: null
  };

  function init(options = {}) {
    if (state.installed) return api;
    state.installed = true;
    state.originalFetch = window.fetch ? window.fetch.bind(window) : null;
    state.OriginalXHR = window.XMLHttpRequest;
    state.useServiceWorker = options.useServiceWorker !== false && canUseServiceWorker();
    state.mocks = enforceSingleActivePerEndpoint(normalizeMocks(options.seedMocks || []));
    state.selectedMockId = null;
    installFetchInterceptor();
    installXhrInterceptor();
    mountPanel();
    hydrateMocks(options.seedMocks || []);
    setupServiceWorker();
    return api;
  }

  async function hydrateMocks(seedMocks) {
    const persistedMocks = await readPersistedMocks();
    const mocks = persistedMocks.length ? persistedMocks : normalizeMocks(seedMocks);
    state.mocks = enforceSingleActivePerEndpoint(mocks);
    state.selectedMockId = null;
    state.persistenceReady = true;
    if (state.mocks.length) persistMocks(state.mocks);
    syncServiceWorkerMocks();
    notify();
  }

  function normalizeMocks(mocks) {
    return mocks.map((mock, index) => normalizeMock(mock, index));
  }

  function normalizeMock(mock, index) {
    return {
      id: mock.id || `mock-${Date.now()}-${index}`,
      name: mock.name || "",
      enabled: mock.enabled !== false,
      method: (mock.method || "GET").toUpperCase(),
      pattern: mock.pattern || mock.url || "",
      status: Number(mock.status || 200),
      delay: Number(mock.delay || 0),
      headers: mock.headers || { "content-type": "application/json" },
      body: typeof mock.body === "string" ? mock.body : JSON.stringify(mock.body || {}, null, 2)
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

  async function readPersistedMocks() {
    try {
      const record = await readFromIndexedDb(MOCKS_RECORD_KEY);
      if (Array.isArray(record?.value)) return normalizeMocks(record.value);
      const legacyMocks = readLegacyLocalStorageMocks();
      if (legacyMocks.length) {
        await writeToIndexedDb(MOCKS_RECORD_KEY, legacyMocks);
        localStorage.removeItem(STORAGE_KEY);
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(mocks));
      } catch (_fallbackError) {
        // If both persistent stores fail, keep the in-memory state alive for this session.
      }
    }
  }

  function readLegacyLocalStorageMocks() {
    try {
      const saved = safeJsonParse(localStorage.getItem(STORAGE_KEY), null);
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
      const mock = findMock(request.method, request.url);
      addRequest(request);

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
        finishRequest(request.id, {
          status: response.status,
          duration: performance.now() - startedAt,
          responseHeaders: objectFromHeaders(response.headers),
          responseText,
          mocked,
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
        const mock = findMock(meta.method, meta.url);
        addRequest(record);

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
        mockId: mock.id
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

  function mountPanel() {
    const host = document.createElement("div");
    host.id = "embedded-devtools-host";
    const shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);

    const style = document.createElement("style");
    style.textContent = panelCss();
    const root = document.createElement("div");
    shadow.append(style, root);

    const render = () => {
      const activeElement = shadow.activeElement;
      const focusedSelector = activeElement && (
        activeElement.hasAttribute("data-search-input") ? "[data-search-input]" :
        activeElement.hasAttribute("data-status-filter") ? "[data-status-filter]" :
        (activeElement.hasAttribute("data-group-field") && activeElement.getAttribute("data-group-field") === "pattern") ? '[data-group-field="pattern"]' : null
      );
      const selectionStart = focusedSelector ? activeElement.selectionStart : null;
      const selectionEnd = focusedSelector ? activeElement.selectionEnd : null;

      root.innerHTML = state.expanded ? panelTemplate() : buttonTemplate();
      bindPanelEvents(root);

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

    if (floatBtn) {
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
        const btnHeight = rect.height || 42;

        floatBtn.style.transition = "none";
        floatBtn.style.left = `${rect.left}px`;
        floatBtn.style.top = `${rect.top}px`;
        floatBtn.style.bottom = "auto";
        floatBtn.style.right = "auto";

        floatBtn.offsetHeight;

        state.floatButtonTucked = true;
        floatBtn.classList.add("tucked");

        const viewWidth = document.documentElement.clientWidth;
        const viewHeight = document.documentElement.clientHeight;

        floatBtn.style.transition = "left 0.4s cubic-bezier(0.4, 0, 0.2, 1), top 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease";
        floatBtn.style.left = `${viewWidth - 12}px`;
        floatBtn.style.top = `${viewHeight - 80 - btnHeight}px`;
        floatBtn.style.bottom = "auto";
        floatBtn.style.right = "auto";
        floatBtn.style.opacity = "0.62";
      };

      const untuckButton = () => {
        state.floatButtonTucked = false;
        floatBtn.classList.remove("tucked");
        const rect = floatBtn.getBoundingClientRect();
        const btnWidth = rect.width || 88;
        const btnHeight = rect.height || 36;
        const viewWidth = document.documentElement.clientWidth;
        const viewHeight = document.documentElement.clientHeight;

        floatBtn.style.transition = "left 0.4s cubic-bezier(0.4, 0, 0.2, 1), top 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease";
        floatBtn.style.left = `${viewWidth - 24 - btnWidth}px`;
        floatBtn.style.top = `${viewHeight - 80 - btnHeight}px`;
        floatBtn.style.bottom = "auto";
        floatBtn.style.right = "auto";
        floatBtn.style.opacity = "1";
      };

      floatBtn.addEventListener("mouseenter", () => {
        stopIdleTimer();
        untuckButton();
      });

      floatBtn.addEventListener("mouseleave", () => {
        startIdleTimer();
      });

      startIdleTimer();
    }

    root.querySelector("[data-open]")?.addEventListener("click", () => {
      state.expanded = true;
      notify();
    });
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
          x: event.clientX,
          y: event.clientY
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
          state.selectedMockId = mockId;
          state.contextMenu = null;
          notify();
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
        state.mocks = state.mocks.filter((mock) => mock.id !== id);
        state.mocks = enforceSingleActivePerEndpoint(state.mocks);
        if (state.selectedMockId === id) state.selectedMockId = null;
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
        const group = getMockGroups().find((item) => item.key === key);
        state.selectedMockId = group?.mocks[0]?.id || null;
        notify();
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const key = button.getAttribute("data-select-endpoint");
        state.contextMenu = {
          type: "mock-group",
          groupKey: key,
          x: event.clientX,
          y: event.clientY
        };
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
    root.querySelectorAll("[data-format-field]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const mockId = btn.getAttribute("data-mock-id");
        const field = btn.getAttribute("data-format-field");
        const textarea = root.querySelector(`textarea[data-mock-id="${mockId}"][data-mock-field="${field}"]`);
        if (!textarea) return;

        try {
          const parsed = JSON.parse(textarea.value);
          
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
        window.localStorage.setItem("embedded-devtools-mock-enabled", String(state.mockEnabled));
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

    root.querySelectorAll('input[type="number"]').forEach((input) => {
      input.addEventListener("wheel", (e) => {
        e.preventDefault();
      }, { passive: false });
    });
  }

  function saveMockFromForm(root, id) {
    const detailScroller = root.querySelector(".mock-detail");
    const previousScrollTop = detailScroller?.scrollTop || 0;
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
    requestAnimationFrame(() => {
      const nextScroller = root.querySelector(".mock-detail");
      if (nextScroller) nextScroller.scrollTop = previousScrollTop;
    });
    window.setTimeout(() => {
      if (state.savedMockId !== id) return;
      state.savedMockId = null;
      notify();
      requestAnimationFrame(() => {
        const nextScroller = root.querySelector(".mock-detail");
        if (nextScroller) nextScroller.scrollTop = previousScrollTop;
      });
    }, 1500);
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

  function addConfigFromMock(sourceId) {
    const source = state.mocks.find((mock) => mock.id === sourceId) || state.mocks[0];
    if (!source) return;
    const nextIndex = countMocksForEndpoint(source.method, source.pattern) + 1;
    const mock = normalizeMock(
      {
        ...source,
        id: `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: `${source.method} ${source.pattern} #${nextIndex}`,
        enabled: true
      },
      state.mocks.length
    );
    state.mocks = enforceSingleActiveForMock([...state.mocks, mock], mock.id);
    state.selectedMockId = mock.id;
    saveMocks();
  }

  function createMockFromRequest(requestId) {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) return;
    const pattern = mockPatternFromUrl(request.url);
    const variantNumber = countMocksForEndpoint(request.method, pattern) + 1;
    const mock = normalizeMock(
      {
        name: `${request.method} ${pattern} #${variantNumber}`,
        enabled: true,
        method: request.method,
        pattern,
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
    state.selectedMockId = mock.id;
    state.contextMenu = null;
    saveMocks();
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

    return `
      <section class="devtools">
        <header class="topbar">
          <div>
            <strong>Network Mock</strong>
            <span>${state.requests.length} request${state.requests.length === 1 ? "" : "s"}</span>
          </div>
          <nav>
            <button type="button" data-clear class="icon-btn" title="Clear requests">
              <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 5L12 12"></path>
                <path d="M12 12L7 14l-4 6a1 1 0 0 0 1 1.5h8a1 1 0 0 0 1-1.2l-2-4.3z"></path>
                <path d="M8 15.5l-3.5 4.5"></path>
                <path d="M9.5 15l-1.5 5"></path>
                <path d="M11 14.5l0.5 5.5"></path>
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
            <div class="request-filter">
              <input type="text" placeholder="Filter URL..." class="search-input" data-search-input value="${escapeAttr(state.requestSearch)}" />
              <input type="text" placeholder="Status" class="search-input" data-status-filter value="${escapeAttr(state.requestSearchStatus)}" style="flex: 0 0 54px; width: 54px; text-align: center; padding: 0 4px;" />
              <select class="sort-select" data-sort-select>
                <option value="newest" ${state.requestSort === "newest" ? "selected" : ""}>Newest</option>
                <option value="oldest" ${state.requestSort === "oldest" ? "selected" : ""}>Oldest</option>
              </select>
            </div>
            <div class="request-items">
              ${displayRequests.length ? displayRequests.map(requestRow).join("") : emptyState(state.requests.length ? "No matches" : "No requests yet")}
            </div>
          </aside>
          <section class="detail">
            ${selected ? detailTemplate(selected) : emptyState("Select a request")}
          </section>
          <aside class="mock-editor">
            <div class="mock-head">
              <div style="display: flex; align-items: center; gap: 8px;">
                <strong>Mock rules</strong>
                <label class="toggle" style="margin-left: 2px;" title="Enable/Disable all mock rules">
                  <input type="checkbox" data-global-toggle-mock ${state.mockEnabled ? "checked" : ""} />
                  <span class="switch" aria-hidden="true"></span>
                </label>
              </div>
              <div class="mock-head-actions">
                <button type="button" data-add-mock title="Add mock rule">Add</button>
                <button type="button" data-import-mocks title="Import mock backup">Import</button>
                <button type="button" data-export-mocks title="Export mock backup">Export</button>
              </div>
            </div>
            <div class="mock-layout">
              <div class="mock-list">
                ${state.mocks.length ? getMockGroups().sort((a, b) => {
                  const aActive = a.activeMock ? 1 : 0;
                  const bActive = b.activeMock ? 1 : 0;
                  if (aActive !== bActive) return bActive - aActive;
                  return a.key.localeCompare(b.key);
                }).map(mockListRow).join("") : emptyState("No mock rules")}
              </div>
              <div class="mock-detail">
                ${selectedGroup ? endpointDetailTemplate(selectedGroup) : emptyState("Select a mock rule")}
              </div>
            </div>
          </aside>
        </div>
        ${state.contextMenu ? contextMenuTemplate(state.contextMenu) : ""}
      </section>
    `;
  }

  function buttonTemplate() {
    const activeMocks = state.mocks.filter((mock) => mock.enabled).length;
    let styleAttr = "";
    let tuckedClass = "";
    if (state.floatButtonTucked) {
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = document.documentElement.clientHeight;
      const btnHeight = 42;
      styleAttr = `style="left: ${viewWidth - 12}px; top: ${viewHeight - 80 - btnHeight}px; bottom: auto; right: auto; position: fixed; opacity: 0.62;"`;
      tuckedClass = " tucked";
    }
    const statusTitle = state.mockEnabled ? "Mock intercepting is active" : "Mock intercepting is paused";
    return `
      <button class="float-button${tuckedClass}" type="button" data-open ${styleAttr} title="Open Network Mock panel">
        <span class="indicator-dot ${state.mockEnabled ? "active" : ""}" title="${statusTitle}"></span>
        <span>Net</span>
        <b>${state.requests.length}</b>
        <small>${activeMocks} mock${activeMocks === 1 ? "" : "s"}</small>
      </button>
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
    const mocked = request.mocked ? " mocked" : "";
    const mockLabel = request.mocked ? "Mocked request" : "Passthrough request";
    return `
      <button class="request-row${active}${mocked}" type="button" data-request-id="${escapeAttr(request.id)}">
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
    return `
      <button class="mock-row${active}${enabled}" type="button" data-select-endpoint="${escapeAttr(group.key)}">
        <span class="rule-dot" aria-hidden="true"></span>
        <span class="rule-main">
          <strong>${escapeHtml(`${group.method} ${group.pattern || "(empty pattern)"}`)}</strong>
          <em>${group.mocks.length} config${group.mocks.length === 1 ? "" : "s"}, active: ${escapeHtml(group.activeMock?.name || group.activeMock?.status || "none")}</em>
        </span>
        <span class="rule-status ${statusClass(group.activeMock?.status)}">${escapeHtml(String(group.activeMock?.status || "-"))}</span>
      </button>
    `;
  }

  function contextMenuTemplate(menu) {
    if (menu.type === "mock-group") {
      const group = getMockGroups().find((g) => g.key === menu.groupKey);
      const top = Math.max(54, Math.min(menu.y, window.innerHeight - 80));
      const left = Math.max(12, Math.min(menu.x, window.innerWidth - 228));
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
    const disabled = !request || request.status === "pending";
    const pattern = request ? mockPatternFromUrl(request.url) : "";
    const existingCount = request ? countMocksForEndpoint(request.method, pattern) : 0;
    const top = Math.max(54, Math.min(menu.y, window.innerHeight - 150));
    const left = Math.max(12, Math.min(menu.x, window.innerWidth - 228));

    let buttonsHtml = "";
    if (request && request.mocked) {
      buttonsHtml = `
        <button
          type="button"
          data-view-mock="${escapeAttr(request.mockId || "")}"
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
          <span class="menu-subtitle">${escapeHtml(`${pattern}, ${existingCount} existing`)}</span>
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
          <span class="menu-subtitle">${request ? escapeHtml(`${pattern}${existingCount ? `, ${existingCount} existing` : ""}`) : "Request unavailable"}</span>
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
    return `
      <div class="detail-title">
        <span>${escapeHtml(request.method)}</span>
        <strong>${escapeHtml(request.url)}</strong>
      </div>
      <div class="meta">
        <span>Status: <strong class="${statusClass(request.status)}" style="font-weight: 700;">${escapeHtml(String(request.status))}</strong></span>
        <span>Type: ${escapeHtml(request.type)}</span>
        <span>${request.mocked ? "Mocked" : "Passthrough"}</span>
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
        <div style="display: flex; gap: 8px; align-items: flex-start;">
          <label style="width: 80px; flex-shrink: 0; margin-bottom: 0;">Method
            <select data-group-field="method" data-group-key="${escapeAttr(group.key)}">
              ${["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"].map((method) => `<option ${group.method === method ? "selected" : ""}>${method}</option>`).join("")}
            </select>
          </label>
          <label style="flex-grow: 1; margin-bottom: 0;">URL contains or /regex/
            <input value="${escapeAttr(group.pattern)}" data-group-field="pattern" data-group-key="${escapeAttr(group.key)}" />
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
          <label>Status
            <input type="number" min="100" max="599" value="${escapeAttr(mock.status)}" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="status" />
          </label>
          <label>Delay ms
            <input type="number" min="0" value="${escapeAttr(mock.delay)}" data-mock-id="${escapeAttr(mock.id)}" data-mock-field="delay" />
          </label>
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

  function codeBlock(title, value) {
    const isCollapsed = state.collapsedSections.has(title);
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
        <pre>${escapeHtml(value)}</pre>
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
        bottom: 80px;
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
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(8px);
        white-space: nowrap;
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
        padding-left: 2px !important;
        padding-right: 0 !important;
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
      .mock-editor {
        background: #fff;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
      }
      .mock-head {
        align-items: center;
        border-bottom: 1px solid #d9e1ee;
        display: flex;
        gap: 8px;
        justify-content: space-between;
        min-height: 46px;
        padding: 8px 12px;
      }
      .mock-head strong {
        flex: 0 0 auto;
      }
      .mock-head-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        justify-content: flex-end;
      }
      .mock-head-actions button {
        font-size: 12px;
        min-height: 28px;
        padding: 0 8px;
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
        color: #243047;
        cursor: pointer;
        display: grid;
        gap: 8px;
        grid-template-columns: 10px minmax(0, 1fr) 42px;
        min-height: 44px;
        padding: 7px 10px;
        text-align: left;
        width: 100%;
      }
      .mock-row:hover, .mock-row.active {
        background: #eaf2ff;
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
        position: fixed;
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
        position: fixed;
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
          activeMock: null
        };
        byKey.set(key, group);
        groups.push(group);
      }
      const group = byKey.get(key);
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
