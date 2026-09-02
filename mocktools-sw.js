"use strict";

let mocks = [];
let activeSnapshotRules = null;
let playbackIndices = {};
let mockRulesByMethod = new Map();
let snapshotRulesByMethod = new Map();
let patternMatcherCache = new Map();
let mocksVersion = 0;
let stateRevision = 0;
let stateReadyPromise = null;
let stateInitialized = false;

const DB_NAME = "embedded-devtools";
const DB_VERSION = 1;
const STORE_NAME = "settings";
const MOCKS_RECORD_KEY = "mocks";
const SNAPSHOTS_RECORD_KEY = "snapshots";
const ACTIVE_SNAPSHOT_ID_KEY = "active_snapshot_id";
const MOCK_ENABLED_KEY = "mock_enabled";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "MOCKTOOLS_CLAIM_CLIENT") {
    event.waitUntil(self.clients.claim());
  } else if (event.data?.type === "MOCKTOOLS_UPDATE_MOCKS") {
    const version = Number(event.data.version || 0);
    if (version && version < mocksVersion) return;
    stateRevision += 1;
    mocksVersion = version || mocksVersion + 1;
    mocks = Array.isArray(event.data.mocks) ? event.data.mocks : [];
    mockRulesByMethod = buildRuleIndex(mocks);
    stateInitialized = true;
    event.ports[0]?.postMessage({ type: "MOCKTOOLS_MOCKS_UPDATED", version: mocksVersion });
  } else if (event.data?.type === "MOCKTOOLS_UPDATE_SNAPSHOT") {
    stateRevision += 1;
    activeSnapshotRules = Array.isArray(event.data.activeSnapshotRules) ? event.data.activeSnapshotRules : null;
    snapshotRulesByMethod = buildRuleIndex(activeSnapshotRules || []);
    playbackIndices = {};
    stateInitialized = true;
  } else if (event.data?.type === "MOCKTOOLS_RESET_PLAYBACK") {
    playbackIndices = {};
  }
});

self.addEventListener("fetch", (event) => {
  if (!stateInitialized) {
    event.respondWith(handleFetch(event.request));
    return;
  }

  const method = event.request.method;
  const url = event.request.url;

  const candidateMockRules = getRuleCandidates(mockRulesByMethod, method).filter((mock) => {
    if (!mock.enabled) return false;
    const methodMatches = mock.method === "ALL" || mock.method === String(method || "GET").toUpperCase();
    return methodMatches && patternMatches(mock.pattern, url);
  });

  const candidateSnapshotRules = (!activeSnapshotRules || activeSnapshotRules.length === 0)
    ? []
    : getRuleCandidates(snapshotRulesByMethod, method).filter((rule) => {
        const methodMatches = rule.method === "ALL" || rule.method === String(method || "GET").toUpperCase();
        return methodMatches && patternMatches(rule.pattern, url);
      });

  if (candidateMockRules.length === 0 && candidateSnapshotRules.length === 0) {
    return;
  }

  const hasPayloadMock = isPayloadMethod(method) && candidateMockRules.some((mock) => Boolean(snapshotPayloadKey(mock.requestBody)));
  const hasPayloadSnapshot = isPayloadMethod(method) && candidateSnapshotRules.some((rule) =>
    Array.isArray(rule.responses) && rule.responses.some((response) => Boolean(snapshotPayloadKey(response.requestBody)))
  );

  if (hasPayloadMock || hasPayloadSnapshot) {
    event.respondWith(handleFetch(event.request));
    return;
  }

  const snapshotMock = findSnapshotResponse(method, url, "");
  const mock = findMock(method, url, "");

  if (snapshotMock) {
    event.respondWith(mockResponse(snapshotMock));
  } else if (mock) {
    event.respondWith(mockResponse(mock));
  }
});

async function handleFetch(request) {
  if (!stateInitialized) await ensureState();
  const requestBody = isPayloadMethod(request.method) ? await readRequestBody(request) : "";
  const snapshotMock = findSnapshotResponse(request.method, request.url, requestBody);
  const mock = findMock(request.method, request.url, requestBody);
  if (snapshotMock) return mockResponse(snapshotMock);
  return mock ? mockResponse(mock) : fetch(request);
}

