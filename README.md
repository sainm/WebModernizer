# WebLift

IE → Chrome migration toolkit. Phase one focuses on one thing and does it properly:
**find the exact lines that will break on Chrome, explain why, and prove which ones can be
rewritten safely.**

Not a grep wrapper, and not an LLM summariser. Scanning is deterministic, every finding is
traceable to a file/line/column, and every automated rewrite is gated by re-verified
preconditions, a backup and a post-write syntax check.

```
Projects → Scan → Dashboard → Findings (evidence + source) → Migration (diff → apply) → Validation → Report
```

---

## Quick start

```bash
# 1. install (Node >= 22.5, no native build steps)
npm install

# 2. build API + UI
npm run build

# 3. run: API on :8787, UI served from the same port
npm start
#    → http://localhost:8787

# development instead of the built UI
npm run dev            # API :8787 + Vite :5173
```

Scan the bundled legacy fixture from the CLI:

```bash
npm run build:api
node backend/dist/cli/scan.js --project examples/legacy-app --name "Legacy Orders"

# hostile corpus: minified JS, BOM, CRLF, Shift_JIS, 40 JSP modules,
# 1 200 CSS rules with hacks, malformed HTML
npm run stress
```

Expected on the fixture: **12 files, 96 findings, 41 high risk, 31 auto-convertible (10 safe, 21 conditional),
4 automatable-but-not-yet-implemented, 7 recipe-blocked, 44 needing judgement, 10 unsupported**.

### Optional: visual regression

Browser-based checks stay optional so a scan never depends on a browser install.

```bash
npm i -D playwright && npx playwright install chromium   # one-off
# air-gapped or pinned browser instead:
WEBLIFT_CHROMIUM_PATH="/path/to/chrome" npm start
```

With that in place, the Migration workspace can capture a page, store it as the baseline
for a page key, and later report the share of differing pixels. The first capture for a
page *becomes* the baseline instead of pretending to be a pass.

### Tests

```bash
npm test        # 276 tests: parser, rules, per-rule coverage, rule metadata, message contract,
                #            decoding, encoding write-back, diff, recipes, batching, storage upgrade,
                #            visual diff, ignore rules, incremental reuse, crash recovery,
                #            manual fix verification, removed-API detection, doc drift,
                #            cross-process project locks, strict FIFO lock queue,
                #            remaining IE-only detection, handler signature migration,
                #            cross-file handler migration, inline handler calls,
                #            cross-file inline calls, handlers with existing parameters,
                #            inline attribute window.event, nested handler helpers,
                #            reusing an existing event parameter, event.button numbering,
                #            srcUrn / recordset / setExpression detection, filter opacity
```

The suite includes the case the specification calls out explicitly: text that only *looks*
like an IE API call inside a comment or a string literal must not be reported.

---

## What phase one actually does

| Capability | Status |
| --- | --- |
| Local project registry, no upload | done |
| File discovery with symlink/traversal guards, binary and size filtering | done |
| HTML, JavaScript, CSS parsing with source locations | done |
| JSP: layered analysis of the static fragments, dynamic regions masked | done |
| 62 IE-compatibility rules (JS/DOM/HTML/CSS/ActiveX/dynamic code) | done |
| Scan pipeline with phases, SSE progress, cancel, persistence | done |
| Crash-resumable scans: atomic batches during the run, stale RUNNING runs reclaimed, prefix reused | done |
| Manual fix verification: mark fixed in code, next comparable scan records VALIDATED / VALIDATION_FAILED | done |
| Cross-process project lock: waiters take tickets and acquire strictly in FIFO order, up to 30 s (`WEBLIFT_LOCK_WAIT_MS`); dead owners/waiters reclaimed | done |
| Dashboard, findings explorer with 3-pane layout + Monaco source view | done |
| Cross-file reference graph with CONFIRMED / INFERRED / UNKNOWN edges | done |
| 14 migration recipes with preview diff, hash-verified apply, batch rollback | done |
| Function-level handler migration: inject event first and replace window.event, including in a nested helper called synchronously, keeping parameters and arguments in order | done |
| Cross-file handler migration: a function defined in a shared file and registered by reference in another file | done |
| Inline handler calls: same-file or cross-file, with cross-file call sites linked as companions in one multi-file plan | done |
| Handlers with existing parameters: inline-only call sites get event inserted first; addEventListener/on* handlers reuse their first parameter | done |
| Inline handler attributes: replace window.event with the event argument the attribute already receives, then unlock the property recipes | done |
| IE event.button numbering: left/middle literal comparisons are rewritten to Chrome 0/1; reads and bitmask tests stay manual | done |
| Alpha-only IE filter conversion: `alpha(opacity=N)` / MS Alpha progid becomes `opacity: N/100` | done |
| Detection for event.srcUrn, event.recordset and style.setExpression/removeExpression | done |
| Static validation after migration | done |
| Encoding-faithful write-back for non-UTF-8 sources (Shift_JIS, EUC-JP, ISO-2022-JP, UTF-16, UTF-8 BOM) | done |
| Multi-file transactions: one execute() = one session, all-or-nothing, one rollback | done |
| Project-level ignore rules (rule + path glob, mandatory reason, impact preview, retro-apply) | done |
| Scan comparison: fixed / introduced / unchanged against a baseline scan | done |
| Re-evaluating a stored scan after enabling/disabling rules (reversible) | done |
| Findings grouped by the project's configured modules (dashboard + filter) | done |
| Rules page shows how often each rule fires in a real scan, sortable | done |
| Incremental scans: unchanged files reuse the previous results when the rule set matches | done |
| Visual regression: screenshot + pixel diff, selector masking, desktop/tablet/mobile matrix | done (optional dependency) |
| Before/after screenshots captured around a migration, stored with the execution | done (optional dependency) |
| JSON / CSV / HTML reports traceable to a scan, including migrations and verification runs | done |
| UI in Chinese, Japanese, English | done |

