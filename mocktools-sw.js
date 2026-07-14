"use strict";

let mocks = [];
let activeSnapshotRules = null;
let playbackIndices = {};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "MOCKTOOLS_UPDATE_MOCKS") {
    mocks = Array.isArray(event.data.mocks) ? event.data.mocks : [];
  } else if (event.data?.type === "MOCKTOOLS_UPDATE_SNAPSHOT") {
    activeSnapshotRules = Array.isArray(event.data.activeSnapshotRules) ? event.data.activeSnapshotRules : null;
    playbackIndices = {};
  } else if (event.data?.type === "MOCKTOOLS_RESET_PLAYBACK") {
    playbackIndices = {};
  }
});

self.addEventListener("fetch", (event) => {
  const snapshotMock = findSnapshotResponse(event.request.method, event.request.url);
  if (snapshotMock) {
    event.respondWith(mockResponse(snapshotMock));
    return;
  }
  const mock = findMock(event.request.method, event.request.url);
  if (!mock) return;
  event.respondWith(mockResponse(mock));
});

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
  const rule = activeSnapshotRules.find((r) => {
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
  return mocks.find((mock) => {
    if (!mock.enabled) return false;
    const methodMatches = mock.method === "ALL" || mock.method === String(method || "GET").toUpperCase();
    return methodMatches && patternMatches(mock.pattern, url);
  });
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