async function readRequestBody(request) {
  try {
    return await request.clone().text();
  } catch (_error) {
    return "";
  }
}

function ensureState() {
  if (stateInitialized) return Promise.resolve();
  if (!stateReadyPromise) {
    stateReadyPromise = loadStateFromIndexedDb().catch(() => {}).finally(() => {
      stateInitialized = true;
      stateReadyPromise = null;
    });
  }
  return stateReadyPromise;
}

async function loadStateFromIndexedDb() {
  const loadRevision = stateRevision;
  const db = await openStateDb();
  const values = await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const requests = [
      store.get(MOCKS_RECORD_KEY),
      store.get(SNAPSHOTS_RECORD_KEY),
      store.get(ACTIVE_SNAPSHOT_ID_KEY),
      store.get(MOCK_ENABLED_KEY)
    ];
    transaction.oncomplete = () => resolve(requests.map((request) => request.result?.value));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB read failed"));
  });
  db.close();

  const [persistedMocks, snapshots, activeSnapshotId, mockEnabled] = values;
  // A live page may have pushed newer rules while this read was in flight.
  // Never let the older persisted snapshot overwrite those in-memory rules.
  if (loadRevision !== stateRevision) return;
  mocks = (mockEnabled !== false && Array.isArray(persistedMocks)) ? persistedMocks : [];
  mockRulesByMethod = buildRuleIndex(mocks);
  const activeSnapshot = Array.isArray(snapshots)
    ? snapshots.find((snapshot) => snapshot.id === activeSnapshotId)
    : null;
  activeSnapshotRules = Array.isArray(activeSnapshot?.rules) ? activeSnapshot.rules : null;
  snapshotRulesByMethod = buildRuleIndex(activeSnapshotRules || []);
  playbackIndices = {};
}

function openStateDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB unavailable"));
  });
}

async function mockResponse(mock) {
  await wait(mock.delay);
  const headers = new Headers(mock.headers || {});
  headers.set("x-mocktools-mocked", "1");
  headers.set("x-mocktools-mock-id", mock.id || "");
  if (mock.snapshotted) {
    headers.set("x-mocktools-snapshotted", "1");
  }
  headers.set("Access-Control-Expose-Headers", "x-mocktools-mocked, x-mocktools-mock-id, x-mocktools-snapshotted");
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(mock.body || "", {
    status: Number(mock.status || 200),
    headers
  });
}

function findSnapshotResponse(method, url, requestBody = "") {
  if (!activeSnapshotRules || activeSnapshotRules.length === 0) return null;
  const matchingRules = getRuleCandidates(snapshotRulesByMethod, method).filter((r) => {
    const methodMatches = r.method === "ALL" || r.method === String(method || "GET").toUpperCase();
    return methodMatches && patternMatches(r.pattern, url) && Array.isArray(r.responses) && r.responses.length > 0;
  }).sort((a, b) => String(b.pattern || "").length - String(a.pattern || "").length);

  if (matchingRules.length === 0) return null;

  const payloadKey = snapshotPayloadKey(requestBody);
  let selectedRule = null;
  let selectedResponses = [];
  let isFallback = false;

  // 1. Priority: match rules/steps with exact payload
  if (payloadKey && isPayloadMethod(method)) {
    for (const rule of matchingRules) {
      const matched = rule.responses.filter((response) => snapshotPayloadKey(response.requestBody) === payloadKey);
      if (matched.length > 0) {
        selectedRule = rule;
        selectedResponses = matched;
        isFallback = false;
        break;
      }
    }
  }

  // 2. Fallback: match rules/steps with empty payload (catch-all)
  if (!selectedRule) {
    for (const rule of matchingRules) {
      const hasPayloadResponses = isPayloadMethod(method) && rule.responses.some((response) =>
        Boolean(snapshotPayloadKey(response.requestBody))
      );
      if (hasPayloadResponses) {
        const fallbackSteps = rule.responses.filter((response) => !snapshotPayloadKey(response.requestBody));
        if (fallbackSteps.length > 0) {
          selectedRule = rule;
          selectedResponses = fallbackSteps;
          isFallback = true;
          break;
        }
      } else {
        selectedRule = rule;
        selectedResponses = rule.responses;
        isFallback = false;
        break;
      }
    }
  }

  if (!selectedRule || selectedResponses.length === 0) return null;

  const effectivePayloadKey = !isFallback && payloadKey ? payloadKey : "";
  const playbackKey = `${selectedRule.id}::${effectivePayloadKey}`;
  if (playbackIndices[playbackKey] === undefined) {
    playbackIndices[playbackKey] = 0;
  }
  const idx = playbackIndices[playbackKey];
  let response = null;

  if (idx < selectedResponses.length) {
    response = selectedResponses[idx];
    playbackIndices[playbackKey] = idx + 1;
  } else {
    const overflow = selectedRule.overflow || "repeat-last";
    if (overflow === "repeat-last") {
      response = selectedResponses[selectedResponses.length - 1];
    } else if (overflow === "loop") {
      playbackIndices[playbackKey] = 1;
      response = selectedResponses[0];
    } else {
      return null;
    }
  }

  return {
    id: selectedRule.id,
    status: response.status,
    delay: response.delay,
    headers: response.headers,
    body: response.body,
    snapshotted: true
  };
}

function isPayloadMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "GET").toUpperCase());
}

function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  const sorted = {};
  Object.keys(value).sort().forEach((key) => {
    sorted[key] = canonicalizeJson(value[key]);
  });
  return sorted;
}

function normalizePayloadKey(body) {
  if (body === null || body === undefined) return "";
  if (typeof body === "object") {
    try {
      return JSON.stringify(canonicalizeJson(body));
    } catch (_error) {
      return "";
    }
  }
  const text = String(body).trim();
  if (!text) return "";
  try {
    return JSON.stringify(canonicalizeJson(JSON.parse(text)));
  } catch (_error) {
    return text;
  }
}

const snapshotPayloadKey = normalizePayloadKey;

function findMock(method, url, requestBody = "") {
  return getRuleCandidates(mockRulesByMethod, method).filter((mock) => {
    if (!mock.enabled) return false;
    const methodMatches = mock.method === "ALL" || mock.method === String(method || "GET").toUpperCase();
    const bodyMatches = !normalizePayloadKey(mock.requestBody) || normalizePayloadKey(mock.requestBody) === normalizePayloadKey(requestBody);
    return methodMatches && patternMatches(mock.pattern, url) && bodyMatches;
  }).sort((a, b) => {
    const bodySpecificity = Number(Boolean(normalizePayloadKey(b.requestBody))) - Number(Boolean(normalizePayloadKey(a.requestBody)));
    return bodySpecificity || String(b.pattern || "").length - String(a.pattern || "").length;
  })[0] || null;
}

function patternMatches(pattern, url) {
  if (!pattern) return false;
  let matcher = patternMatcherCache.get(pattern);
  if (!matcher) {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      try {
        const regex = new RegExp(pattern.slice(1, -1));
        matcher = (value) => {
          regex.lastIndex = 0;
          return regex.test(value);
        };
      } catch (_error) {
        matcher = (value) => value.includes(pattern);
      }
    } else {
      matcher = (value) => value.includes(pattern);
    }
    patternMatcherCache.set(pattern, matcher);
  }
  return matcher(url);
}

function buildRuleIndex(rules) {
  const exact = new Map();
  const all = [];
  const methods = new Set();

  rules.forEach((rule, index) => {
    const method = String(rule.method || "GET").toUpperCase();
    const entry = { rule, index };
    if (method === "ALL") {
      all.push(entry);
    } else {
      methods.add(method);
      if (!exact.has(method)) exact.set(method, []);
      exact.get(method).push(entry);
    }
  });

  const indexed = new Map();
  methods.forEach((method) => {
    indexed.set(method, exact.get(method).concat(all).sort((a, b) => a.index - b.index));
  });
  indexed.set("*", all);
  return indexed;
}

function getRuleCandidates(index, method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return (index.get(normalizedMethod) || index.get("*") || []).map((entry) => entry.rule);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

ensureState();