---

## Design rules the code follows

1. **No finding without evidence.** Every record carries `filePath`, 1-based `startLine`/`startColumn`,
   end position, `ruleId`, `evidence.kind`, `evidence.matched` and a structured `detail` map.
2. **Scanning never writes.** The scanner opens files read-only, never executes project code
   and never runs a project build script.
3. **Discovery and transformation are separate stages.** A scan produces a persisted snapshot;
   migration is a second, explicitly confirmed action.
4. **A plan lands completely or not at all.** `execute()` is two-phase: every file is
   hash-checked, backed up, edited in memory and re-parsed first; only then are files written,
   and a failed write compensates the files already written.
5. **Automation level is earned, not asserted.** A finding may only report `SAFE`/`CONDITIONAL`
   if a recipe is registered *and* the hit does not overlap a JSP dynamic region. The engine
   downgrades everything else to `MANUAL`, so the dashboard number cannot lie.
5. **Rewrite preconditions are re-checked against the current file.** Preview re-reads and
   re-parses; execution compares the SHA-256 captured at preview time and aborts on mismatch.
6. **A failed write never lands.** Files are written to a temp file, re-parsed, then renamed;
   any failure restores the backup and records a `FAILED` execution.
7. **A finished file is persisted once, atomically.** Files, findings, parse problems and
   reference facts commit in one batch, with the file row written last. A hard kill can therefore
   never leave a file that looks analysed but has lost its findings.
8. **A manual fix is a claim, not a result.** Marking a finding fixed only schedules verification;
   the next comparable scan must no longer report it, and must have parsed its file completely,
   before it becomes `VALIDATED`. Otherwise both the claim and the current occurrence become
   `VALIDATION_FAILED`.
9. **One writer per project, across processes, in queue order.** Scans and migrations take a
   database lock keyed by project, with owner pid and token. Waiters take per-project tickets and
   the lock goes to the lowest live ticket, so they start in enqueue order rather than racing. A
   second operation waits up to 30 seconds (configurable), then fails with the owner's pid and
   acquisition time instead of interleaving; a queued scan shows that reason in the UI. Dead owners
   and dead waiters are reclaimed on the next acquire.
10. **A function-level rewrite is anchored to the signature, not the body.** The handler finding
    points at the function signature; the verified whole-function range and the exact window.event
    spans travel in evidence. The scan suppresses the per-reference window.event findings for that
    handler — in-file at analysis time, cross-file in the project pass — so the dashboard counts one
    automatable unit rather than a misleading pile of manual ones. Inline `on*="fn()"` calls in the
    same file are part of the same plan: the recipe passes `event` at the call site. A cross-file
    inline call becomes its own finding linked to the definition by companion ids; selecting either
    expands the plan to the definition and every call site. A cross-file registration is evidence
    too: preview refuses if the registration file or any call-site file changed since the scan.

---

## Architecture

Single TypeScript stack, module boundaries mirroring the logical design:

```
backend/src/
  model/            domain types shared by every layer
  parser/           jsParser · htmlParser · cssParser · jspAnalyzer · lineIndex
  analysis/         engine (rule runner) · rules/ (js, html, css, dynamic) · projectReferences
  recipes/          transformation recipes + registry
  core/             scanner · orchestrator · diff · migration · validation · report · textDecode
  storage/          SQLite schema + repositories (projects, scans, findings, executions, audits)
  server/           REST API + SSE
  cli/              headless scan command
web/src/            React 18 + Vite + Monaco + React Flow, i18n zh/ja/en
examples/legacy-app  realistic JSP/CSS/JS fixture, including a Shift_JIS file
```

