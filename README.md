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
```

Expected on the fixture: **12 files, 99 findings, 44 high risk, 22 auto-convertible (10 safe, 12 conditional),
4 automatable-but-not-yet-implemented, 54 needing judgement, 10 unsupported**.

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
npm test        # 146 tests: parser, rules, per-rule coverage, rule metadata, message contract,
                #            decoding, diff, recipes, batching, storage upgrade, visual diff,
                #            ignore rules, incremental reuse
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
| 42 IE-compatibility rules (JS/DOM/HTML/CSS/ActiveX/dynamic code) | done |
| Scan pipeline with phases, SSE progress, cancel, persistence | done |
| Dashboard, findings explorer with 3-pane layout + Monaco source view | done |
| Cross-file reference graph with CONFIRMED / INFERRED / UNKNOWN edges | done |
| 13 migration recipes with preview diff, hash-verified apply, batch rollback | done |
| Static validation after migration | done |
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
- **GBK / GB18030 are intentionally excluded** from the default candidate list. They can still be
  forced per project with `forceEncoding`, but they are not auto-detected.

`examples/legacy-app/js/shift-jis-helper.js` is a real Shift_JIS file, and a test asserts it is
detected and that findings inside it land on the correct line.

---

## Security posture

- Scanning is read-only; project JavaScript is never executed, build scripts are never run.
- Every path is resolved and checked against the project root; symlinks are never followed.
- Source viewing is limited to files that belong to the scan being viewed.
- Migration creates a hash-verified backup under `data/backups/<executionId>/` before writing.
- Deleting a project removes the database record only, never the source tree.
- Rollback refuses to run when the file changed after the migration (that would discard newer edits).

---

## Acceptance mapping

| # | Criterion | Where |
| --- | --- | --- |
| 1 | Scan a given local legacy project | `POST /api/projects/:id/scans`, CLI |
| 2 | Classify the covered IE issues | 42 rules, `docs/RULES.md` |
| 3 | Every finding locates file + position | `analysis/engine.ts`, verified in tests |
| 4 | Evidence and recommendation per finding | `AnalysisFinding.risk/recommendation/evidence` |
| 5 | Dashboard → findings | Scan detail cards link into the explorer |
| 6 | Filter down to a specific problem | Findings explorer (severity/level/status/category/rule/path/search) |
| 7 | Confirmed page↔script references | `analysis/projectReferences.ts`, dependency view |
| 8 | Report parse failures and unknown deps | `parse_problem` table, `UNKNOWN` edges |
| 9 | Preview at least one real transformation | 5 recipes, `POST /api/migrations/preview` |
| 10 | See the diff before/after | Monaco side-by-side diff |
| 11 | No silent overwrite on failure | temp write → re-parse → rename, backup restore |
| 12 | Record migration and validation history | `migration_execution`, `finding_status_history`, `validation_run` |
| 13 | Export results | `?format=json\|csv\|html` |
| 14 | History survives a page refresh | SQLite-backed API |
| 15 | Automated tests for core behaviour | 83 tests |
| 16 | Documented build/start commands | this file |
| 17 | Works without AI | no model call anywhere in the pipeline |
| 18 | No fabricated statistics | every number is aggregated from stored rows |

---

## Documentation

- [`docs/TECH-VALIDATION.md`](docs/TECH-VALIDATION.md) — stack decisions, parser probes, measured limits
- [`docs/RULES.md`](docs/RULES.md) — generated rule catalog and recipes
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — what phase one deliberately does not do
