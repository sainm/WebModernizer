# Step 1 — Technical validation

Everything below was measured on this machine before the implementation was committed to,
not assumed from documentation. The probe scripts were throwaway; the conclusions are encoded
in the test suite so they keep holding.

Environment: Node 22.22.2 (managed), macOS arm64, Java 21 available but unused.

---

## 1. Stack decision

The specification suggests Java 17 + Spring Boot for the backend and lists JavaScript-ecosystem
parsers for the analysis work. Those two suggestions conflict:

| Concern | Node / TypeScript | Java |
| --- | --- | --- |
| JS AST with offsets | `@babel/parser` with `ranges`, `errorRecovery` | the spec's own shortlist (TS Compiler API, ESTree) is JavaScript |
| HTML with attribute-level locations | `parse5` + `sourceCodeLocationInfo` | jsoup gives no attribute offsets |
| CSS declaration offsets | `postcss` with `source.start.offset` | no equivalent |
| JSP fragment mapping | same process, offsets never cross a boundary | needs a Node sidecar |
| Browser validation | Playwright native | via Node binding |

A Java API with a Node parser sidecar would serialize ASTs or offset maps across a process
boundary at four points. Offsets are exactly where this product must not be wrong, and the
specification forbids forcing an unsuitable parser for the sake of stack uniformity
(§3, "禁止为了追求技术统一而强行使用不适合的解析器").

**Decision:** one TypeScript stack (Node 22 + built-in `node:sqlite`, zero native build steps),
with the logical module boundaries preserved as directories. `node:sqlite` is loaded through
`createRequire` because bundlers do not yet treat it as a known builtin; that is commented at
the import site.

---

## 2. Parser probes

### 2.1 Babel — fragment offsets

```js
const base = full.indexOf('function f');
const ast = parse(full.slice(base), { ranges: true, errorRecovery: true, sourceType: 'script' });
// node.start is fragment-relative -> add base
```

Measured: `base + node.start` produced line 5, column 3 for

```
  el.attachEvent("onclick", h);
```

which is the true position in the original file. The engine therefore parses fragments
standalone and shifts every `start`/`end` by `baseOffset` once (`shiftOffsets`), instead of
relying on Babel's `startLine`/`startIndex`, whose behaviour varies with version and plugin set.

**Decoy test** (spec §18): the source

```js
// element.attachEvent("onclick", handler);
const example = 'attachEvent is deprecated';
```

produces **0** AST matches. This is asserted in `backend/test/rules.test.ts`.

### 2.2 parse5 — attribute locations

Doc and reality differ: in parse5 v7 an attribute does **not** carry `sourceCodeLocation`.
Locations live on the element:

```
element.sourceCodeLocation.attrs['onclick'] -> { startOffset, endOffset, ... }
```

Measured on `<div id="a" onclick = "go()" CLASS="X">`: the attribute location covers
`onclick = "go()"` including the spaces around `=` and the quotes, and the key keeps the
source casing (`CLASS`). The implementation therefore:

- looks attributes up case-insensitively through `attributeLocation()`,
- computes the value offset by skipping `=`, whitespace and the opening quote,
- prefers the raw source slice over the entity-decoded `attr.value`, so offsets and lengths
  keep matching the file.

This matters because inline handlers are analyzed as JavaScript programs; the finding must
point at `window.event` inside the attribute, not at the element.

### 2.3 PostCSS — declaration offsets

`decl.source.start.offset` / `end.offset` are exact and include the property name
(`"width: expression(...);"`). Two behaviours were confirmed:

- `*zoom: 1` is reported with `prop === "zoom"`; the star hack is **only** visible in the raw
  text. The hack rule therefore inspects `decl.raw`, not `decl.prop`.
- `color: red\9` keeps the backslash in `decl.value`.

Value-level positions (`where does expression( start inside the declaration`) are computed by
searching the raw slice and adding the declaration offset.

### 2.4 JSP — layered analysis, not HTML parsing

Feeding `.jsp` to an HTML parser corrupts both the tree and every offset. Chosen approach:
**equal-length masking**.

- Scriptlets, expressions, declarations, directives, EL and `jsp:` tags are overwritten with
  spaces, but `\n`/`\r` are preserved, so length and line breaks are identical.
- The masked string goes to parse5; the returned offsets are directly valid for the original.
- `<script>`, `<style>` and `onclick`-style attributes are extracted and parsed separately with
  their `baseOffset`.

