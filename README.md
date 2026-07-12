# Embedded DevTools Mock Panel

![](https://github.com/LynanBreeze/embedded-mock-tools/blob/main/preview.jpg?raw=true)

An embedded network request interception and mock panel prototype, supporting:

- Interception of `fetch` and `XMLHttpRequest`.
- A floating button to collapse/expand the debug panel.
- A left-side request list with search filtering and newest/oldest sorting.
- A center request detail view with collapsible code blocks.
- A right-side mock rule editor.
- Real-time modification of response body, status code, delay, and headers.
- Persistent mock rule storage prioritizing IndexedDB, with `localStorage` as a fallback and migration path.

## Quick Start

Open `index.html` directly in your browser to experience the demo.

If you want the browser's native DevTools Network tab to also capture the mocked requests, you must serve the files via a local HTTP server since Service Workers do not support the `file://` protocol:

```sh
python3 -m http.server 5173
```

Then visit:

```text
http://localhost:5173/
```

To integrate into your own project:

```html
<script src="./devtools-panel.js"></script>
<script>
  window.MockTools.init({
    seedMocks: [
      {
        enabled: true,
        method: "GET",
        pattern: "/api/users",
        status: 200,
        delay: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ users: [] }, null, 2)
      }
    ]
  });
</script>
```

## URL Matching

The `pattern` property supports two matching behaviors:

- String literal: e.g., `/api/users`, matches any request URL containing this substring.
- Simple Regex: e.g., `/\/api\/users\/\d+/`, matches as a RegExp when wrapped with `/` at both ends.

## API

```js
window.MockTools.addMock(mock);
window.MockTools.clearRequests();
window.MockTools.getRequests();
window.MockTools.getMocks();
```

## Persistence

Mock configurations are stored in IndexedDB:

- Database: `embedded-devtools`
- Object Store: `settings`
- Record Key: `mocks`

If IndexedDB is not supported by the browser, it falls back to `localStorage`. Existing mock configurations from older versions saved in `localStorage` will be automatically migrated to IndexedDB during initialization.

Note that when clearing site data, both IndexedDB and `localStorage` might be deleted. The panel provides **`Export`** and **`Import`** features to backup configurations to a JSON file and restore them later.

## Native DevTools Network Integration

Under `http://localhost` or `https` environments, the panel automatically registers `mocktools-sw.js`. Any matched requests will be intercepted and resolved by the Service Worker, which enables the browser's native DevTools Network tab to show these mocked requests.

Under a `file://` protocol environment, the tool falls back to JS-only interception: requests will still appear inside the embedded panel, but they won't appear inside the browser's native Network tab due to bypassing the browser network stack.

This prototype is built with zero external dependencies, making it ideal as an SDK seed. Future updates could split this into an npm package, custom React/Vue components, or add features like HAR exports, request replay, filter searches, environment variables, and shared team configurations.
