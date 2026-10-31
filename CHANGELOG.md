# Changelog

All notable changes to WebLift are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow `package.json`.

## [Unreleased]

### Added

- Encoding-faithful write-back for Shift_JIS, EUC-JP, ISO-2022-JP, UTF-16LE/BE and UTF-8 BOM
  sources, preserving the original BOM and CRLF line endings.
- Crash-resumable scans: findings are flushed in atomic batches while parsing continues, a stale
  `RUNNING` scan is reclaimed on startup, and the next run reuses the completed prefix. Per-file
  facts (references, relations and handler evidence) persist with each batch.
- Manual fix verification: marking a finding as fixed lets the next comparable scan record
  `VALIDATED` or `VALIDATION_FAILED`.
- Eight detection rules for APIs removed from modern Chromium: `runtimeStyle`,
  `createStyleSheet`, `setCapture`/`releaseCapture`, `toElement`/`fromElement`, `document.frames`,
  `document.recalc`, `showHelp` and `createPopup`.
- Six detection rules for remaining IE-only shapes: `onpropertychange`, `event.propertyName`,
  `addBehavior`/`removeBehavior`, `document.namespaces`, `element.styleSheet` and
  `window.offscreenBuffering`.
- Cross-process project lock: scans, migrations and rollbacks serialize per project, dead owners
  are reclaimed, and a contending operation waits with a visible `waitingFor` state.
- Bounded lock waiting (`WEBLIFT_LOCK_WAIT_MS`, default 30 s): a queued scan starts when the
  current writer finishes instead of failing immediately.
- Function-level handler migration (`WL-JS-017` / `RCP-HANDLER-EVENT-PARAM`): inject the event
  parameter, replace the handler's `window.event` references, and suppress the covered
  per-reference findings.
- Handler sources now include by-reference registrations in another scanned file, inline `on*`
  calls in the same file, cross-file inline calls linked as companion findings in one multi-file
  plan, and handlers with existing parameters whose call sites are all inline `on*` calls.
- Handler migration now rewrites `window.event` inside a nested helper when the handler calls it
  synchronously from its own body; returned, passed, timer-invoked, async or deeper-nested helpers
  still block the finding.
- `addEventListener` and `on*` property handlers with an existing first parameter reuse it instead
  of being rejected. `attachEvent` handlers with parameters, mixed registrations and handlers that
  are also called inline stay manual.
- IE `event.button` numbering (`WL-JS-019` / `RCP-EVENT-BUTTON`): equality comparisons against the
  left (1) or middle (4) literal become the Chrome values 0/1; reads, bitmask tests and combined
  buttons stay manual.
- Detection for `event.srcUrn`, `event.recordset` and `style.setExpression`/`removeExpression`
  (`WL-DOM-015`, `WL-DOM-016`, `WL-JS-020`); the first and third are manual, the data-binding
  recordset is unsupported.
- Strict FIFO project-lock queue: waiters take per-project tickets, only the lowest live ticket
  acquires, and timeout, cancellation or a dead process removes its ticket.
- Inline handler attributes that read `window.event` (`WL-JS-018` / `RCP-INLINE-HANDLER-EVENT`):
  the attribute already receives `event`, so every reference is replaced in place, and after a
  rescan the `srcElement`/`returnValue`/`cancelBubble` recipes apply to the inline event.
- The migration page auto-selects every item of a companion plan, so the reviewed plan hash covers
  the whole group.

### Changed

- The rule and recipe catalog is now 62 rules and 16 recipes; the fixture remains at 12 files,
  96 findings, 41 high risk, 29 auto-convertible (10 SAFE, 19 CONDITIONAL), 57 manual and 10
  unsupported.
- The automated suite is now 273 tests, including mutation-checked guards for the new handler,
  inline-attribute and locking paths.

### Fixed

- A scan interrupted by SIGKILL no longer leaves the project locked or the persisted findings
  inconsistent.
- Rule documentation drift is caught by a test that compares `docs/RULES.md` with the source
  registry, so a stale generation step fails the suite instead of shipping.