Measured failure mode: `event.returnValue = <%= flag %>;` becomes
`event.returnValue =        ;` in the masked text — a syntax error, so the block would be
dropped entirely. Fix: when a masked fragment does not parse, each overlapping dynamic region
is replaced by `0` padded to the same width, and the fragment is re-parsed. Offsets are
unchanged, and any finding that overlaps the region is downgraded to `NEEDS_ANALYSIS` by the
engine, so a repaired placeholder can never be presented as safe to automate.

### 2.5 Diff

Implemented as a trimmed-LCS line diff: common prefix/suffix are stripped first, which keeps
the DP table tiny for the typical "a few edited lines in a large legacy file" case. Above
4M cells the middle block degrades to a full replacement instead of allocating an unbounded
matrix. Unified diff output with 3 lines of context is what gets persisted for audit.

---

## 3. Encoding support

`TextDecoder` on this Node build supports `shift_jis`, `euc-jp`, `iso-2022-jp`, `big5`, `gbk`,
`gb18030` (verified by decoding known byte sequences). The candidate list shipped by default is:

```
utf-8 · shift_jis · euc-jp · iso-2022-jp · utf-16le · utf-16be
```

**GBK and GB18030 are deliberately excluded from automatic detection** per the product decision
for this build. They remain available through `forceEncoding` on a project. Detection order:
BOM → declared charset (`<meta charset>`, `<%@ page pageEncoding %>`) → strict UTF-8 → heuristic
scoring that rewards hiragana/katakana and penalises control characters.

Measured: `examples/legacy-app/js/shift-jis-helper.js` (462 bytes, CRLF, Japanese comments) is
rejected by strict UTF-8, detected as Shift_JIS, decoded without replacement characters, and a
finding inside it is reported at line 7, column 5 — the true position.

---

## 4. Known limitations of the chosen approach

| Limitation | Consequence | Mitigation |
| --- | --- | --- |
| Babel `errorRecovery` still throws on some syntax errors | A badly broken script block yields no findings | Recorded as a parse problem with line/column, surfaced in the scan dashboard |
| Masked JSP regions are placeholders, not real code | Semantics of server-generated expressions are unknown | Findings overlapping them are `NEEDS_ANALYSIS` and cannot be auto-migrated |
| HTML taglib tags (`<c:if>`) keep their children but are unknown elements | Structural nesting inside taglibs may be approximate | Dynamic regions and jsp: tags are masked; findings inside taglib bodies remain correct by offset |
| No project-wide type/symbol resolution | A shared function called through an alias is not linked | Edges are labelled `INFERRED`/`UNKNOWN` instead of claiming certainty |
| `node:sqlite` is still flagged experimental | Warning printed at startup | Loaded via `createRequire`; API surface used is stable (exec/prepare/run/all/get) |
| Monaco ships all basic languages | Large bundle (~3.3 MB) | Split into its own chunk, loaded only by pages that need it |
| Playwright is not installed | Browser validation returns "unavailable" with instructions | Static validation covers post-migration checks; browser step is optional by design |

---

## 5. Verification performed

- 37 rules and 11 recipes load, no duplicate ids (import-time assertion).
- Every rule fires on a dedicated fixture (`backend/test/ruleCoverage.test.ts`); adding a rule
  without one fails the suite.
- Full scan of `examples/legacy-app`: 12 files, 99 findings, 0 parse failures, Shift_JIS detected.
- Preview → apply → static validation → rollback round trip on a temp copy of the fixture.
- Hash-mismatch guard: preview marks the item inapplicable after the file changes on disk.
- API smoke over HTTP: project create, scan start, summary, findings filter, relations, rules,
  preview, report export in three formats, SPA index and deep link.
- 83 automated tests across parser, rules, per-rule coverage, message contract, decoding, diff,
  recipes (JS / HTML / CSS), batching, storage upgrade, visual diff and the end-to-end pipeline.

---

## 6. Second increment — batches and visual regression

### 6.1 Batch semantics for migrations

Several findings in one file are applied with a single write, so they already shared a
before/after hash pair. That fact was invisible in the audit trail and in the UI, which made a
partial rollback look possible when it was not. Each execution row now carries a `batch_id`
generated per file write:

- one write = one batch = one rollback unit;
- `POST /api/migrations/batch/:id/rollback` reverts the whole batch and reports how many
  findings it affected;
- rolling back a single row of a batch delegates to the batch, because restoring the file
  reverts its siblings regardless.

