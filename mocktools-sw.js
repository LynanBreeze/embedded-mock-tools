"use strict";

let mocks = [];
let activeSnapshotRules = null;
let playbackIndices = {};
let mockRulesByMethod = new Map();
let snapshotRulesByMethod = new Map();
let patternMatcherCache = new Map();
let stateReadyPromise = null;
let stateInitialized = false;

const DB_NAME = "embedded-devtools";
const DB_VERSION = 1;
const STORE_NAME = "settings";
const MOCKS_RECORD_KEY = "mocks";
const SNAPSHOTS_RECORD_KEY = "snapshots";
const ACTIVE_SNAPSHOT_ID_KEY = "active_snapshot_id";

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
    mocks = Array.isArray(event.data.mocks) ? event.data.mocks : [];
    mockRulesByMethod = buildRuleIndex(mocks);
    stateInitialized = true;
  } else if (event.data?.type === "MOCKTOOLS_UPDATE_SNAPSHOT") {
    activeSnapshotRules = Array.isArray(event.data.activeSnapshotRules) ? event.data.activeSnapshotRules : null;
    snapshotRulesByMethod = buildRuleIndex(activeSnapshotRules || []);
    playbackIndices = {};
    stateInitialized = true;
  } else if (event.data?.type === "MOCKTOOLS_RESET_PLAYBACK") {
    playbackIndices = {};
  }
});

self.addEventListener("fetch", (event) => {
  const snapshotMock = findSnapshotResponse(event.request.method, event.request.url);
  const mock = findMock(event.request.method, event.request.url);
  if (!snapshotMock && !mock) return;
  event.respondWith((async () => {
    await ensureState();
    if (snapshotMock) return mockResponse(snapshotMock);
    return mock ? mockResponse(mock) : fetch(event.request);
  })());
});

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
  const db = await openStateDb();
  const values = await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const requests = [
      store.get(MOCKS_RECORD_KEY),
      store.get(SNAPSHOTS_RECORD_KEY),
      store.get(ACTIVE_SNAPSHOT_ID_KEY)
    ];
    transaction.oncomplete = () => resolve(requests.map((request) => request.result?.value));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB read failed"));
  });
  db.close();

  const [persistedMocks, snapshots, activeSnapshotId] = values;
  mocks = Array.isArray(persistedMocks) ? persistedMocks : [];
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

function findSnapshotResponse(method, url) {
  if (!activeSnapshotRules || activeSnapshotRules.length === 0) return null;
  const rule = getRuleCandidates(snapshotRulesByMethod, method).find((r) => {
    const methodMatches = r.method === "ALL" || r.method === String(method || "GET").toUpperCase();
    return methodMatches && patternMatches(r.pattern, url);
  });
  if (!rule || !rule.responses || rule.responses.length === 0) return null;

  if (playbackIndices[rule.id] === undefined) {
    playbackIndices[rule.id] = 0;
  }
  const idx = playbackIndices[rule.id];
  let response = null;

  if (idx < rule.responses.length) {
    response = rule.responses[idx];
    playbackIndices[rule.id] = idx + 1;
  } else {
    const overflow = rule.overflow || "repeat-last";
    if (overflow === "repeat-last") {
      response = rule.responses[rule.responses.length - 1];
    } else if (overflow === "loop") {
      playbackIndices[rule.id] = 1;
      response = rule.responses[0];
    } else {
      return null;
    }
  }

  return {
    id: rule.id,
    status: response.status,
    delay: response.delay,
    headers: response.headers,
    body: response.body,
    snapshotted: true
  };
}

function findMock(method, url) {
  return getRuleCandidates(mockRulesByMethod, method).find((mock) => {
    if (!mock.enabled) return false;
    const methodMatches = mock.method === "ALL" || mock.method === String(method || "GET").toUpperCase();
    return methodMatches && patternMatches(mock.pattern, url);
  });
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
