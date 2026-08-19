# Panel semantic test suite

The repository does not contain a `panel.js` source file. The runnable panel and interception runtime are implemented by `devtools-panel.js`; therefore this suite treats that file as the system under test.

## Artifacts

- `features/panel.zh-CN.feature`: Chinese BDD specification.
- `features/panel.en.feature`: English BDD specification with matching case IDs.

Both files describe the same 80 cases. A change to one language must preserve the corresponding `@PANEL-NNN` case in the other language.

Validate bilingual parity without installing a test framework:

```sh
node tests/validate-feature-parity.mjs
```

## Coverage model

| Area | Case IDs | Principal code paths |
| --- | --- | --- |
| Initialization and rendering | 001–006 | `init`, `normalizeMock(s)`, `mountPanel`, button positioning |
| Persistence and reset | 007–014 | IndexedDB, localStorage migration/fallback, debounce, reset |
| Service Worker | 015–022 | support detection, registration, shielding, recovery, synchronization |
| Fetch interception | 023–030 | passthrough, Mock, Snapshot, SW delegation, errors, body reading |
| XHR interception | 031–035 | passthrough, Mock/Snapshot response, errors, headers/events |
| Matching and exclusivity | 036–042 | substring/regex, ALL, priority, cache, global enable, one-active rule |
| Request history and panel shell | 043–049 | history cap, filters, details, clear, open/close, floating position |
| Mock rule management | 050–057 | create/edit/config/group/template/delete/bulk/context menu |
| Snapshot management/playback | 058–066 | capture, precedence, overflow, editing, steps, activation/deletion |
| Import/export | 067–071 | Mock and Snapshot backup success/error/file-shape paths |
| Settings, rendering, utilities and API | 072–080 | settings/reset, JSON/escaping, parsing, copy, batching, public API |

## Execution levels

- **Unit/component**: normalization, matching, parsing, grouping, rendering helpers, public API semantics.
- **Browser integration**: Fetch/XHR interception, Shadow DOM interactions, clipboard/downloads, dialogs, focus/scroll restoration.
- **Secure-context integration**: Service Worker registration, controller recovery, native Network visibility.
- **Fault injection**: IndexedDB/localStorage denial, unreadable response streams, registration failures and invalid backup files.

The runtime is wrapped in an IIFE and exposes only four public methods. To automate internal branches without relying on UI details, a future test build should expose a test-only adapter under a compile-time flag. Production code must not expose mutable internal state.