**Why Node rather than Java for the backend.** The specification's own parser shortlist
(TypeScript Compiler API, ESTree parsers) and the HTML/CSS/JSP requirements are JavaScript
ecosystem tools. A Java service would need a Node sidecar and would serialise ASTs and offsets
across a process boundary at four different points, which is exactly where location bugs come
from. Details, including what was validated before committing to this stack, are in
[`docs/TECH-VALIDATION.md`](docs/TECH-VALIDATION.md).

---

## Source location model

One rule, applied everywhere: parsers produce offsets, and a single `LineIndex` converts them
to 1-based line/column. Embedded fragments (a `<script>` block, an `onclick` attribute, a JSP
page) are parsed with a `baseOffset`, so a finding in `index.jsp` points at the `.jsp` file and
the real line — never at a temporary extracted snippet.

JSP is handled by equal-length masking: server-side regions are replaced by spaces while
newlines are preserved, so the HTML tree and every offset stay valid. Fragments that intersect
a masked region are downgraded to `NEEDS_ANALYSIS` and can never be auto-migrated.

---

## Text encodings

Legacy Japanese and Chinese sources are frequently not UTF-8, and a mis-decoded file silently
destroys every reported column. Decoding therefore happens once, before parsing:

- BOM → declared `charset` / `pageEncoding` → strict UTF-8 → heuristic scoring (Shift_JIS, EUC-JP,
  ISO-2022-JP, UTF-16LE/BE).
- The chosen encoding is stored per file and shown in the UI and report.
- Migrations encode the edited text back in that same encoding (iconv-lite for Windows-31J,
  EUC-JP and UTF-16; encoding-japanese for ISO-2022-JP, which iconv-lite does not provide) and
  refuse the edit unless decoding the result reproduces the text exactly. BOMs and line endings
  are preserved.
- **GBK / GB18030 are intentionally excluded** from the default candidate list. They can still be
  forced per project with `forceEncoding`, but they are not auto-detected.

`examples/legacy-app/js/shift-jis-helper.js` is a real Shift_JIS file, and a test asserts it is
detected and that findings inside it land on the correct line.

---

## Security posture

- Scanning is read-only; project JavaScript is never executed, build scripts are never run.
- The API binds `127.0.0.1` and grants CORS to loopback origins only; there is no authentication, so
  exposing it (`WEBLIFT_HOST=0.0.0.0`) is a deliberate act. Writes from a foreign `Origin` are refused.
- Every path is resolved and checked against the project root; symlinks are never followed.
- Source viewing is limited to files that belong to the scan being viewed.
- Migration creates a hash-verified backup under `data/backups/<executionId>/` before writing.
- Migration applies the plan that was previewed: the client echoes the plan's digest and the server
  refuses anything that no longer matches, instead of recomputing a fresh set of edits.
- Non-UTF-8 files are rewritten in their detected encoding, and only when the edited text
  survives a strict round trip through that encoding. An unrepresentable character blocks the
  edit instead of being substituted; a file whose encoding has no encoder is refused.
- Deleting a project removes the database record only, never the source tree.
- Rollback refuses to run when the file changed after the migration (that would discard newer edits).

---

## Acceptance mapping

| # | Criterion | Where |
| --- | --- | --- |
| 1 | Scan a given local legacy project | `POST /api/projects/:id/scans`, CLI |
| 2 | Classify the covered IE issues | 62 rules, `docs/RULES.md` |
| 3 | Every finding locates file + position | `analysis/engine.ts`, verified in tests |
| 4 | Evidence and recommendation per finding | `AnalysisFinding.risk/recommendation/evidence` |
| 5 | Dashboard → findings | Scan detail cards link into the explorer |
| 6 | Filter down to a specific problem | Findings explorer (severity/level/status/category/rule/path/search) |
| 7 | Confirmed page↔script references | `analysis/projectReferences.ts`, dependency view |
| 8 | Report parse failures and unknown deps | `parse_problem` table, `UNKNOWN` edges |
| 9 | Preview at least one real transformation | 17 recipes, `POST /api/migrations/preview` |
| 10 | See the diff before/after | Monaco side-by-side diff |
| 11 | No silent overwrite on failure | temp write → re-parse → rename, backup restore |
| 12 | Record migration and validation history | `migration_execution`, `finding_status_history`, `validation_run` |
| 13 | Export results | `?format=json\|csv\|html` |
| 14 | History survives a page refresh | SQLite-backed API |
| 15 | Automated tests for core behaviour | 276 tests |
| 16 | Documented build/start commands | this file |
| 17 | Works without AI | no model call anywhere in the pipeline |
| 18 | No fabricated statistics | every number is aggregated from stored rows |

---

## Documentation

- [`docs/TECH-VALIDATION.md`](docs/TECH-VALIDATION.md) — stack decisions, parser probes, measured limits
- [`docs/RULES.md`](docs/RULES.md) — generated rule catalog and recipes
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — what phase one deliberately does not do
