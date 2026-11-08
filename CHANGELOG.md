# Changelog

All notable changes to WebLift are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow `package.json`.

## [Unreleased]

_Nothing yet._

## [0.2.0] - 2026-11-08

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
- Handler migration now rewrites `window.event` inside a synchronously invoked nested declaration,
  variable-assigned function or arrow, or IIFE; returned, reassigned, passed, timer-invoked, async
  or deeper-nested helpers still block the finding.
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
- IE filter conversion (`RCP-IE-FILTER`): `alpha(opacity=N)` and the MS Alpha progid become
  `opacity: N/100`, and a simple two-color `gradient(...)` becomes
  `background-image: linear-gradient(...)`, preserving `!important`. Shadows, ARGB colors, extra
  stops and mixed filters stay manual.
- Inline `style=""` attributes are parsed declaration by declaration with file offsets, so
  `filter`, `zoom`, `-ms-` properties and `behavior` are detected there too. Their findings stay
  MANUAL because the stylesheet recipes do not edit HTML attribute ranges.
- `zoom: 1` hasLayout trigger removal (`RCP-DROP-ZOOM-ONE`): literal `1`/`1.0` declarations are
  deleted; fractional, percentage or larger values stay manual.
- Inline handler attributes that read `window.event` (`WL-JS-018` / `RCP-INLINE-HANDLER-EVENT`):
  the attribute already receives `event`, so every reference is replaced in place, and after a
  rescan the `srcElement`/`returnValue`/`cancelBubble` recipes apply to the inline event.
- The migration page auto-selects every item of a companion plan, so the reviewed plan hash covers
  the whole group.
- A reviewed migration plan is bound to its execution by `planHash`: the client echoes the plan's
  digest and the server recomputes it, refusing to write anything when the plan changed.
- Write-ahead transaction claims: `migration_execution` rows are recorded as `PENDING` before the
  first byte is written, so a crash can be rolled back or cleared based on the file's own hash.
  The report counts only `APPLIED` rows as applied.
- Migrations and rollbacks are serialized per project in-process, and rollback is refused while a
  migration is running; a timeout or a refused plan writes nothing.
- "Since previous scan" counts resolved and newly introduced findings on every completed scan,
  shown on the scan detail and overview pages, plus a burn-down chart on the project page.
- A real HTTP-layer test suite covering health/meta, findings, encoded source viewing, path
  traversal, CORS, SSE lifecycle, trend and plan binding.
- `/api/health` and `/api/meta` report the version from `backend/package.json`; release bookkeeping
  tests guard workspace version parity, a dated changelog section and a non-empty entry.

### Changed

- The rule and recipe catalog is now 62 rules and 18 recipes; the fixture is 12 files,
  96 findings, 41 high risk, 35 auto-convertible (13 SAFE, 22 CONDITIONAL), 51 manual and 10
  unsupported.
- The API binds `127.0.0.1` by default, grants CORS to loopback origins only and refuses writes
  from any other `Origin`; `WEBLIFT_HOST` is an explicit opt-in to wider exposure.
- The automated suite is now 294 tests in 46 files, including mutation-checked guards for the new
  handler, inline-attribute, CSS, locking, plan-binding and release paths.

### Fixed

- A `forceEncoding` value this runtime cannot decode now fails the scan with a message naming the
  setting, instead of reporting `COMPLETED_WITH_WARNINGS` while marking every file "cannot read".
- A scan interrupted by SIGKILL no longer leaves the project locked or the persisted findings
  inconsistent.
- An interrupted scan reports the discovered file total and the phase it stopped in, instead of
  "48 / 48, 100 %" with an all-green phase list; SSE streams for terminal scans close after `done`.
- A fully incremental scan reports its real scanned/parsed counts instead of `0 / 11`.
- Source viewing decodes files with the encoding recorded at scan time, so Shift_JIS sources are
  readable; atomic writes preserve file permissions and re-emit the original BOM bytes.
- Rule documentation drift is caught by a test that compares `docs/RULES.md` with the source
  registry, so a stale generation step fails the suite instead of shipping.
