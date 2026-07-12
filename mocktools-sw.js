"use strict";

let mocks = [];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "MOCKTOOLS_UPDATE_MOCKS") {
    mocks = Array.isArray(event.data.mocks) ? event.data.mocks : [];
  }
});

self.addEventListener("fetch", (event) => {
  const mock = findMock(event.request.method, event.request.url);
  if (!mock) return;
  event.respondWith(mockResponse(mock));
});

async function mockResponse(mock) {
  await wait(mock.delay);
  const headers = new Headers(mock.headers || {});
  headers.set("x-mocktools-mocked", "1");
  headers.set("x-mocktools-mock-id", mock.id || "");
  headers.set("Access-Control-Expose-Headers", "x-mocktools-mocked, x-mocktools-mock-id");
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(mock.body || "", {
    status: Number(mock.status || 200),
    headers
  });
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
