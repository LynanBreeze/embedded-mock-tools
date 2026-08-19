# Panel execution-path audit / Panel 执行路径审计

## Scope / 范围

`devtools-panel.js` contains the Panel UI, Fetch/XHR interception, Mock and Snapshot state, persistence, Service Worker coordination, import/export, rendering helpers, and the four-method public API. `mocktools-sw.js` is treated as an integration dependency; its message and response contracts are covered from the Panel side.

`devtools-panel.js` 包含 Panel UI、Fetch/XHR 拦截、Mock/Snapshot 状态、持久化、Service Worker 协调、导入导出、渲染工具和四个公共 API。`mocktools-sw.js` 作为集成依赖处理，其消息及响应契约从 Panel 侧覆盖。

## Execution graph / 执行图

```text
init
 ├─ normalize seed state
 ├─ mount Shadow DOM panel ──> bind UI events ──> mutate state ──> notify/render
 ├─ install Fetch interceptor ──> Snapshot > Mock > Service Worker/network
 ├─ install XHR interceptor   ──> Snapshot > Mock > Service Worker/network
 ├─ hydrate persistence       ──> IndexedDB > legacy/localStorage > seed
 └─ setup Service Worker      ──> register/recover/sync > in-page fallback

Mock/Snapshot edits
 └─ normalize/validate > enforce endpoint exclusivity > persist > SW sync > render
```

## Findings likely to produce failing tests / 可能导致用例失败的发现

| Severity | Finding / 发现 | Related cases |
| --- | --- | --- |
| High | `safeParseLooseJson` and `parseHeadersInput` use `new Function` on UI-controlled text. This can execute JavaScript and can be blocked by CSP. / 对 UI 输入使用 `new Function`，存在代码执行与 CSP 兼容风险。 | PANEL-056, 074, 075 |
| High | Public `addMock` prepends an enabled Mock without calling endpoint exclusivity enforcement. / 公共 `addMock` 未执行同端点单一活动约束。 | PANEL-042, 079 |
| Medium | `getRequests` and `getMocks` copy only the array; returned record objects still reference internal objects. / 仅浅拷贝数组，调用方仍可修改内部对象。 | PANEL-079, 080 |
| Medium | Clipboard rejection has no `.catch`, which can create an unhandled promise rejection. / 剪贴板拒绝路径未捕获。 | PANEL-076 |
| Medium | `safeLocalStorageSet` and `safeLocalStorageRemove` swallow errors, so callers cannot distinguish a successful fallback from a failed fallback. / localStorage 写入错误被吞掉，调用方无法确认降级是否成功。 | PANEL-009, 010, 012, 014 |
| Medium | A successful IndexedDB write of active Snapshot ID does not clear or update an older localStorage fallback value. / IndexedDB 写入成功时不会清理旧的 localStorage 活动 ID。 | PANEL-012, 060, 066 |
| Medium | Replacing `window.XMLHttpRequest` does not copy constructor statics such as `DONE`, and there is no destroy/restore lifecycle. / 包装后的 XHR 未复制静态常量，且没有销毁/恢复机制。 | PANEL-002, 031–035 |
| Medium | Service Worker shielding patches global prototypes for the page lifetime and has no uninstall path. / Service Worker 防护永久修改全局原型，无卸载路径。 | PANEL-018, 019 |
| Low | Request bodies embedded in a `Request` object are not read unless supplied again in `initOptions.body`. / Request 对象自身正文不会被记录。 | PANEL-030 |
| Low | Unknown Snapshot overflow values bypass to Mock/network; only `repeat-last` and `loop` are explicit supported values. / 未知 overflow 值会透传，仅两个值为显式支持。 | PANEL-061 |

## Testability constraints / 可测试性约束

- Internal functions and state are closed inside an IIFE. Pure branch-level automation requires either UI-driving tests or a test-only adapter.
- Service Worker assertions require HTTP(S), a secure context, and a controllable registration scope; `file://` can validate only the in-page fallback.
- Download, clipboard, focus, scrolling, and Shadow DOM behavior require a real browser rather than a DOM-only emulator.
- Timer-sensitive paths should use fake timers for 150ms recovery, 300ms persistence debounce, 1.5s feedback, Mock delay, and floating-button idle behavior.

- 内部函数和状态封闭在 IIFE 中；分支级自动化需要 UI 驱动或仅测试构建暴露适配器。
- Service Worker 断言需要 HTTP(S)、安全上下文和可控 scope；`file://` 只能验证页面内降级。
- 下载、剪贴板、焦点、滚动和 Shadow DOM 行为需要真实浏览器。
- 150ms 恢复、300ms 持久化防抖、1.5s 反馈、Mock 延迟和按钮空闲逻辑应使用 fake timers。