Measured on the fixture: two `SAFE` findings in `js/legacy-events.js` execute into one batch,
produce `event.target` and `stopPropagation()`, roll back to a byte-identical file, and return
both findings to `READY_FOR_MIGRATION`. A second rollback answers `Already rolled back`.

### 6.2 Schema upgrade, and the bug the upgrade path exposed

Adding a column to SQLite means `ALTER TABLE`, which is not idempotent and is not expressible as
`ADD COLUMN IF NOT EXISTS`. The store therefore inspects `PRAGMA table_info` and adds the column
only when missing.

The first implementation also put `CREATE INDEX ... ON migration_execution(batch_id)` into the
schema block. On a fresh database that worked; on an existing data directory `CREATE TABLE IF NOT
EXISTS` skipped the table, so the index creation ran before the column existed and the server
refused to start with `no such column: batch_id`. The index is now created inside the migration
step, after the column is guaranteed to exist, and `backend/test/storeUpgrade.test.ts` builds a
database with the previous release's schema to keep that path covered.

### 6.3 Visual regression

Pipeline: Playwright captures a full-page PNG at a fixed viewport, `pngjs` decodes both images,
and a pixel counts as changed when any channel differs by more than 12. The threshold exists
because anti-aliasing alone makes otherwise identical renders differ; a size change is always
reported as a mismatch, since a collapsed layout is exactly what this check is for.

Baseline rules: the first capture for a `(project, pageKey)` pair becomes the baseline and is
reported as `baselineCreated`, never as a pass. Baselines are stored under
`data/visual/<projectId>/<pageKey>/baseline.png`; screenshots are returned to the UI as inline
data URLs so no file path is ever exposed over HTTP.

Measured on this machine (Chromium 1234 via `WEBLIFT_CHROMIUM_PATH`):

| Page | Capture | Re-run diff |
| --- | --- | --- |
| `/` (overview) | 1280×900, 1.3 s | 0 px / 1 152 000 |
| `/findings` | 1280×900 | 0 px |
| `/migration` | 1280×900 | 0 px |

The captures were also used to review the UI itself, which is how four defects were found and
fixed: bar-chart fills were invisible (inline `span` ignoring width/height), the code viewer
opened at line 1 instead of the finding (Monaco `automaticLayout` resetting the scroll position
after the initial reveal), the confidence badge printed the raw enum, and the evidence table
showed `touchesDynamicRegion` as a duplicate raw key.

---

## 7. Third increment — multi-file transactions

The earlier design wrote one file per batch and reported failures per file. That left a real
hole: a plan spanning three files could leave the first one migrated and the third untouched,
with nothing but a failure list to explain the inconsistency.

`execute()` is now a two-phase transaction:

1. **prepare** — for every file: verify the SHA-256 captured at preview time, copy a backup and
   verify it, apply the edits in memory, re-parse the result and reject hard syntax errors.
   Nothing is written in this phase.
2. **commit** — write each prepared file atomically (temp file + rename, permissions preserved).
   If any write throws, the files already written are restored from their backups in reverse
   order and the whole call reports `aborted`.

Two distinctions carry the semantics:

- **A finding that fails its preconditions is excluded**, not fatal — the user selected more
  than the recipes can prove, and the rest should still be applicable.
- **A file that changed after the scan aborts the transaction**, because the plan the user
  confirmed was computed against a state that no longer exists. This is why `MigrationPlanItem`
  carries `staleFile` instead of relying on the wording of a blocked reason.

Rollback follows the same hierarchy: `session` (one execute call, all files) ⊃ `batch` (one file
write) ⊃ execution row. Rolling back one row reverts its session, because that is what actually
happens on disk. Every file is hash-checked before any file is restored, so a session where one
file drifted is refused outright rather than half-restored.

Measured on the fixture (two files in one call: `css/main.css` + `js/legacy-events.js`):

| Check | Result |
| --- | --- |
| executions | 2 · one `session`, two `batch` ids |
| rollback session | 2 findings reverted, both files byte-identical |
| second rollback | refused: `Already rolled back` |
| file edited after scan | `aborted: true`, 0 executions, healthy file untouched, 0 history rows |
| rollback after a later manual edit | refused: `changed after the migration` |

The regression suite gained `backend/test/transaction.test.ts` (4 cases); one of them caught the
same class of bug as before — an index created in the schema block on a column that an upgraded
database does not have yet.
