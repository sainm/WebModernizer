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

- 42 rules and 13 recipes load, no duplicate ids (import-time assertion).
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

---

## 8. Fourth increment — project-level ignore rules

Per-finding `IGNORED` existed but was useless in practice: the next scan forgot it and the same
accepted risk came back. Rules are now stored on the project and applied while the scan runs.

Matching is deliberately small: `*` stays inside a segment, `**` crosses segments (and also
matches zero segments, so `**/*.js` covers a root file), `?` is one character, everything else is
literal. A rule may scope by rule id, by path glob, or both; either side may be empty, which
means "any". The reason field is mandatory at the API level — an accepted risk has to say why,
otherwise the rule is just a mute button.

Semantics that matter:

- Rules are applied **after** detection and level normalization, so they only change `status`,
  never the evidence or the automation level.
- The status note records the rule and the reason (`Ignored by project rule (WL-CSS-004 · css/**): …`),
  so the decision survives in exports and in the finding history.
- An ignored finding is **not migratable**: the plan reports it as blocked with an explicit
  reason, because silently migrating something a human accepted is worse than either option.
- Rules apply to future scans only. Existing scans keep their statuses — no retroactive rewrite.

Measured on the fixture with one rule (`WL-CSS-004` · `css/**`):

| Scan | findings | ignored |
| --- | --- | --- |
| before the rule | 99 | 0 |
| after the rule | 99 | 5 (exactly the five `-ms-` findings under `css/`) |

Creating a rule without a reason returns 400; an unknown rule id returns 400; a pattern with a
leading `/` or `..` returns 400. The suite gained 10 cases in `backend/test/ignoreRules.test.ts`
(glob semantics, precedence, disabled rules, and the scan-time integration).

---

## 9. Fifth increment — ignore-rule impact preview

Deciding to ignore a pattern without knowing how much it silences is a guess, so both ignore
forms now ask the backend first: `POST /api/projects/:id/ignore-rules/preview`.

The counting is a pure function (`countIgnoreMatches`) over the findings of one scan, using the
same matcher the scanner uses — so the number shown cannot drift from what the next scan will do.
It reports three numbers instead of one, because "12 matched" is misleading when 9 of them are
already silenced:

- `matched` — everything the rule covers;
- `alreadyIgnored` — the subset that is already IGNORED;
- `newlyIgnored` — what actually changes;
- `byRule` — top five rules, so a path-only rule that swallows unrelated rules is obvious.

Measured on a project that already ignores `WL-CSS-004` under `css/**`:

| Candidate rule | matched | newly | already | reading |
| --- | --- | --- | --- | --- |
| `WL-CSS-005` · `css/**` | 5 | 5 | 0 | new decision, real effect |
| `WL-CSS-004` · `css/**` | 5 | 0 | 5 | redundant, already covered |
| *(any rule)* · `css/**` | 20 | 15 | 5 | far too broad: five different rules |
| `WL-NOPE-999` | — | — | — | 400 `unknown rule` |

The dialog debounces the call by 300 ms and renders the breakdown as badges; an empty result is
shown as a warning ("no finding matches this rule") rather than as a silent zero, because a rule
that matches nothing is almost always a typo in the glob.

---

## 10. Sixth increment — three follow-ups

### 10.1 Applying rules to an existing scan

Creating an ignore rule only changed the next scan, which made the impact preview look like a
promise the tool did not keep. `applyIgnoreRules()` re-evaluates one stored scan in both
directions: matching findings become IGNORED (note records rule + reason), and findings silenced
by a rule that no longer matches are restored to `READY_FOR_MIGRATION` / `DETECTED`. Manual
ignores are never touched — only notes written by the engine are undone, which is why the note
prefix is a shared constant rather than an inline string.

Both UI paths call it right after creating, toggling or deleting a rule.

### 10.2 Visual regression: masking and a viewport matrix

`POST /api/scans/:id/validation/visual/matrix` captures the page at desktop (1280×900), tablet
(768×1024) and mobile (390×844), each against its own baseline (`<pageKey>@<viewport>`), so a
desktop-only check cannot hide a broken small layout. Volatile regions are masked by selector
(`mask: [locator, …]`) instead of being compared.

Two determinism problems surfaced while measuring, both fixed at the source rather than papered
over with masking:

| Symptom | Cause | Fix |
| --- | --- | --- |
| ~2 000 px diff on every desktop capture | Monaco caret blinking | `cursorBlink: 'solid'` |
| A whole text line differed between runs | syntax highlighting still loading after `load` | wait for `networkidle` + 500 ms settle |

After both fixes, repeated captures of the same page report 0 diff pixels at all three viewports
(one residual 0.03 % sample was observed before the settle; documented, not hidden).

### 10.3 Incremental scans

A file is reused when its hash matches the previous scan **and** the rule signature matches.
The signature is `id@version` of every rule plus every recipe, stored on the scan, so adding a
rule or bumping a version invalidates reuse automatically. Reused findings are copied with new
ids, re-checked against current ignore rules, and their outgoing references are carried over —
otherwise the dependency graph would silently lose edges for unchanged files.

Measured on a synthetic 1 440-file project (120 copies of the fixture):

| Run | Wall clock | Parsed | Reused | Findings |
| --- | --- | --- | --- | --- |
| cold | 14.8 s | 1 440 | 0 | 11 880 |
| warm | 13.2 s | 0 | 1 440 | 11 880 |

Only ~11 % end-to-end, because the same run reads every file: 9.5 s of read+SHA-256 against
5.4 s of parsing and 0.4 s of analysis. The saving is real CPU work, but it is not the bottleneck
on this filesystem. A size+mtime shortcut would skip the read and is deliberately not taken —
reuse must be provable from content, not metadata.

---

## 11. Seventh increment — parallelism, authoring guard, scan visibility

### 11.1 Worker pool: built, measured, off by default

The scanner is per-file I/O plus CPU with no shared state, which looks ideal for a worker pool, so
one was built (`parseWorker.ts` + `parsePool.ts`): workers do `hash` (read+digest) and `analyze`
(read, decode, parse, analyse) and return serialisable results; the main thread keeps reuse
decisions, ignore rules and persistence.

Measured on the 1 440-file project, same machine, cold cache each time:

| Workers | Wall clock | Findings | Notes |
| --- | --- | --- | --- |
| 0 (in-process) | 13.2 s | 11 880 | baseline |
| 2 | 12.7 s | 11 880 | ~4 % better |
| 4 | 14.3 s | 11 880 | slower |
| 8 | 14.6 s | 11 880 | slower |

Reading 1 440 small files costs more than parsing them here (9.5 s vs 5.4 s), and the OS already
overlaps that I/O; workers add IPC plus a structured clone of ~8 findings per file on top. The
pool therefore ships **disabled by default** (`WEBLIFT_WORKERS` opts in) with the numbers in the
source comment, rather than as a default that regresses performance.

Robustness that came out of this: the pool is probed with one task before the run, and a failure
falls back to in-process with a warning instead of failing every file. Vitest runs the TypeScript
sources, where a worker cannot resolve the compiled module, so the pool is skipped there and the
in-process path is what the suite covers.

### 11.2 Rule authoring guard

`backend/test/ruleMeta.test.ts` (9 checks) enforces, for every rule: id format `WL-<CAT>-NNN`,
unique names of 3–60 chars, description ≥ 40 chars, basis ≥ 30 chars, no placeholder text
(TODO/TBD/N/A), enum fields inside their documented sets, 1–5 well-formed tags, `COVERED` only
with a fixture, and every `recipeId` pointing at a recipe that actually serves that rule.

It also checks the **output**: for each fixture, `risk` ≥ 80 chars, `recommendation` ≥ 60 chars,
`message` ≥ 12 chars, and a filled evidence triple. Existing rules passed unchanged, which is the
point — the guard is for the next rule, not this one.

### 11.3 Incremental visibility

The scan detail now states whether a scan was full or incremental and how many files were reused
(`12 / 12 个文件复用`), reading the per-file `reused` flag. Without it the speed difference was
invisible, and "why is this scan different from the last one" had no answer in the UI.

---

## 12. Eighth increment — visual comparison inside the migration

The migration and the visual checker existed as two separate actions. Now `execute()` accepts an
optional page list and captures each page **twice**: once after the plan is prepared but before
anything is written, once after the commit. The two PNGs are diffed with the same comparator the
regression checker uses, and the comparison is written to `validation_run` with scope
`VISUAL_MIGRATION`, so it survives in history instead of only living in the response.

Design choices worth recording:

- **The capture is a dependency, not an import.** `ExecuteOptions.visual.capture` is supplied by the
  caller (the HTTP route wires it to Playwright). The migration service stays free of browser
  code, which is what let the whole flow be tested with synthetic PNGs.
- **Visual failure is data, not an error.** A page that cannot be captured produces
  `captured: false` with a reason; the files are already written and validated by other means, so
  the transaction result stays `ok`.
- **Changed pages are a warning, not a failure.** `warnings` gains one line, and the run is stored
  with `passed: false` — visible, but not blocking.

Measured against the running tool as the subject, with a real browser:

| Page | Result |
| --- | --- |
| `/findings?lang=zh` (the migration changed finding statuses on screen) | 3.65 % · 42 021 px · warning emitted |
| `/rules?lang=zh` (content unaffected by the migration) | 0 % · 0 px · no warning |

The first row is the honest interesting case: the diff was real, because the page being compared
genuinely changed. That is exactly the signal the feature exists to produce — including when the
"app" is the tool itself.

`execute()` became async for this; the HTTP route and the tests were updated accordingly, and the
suite grew to 126 tests (4 new: diff reported, unchanged page, capture failure, no pages given).

---

## 13. Ninth increment — the report finally shows what was done

The report and the verification data were built independently: `validation_run` recorded
comparisons, `migration_execution` recorded writes, and `reportAsHtml` showed neither. A report
that lists findings but not the changes is a snapshot of a problem set, not of a migration.

`buildPayload` now includes `migrations` and `validations`, and the HTML report gained two
sections before the findings table:

- **Migrations applied** — file, rule, execution status, validation status, timestamp, session id;
- **Verification runs** — scope, pass/fail badge, timestamp, and for `VISUAL_MIGRATION` a table of
  page, URL, captured, diff %, changed pixels and size change.

Rendered and inspected against a real scan (`css/ie-fixes.css`, `WL-CSS-005`, one
`VISUAL_MIGRATION` run at 3.65 % / 42 021 px): both tables render, the FAILED badge is legible, and
the empty state reads "No migration was applied for this scan." rather than showing an empty table.

Not embedded, by choice: the images. They live in the UI and in `validation_run`'s payload minus the
data URLs (stripped in `compareAfterMigration`), so the JSON report stays at 37 KB for 99 findings
instead of megabytes. A test asserts `data:image/png;base64` never appears in the export.

One layout defect found by looking at the render: the rule column in the findings table wrapped
`WL-HTML-006` onto three lines because the monospace cell breaks at hyphens. Fixed with
`white-space: nowrap` on that column only; file paths keep wrapping.

---

## 14. Tenth increment — comparing two scans

A migration is a multi-round process, so the question users actually ask is "what is left?" rather
than "what exists?". `GET /api/scans/:id/compare` answers it against a baseline (default: the
previous scan of the same project).

Identity is the hard part. Offsets and line numbers cannot be used: any edit above a finding shifts
them, and a productive migration would then read as "everything resolved, everything new". The key
is `ruleId + filePath + whitespace-normalised snippet`:

| Change between scans | Result |
| --- | --- |
| The line moved down (edits above it) | unchanged |
| The line was reformatted | resolved + added (documented limitation) |
| The migration removed the pattern | resolved |
| New legacy code was added | added |
| The same snippet appears 3× then 2× | 1 resolved, not 1 added (multiset, not set) |

That last row is why occurrences are counted per key instead of deduplicated — with a set, "fixed
one of three" would silently read as "unchanged".

The response also reports whether the sources moved: comparing two scans of unchanged files shows
difference caused by rule changes, and the UI says so instead of implying the code changed.

Measured end to end on the fixture: baseline 99 findings → migrate three `SAFE` findings →
rescan → `resolved: 3, added: 0, unchanged: 96, 99 → 96`, two changed files, rule roll-up
`WL-CSS-005 −3`. The comparison page renders each side as a table with severity, localised
message and a link back to the finding.

Suite: 142 tests (8 new for the comparator: line shift, reformat, multiplicity, roll-ups).

---

## 15. Eleventh increment — rule state applied to stored scans

Ignore rules already had a retro-apply path; rule enable/disable did not, so switching off a noisy
rule left a thousand findings on screen until the next scan. Both now share one routine:
`applyIgnoreRules(store, scanId)` first checks ignore rules, then checks whether the finding's rule
is disabled.

Two notes, deliberately distinct, so a reader can tell why a finding is silent:

- `Ignored by project rule (WL-CSS-004 · css/**): <reason>`
- `Rule disabled after this scan (WL-CSS-005); re-enable the rule to see it again.`

Restoration accepts either note, and never touches a note written by a human. A manual ignore on a
finding whose rule is later disabled therefore stays exactly as the person left it.

Measured over HTTP on the fixture:

| Step | Result |
| --- | --- |
| scan | 5 findings of `WL-CSS-005`, 0 ignored |
| disable the rule, apply | `disabled: 5` — all five now carry the "rule disabled" note |
| re-enable, apply | `unignored: 5` — back to 0 ignored |

The UI does not mutate anything on toggle. Instead `GET /api/meta` exposes the current rule
signature, and a scan whose stored signature differs shows a banner: "the rule set changed after
this scan" with a one-click re-evaluation. That keeps the toggle honest (no silent rewriting of
history) while making the mismatch impossible to miss.

Limitation worth stating in the UI copy: re-evaluation can only *remove* findings, never add the ones
a newly enabled rule would produce. That still requires a rescan.

---

## 16. Twelfth increment — module grouping and rule relevance

Two things the data already contained but the UI never used.

### 16.1 Findings by module

`ProjectConfig.modules` existed from the first version and was only shown as a read-only list. The
summary now reports `byModule` (count + high-risk per module) using `modulePathOf`, the same helper
the scanner uses, and `/api/scans/:id/findings?module=<name>` translates a module *name* into the
path prefix the store filters on — the mapping stays on the server.

Measured on the fixture with `样式=css`, `脚本=js`, `页面=.`: 46 + 33 + 20 = 99, matching the total,
and filtering by `样式` returns exactly the 20 CSS findings each tagged `module: "样式"`.

The dashboard shows the breakdown only when more than one module exists; a single-module project
would otherwise get a bar list with one full-width bar and no information.

### 16.2 Rule relevance

42 rules listed alphabetically say nothing about which ones matter for *this* project. The rules
page now loads the newest completed scan's summary and shows a **hits** column (0 rendered as `—`),
a "only rules with hits" filter, and a sort toggle. The header shows `33 / 42` for the fixture.

`buildSummary` gained an uncapped `byRule` array for this — `topRules` was already there but limited
to 12 entries, which would have shown "no hits" for rules that fired 1×.

Wording matters here: a 0-hit rule "found nothing in this project", it is not "broken" or
"unimportant" — the copy says exactly that, because a rule that never fires on one project may be
the most important one on the next.

---

## 17. Thirteenth increment — a hostile corpus, and what it exposed

Every measurement so far used the 12-file fixture. `scripts/gen-stress-project.mjs` builds a
deliberately nasty project instead — 92 files across 40 JSP modules, plus the constructs that have
broken parsers before:

| Construct | Result |
| --- | --- |
| 40 JSP pages with scriptlets in attributes, EL inside `style`, server-side values inside `<script>` | 16 findings per page, no parse failures |
| `.jspf` include fragments | parsed, but produced bogus problems — see below |
| hand-encoded Shift_JIS file (`0x8E 0xF3 …`) | detected as `shift_jis`, finding at line 3 column 3 |
| 266-byte minified single-line JS | 4 findings, 0 problems |
| BOM file, CRLF file, 40-level nested functions | parsed, no problems |
| 1 200 CSS rules × 4 hacks | 4 801 findings, 0.3 s total for the whole corpus |
| malformed HTML (unclosed `td`, `p`, stray `<applet>`) | recovered, 3 findings, no hard errors |

Two real defects surfaced, neither of which the fixture could show:

1. **Doctype hints polluted the problem list.** Every `.jspf` include was recorded as
   `missing-doctype`, so a clean 92-file project reported 44 parse problems. A fragment is not a
   document: the hint is now skipped for `.jspf` (it still applies to a full `.jsp`, where a missing
   doctype really does put Chrome into quirks mode). 44 → 4, and the remaining four are genuine.
2. **Chinese leaked into backend-facing text.** Category labels, scan-phase labels, JSP region
   labels and three parse-error prefixes were Chinese, so they appeared untranslated in the English
   HTML report and mixed languages in the UI. The convention is "backend text is English, the UI
   translates": all of them are English now, and a `\p{Han}` sweep over `backend/src` returns zero
   matches. The UI stopped using `summary.byCategory[].label` and translates the category key
   itself, which is what it was already doing everywhere else.

---

## 18. Fourteenth increment — turning the stress findings into guards

The hostile corpus found two defects; finding them once is worth little if the next parser change
brings them back. `backend/test/stress.test.ts` now generates the corpus into a temp directory
(six modules instead of forty, to keep the suite fast), scans it, and asserts the properties that
actually matter:

- no hard parse errors and no failed files across the corpus;
- **no `.jspf` file is reported as missing a doctype** (the exact 44-fake-problems regression);
- the hand-encoded Shift_JIS file is `shift_jis` and its finding is at line 3, column 3;
- minified, BOM, CRLF and 40-level-nested sources produce zero problems;
- malformed HTML recovers and still yields findings with locations;
- every finding in a 5 000+ result set has a non-zero line/column and non-empty evidence.

A second guard covers the language leak: a test walks `backend/src` and fails on any Han character.
That is the only way this stays true — a stray Chinese label is invisible until an English report
renders it.

**The guard was verified by mutation**, not assumed: removing the `isFragment` check makes exactly
one test fail (`does not report include fragments as missing a doctype`), and restoring it returns
the suite to green. A regression test that has never failed is a hypothesis.

Suite: 153 tests.

---

## 19. Fifteenth increment — a scan that can actually be interrupted

Cancellation was decorative. `POST /scans/:id/cancel` returned `false` on a scan that was visibly
still running, and `docs/LIMITATIONS.md` claimed the orchestrator "yields every 8 files so SSE and
cancellation stay responsive" — a sentence describing behaviour that had never been written.

Two separate defects were stacked on top of each other:

1. **The prepare phase never yielded.** Parsing runs in-process, and the loop body was fully
   synchronous, so a 1 400-file scan occupied the event loop from start to finish. The cancel
   request could not be *read*, let alone acted on, and the SSE progress events were all emitted
   in one burst at the end. The loop now takes an event loop turn every 8 files
   (`YIELD_EVERY_FILES`, `setImmediate`).
2. **Nothing was accumulated until every file was done.** Findings, file rows and problems were
   built in a single loop *after* `prepareFiles()` resolved. A cancellation that did land
   persisted an empty result, because the arrays it saved were still empty.

`prepareFiles()` now reports each finished file through `onFileReady`, and `run()` accepts them
through one idempotent `acceptFile(item, index)` that holds the ignore-rule decisions too. Files are
buffered by discovery index and drained in that order, so a worker pool finishing out of order does
not randomise the stored rows. The cancellation and failure paths call the same `drainPrepared()`
before persisting, which is what makes "the scan stopped early" and "the scan can be resumed"
the same mechanism instead of two.

Resuming then needed one change: a `CANCELLED` or `FAILED` scan is now a valid reuse source
(previously only a completed one). It is sound because a file row is written only once that file is
fully analysed — a partial scan is a clean prefix, never a half-parsed file. The log distinguishes
the two cases (`Resuming from partial scan …` versus `Incremental: comparing against …`), because
the user experience differs even though the code path does not.

The UI states it plainly: an interrupted scan shows how many files survived and offers a resume
button that starts a new scan (which reuses them); when nothing survived, it says so instead of
promising reuse of zero files. All three languages.

**Verified end to end, over HTTP, not in a unit test.** A 400-file generated project: the client
cancels on the first progress event past 40 files.

```
scan1: CANCELLED | cancel ack: true | files kept: 48
scan2: COMPLETED | files: 400 | reused: 48
resume matched kept files: true
```

**Verified by mutation.** Removing `drainPrepared()` from the cancel path fails exactly one test
(`kept.length` is 0); removing the event loop yield fails the same test on `cancelAck`, which is the
proof that the starvation was real rather than theoretical.

### What a screenshot exposed

Reading the API output was not enough. The rendered page said **"48 / 48 — 100 %"** for a scan whose
banner said it did not finish, and the phase list showed all eight phases green, report generation
included. Two display bugs that no assertion had covered:

- The progress denominator fell back to `scannedFileCount`, which for an interrupted scan *is* the
  number of finished files — so the bar always read 100 %. Fixed by storing `total_file_count` at
  discovery time (`scan_task` column, added through `migrate()`), and by keeping the last active
  phase instead of nulling it on cancel, so the list can say **"Parsing — stopped here"** in amber
  and leave the rest grey.
- `PhaseList` treated "not running" as "finished", which is how a cancelled scan came to claim it
  had generated a report. It now takes the status, not a boolean.

Both were caught by looking at the page, not by the test suite, which is the recurring lesson of
this project: the suite protects what someone thought to assert.

The new column got a guard of its own, because this is the third time a column was added:
`storeUpgrade.test.ts` now builds a `scan_task` table from before rule signatures existed, opens it
with the current `Store`, and reads the row back. Removing the `ALTER TABLE` from `migrate()` fails
that test with `no such column`.

Suite: 158 tests.


---

## 20. Sixteenth increment — a review that found silent data loss

A deliberate review pass over the whole tree, looking for the things the suite could not see.
It found one defect that destroys user data, one that exposes the API to any website, and a
handful of smaller ones. All are recorded here so the next reader does not have to re-derive them.

### 20.1 Migrating a non-UTF-8 file destroyed every non-ASCII character in it

The scanner decodes with the detected encoding (`textDecode.ts`) and reports locations against
that text. The migration path did not: `readTarget()` and `writeFileAtomic()` both hardcoded
`'utf8'`. For a Shift_JIS file whose match happens to sit in pure-ASCII content — the common shape,
an `attachEvent` call with Japanese comments below it — the recipe's offsets still lined up, the
edit applied, and the file was written back as UTF-8. Proof, from a probe against the running API:

```
before:  // <93 fa 96 7b ...>          (Shift_JIS for 日本語のコメント)
after:   // ï¿½ï¿½ï¿½{ï¿½ï¿½ÌRï¿½ï¿½ï¿½ï¿½ï¿½g     (U+FFFD, re-encoded as UTF-8)
execute ok: true
```

When the offsets *did* not line up, the failure was the opposite and just as misleading: the plan
looked applicable and execution failed with "the matched call no longer exists at this position",
which blames the file for the tool's own decode mismatch.

Fixed by refusing, not by guessing: `preview()` blocks every finding in a file whose recorded
encoding is not UTF-8, with a reason that says what to do. Rewriting the file in its original
charset needs an encoder (`iconv-lite`), which is a dependency decision, not a bug fix — until
then a refusal is the only behaviour that cannot lose data.

The same decode bug was fixed in the two source viewers and in static validation, where a UTF-8
read of a Shift_JIS file shifted every offset and made post-migration counts meaningless.

### 20.2 Smaller defects fixed in the same pass

- **File permissions were silently rewritten.** `writeFileAtomic` renamed a temp file over the
  original, which replaces the inode; the "if the mode changed, write it again" repair was a no-op
  because `writeFileSync` only applies `mode` when it *creates* a file. A 0600 or 0755 file came
  back as 0644. Now the temp file is created with the original mode and `chmodSync` closes the gap.
- **The UTF-8 BOM was dropped.** The decoder strips it, so writing the decoded text back removed it.
  Harmless to a browser, a real change to the user's bytes. It is now carried through explicitly.
- **The viewer showed mojibake for every legacy file.** Both `/files/source` and
  `/findings/:id/source` returned `buffer.toString('utf8')` while reporting the detected encoding
  in the response — the one place a user checks "did it read my file correctly".
- **SSE never closed for a finished scan.** `subscribe()` returns a no-op when no runner exists, so
  a completed scan's stream emitted one snapshot and then hung on heartbeat forever, costing one of
  the browser's six connections per visit. It now sends `done` and ends.
- **The SSE snapshot used the scanned count as the total**, the same denominator mistake already
  fixed in the page: an interrupted scan read "48 of 48" again the moment the stream opened.
- **Validation re-read every finding of the scan inside the per-file loop**, so 50 target files on a
  20 000-finding scan meant a million row reads. Hoisted.

### 20.3 What the review could not fix, and why

- **~~CORS reflects any Origin and the server binds every interface.~~** Fixed in §21, which also
  added the first HTTP-level tests — the layer these defects lived in.
- **~~The commit phase is not atomic with the database.~~** Narrowed in §23 with a write-ahead
  claim: the rows now exist before the first byte is written, so the gap is recoverable.
- ~~**The HTTP layer has no tests at all.**~~ First batch added in §21.
- **Concurrency is now serialized in-process** (§24). Two *processes* touching the same project
  are still not coordinated; nothing but the write-ahead claim would notice.

Suite: 161 tests.

---

## 21. Seventeenth increment — closing the API to the network

The review in §20 recorded the exposure but left it open, because "who may reach this port" is a
product decision. The decision is: nobody but this machine.

- **The server binds loopback.** `app.listen(port)` became `listen(port, host)` with
  `host = WEBLIFT_HOST ?? '127.0.0.1'`. The startup line now prints the address it actually bound,
  including the real port when `port: 0` is used, instead of always claiming `localhost`.
  Exposing it is now deliberate: `WEBLIFT_HOST=0.0.0.0 npm start`.
- **CORS no longer reflects the caller.** Only origins whose host is `localhost`, `127.0.0.1` or
  `[::1]` get an `Access-Control-Allow-Origin` header. Everything else gets none, so reads are
  blocked by the browser, and any state-changing request carrying a foreign `Origin` is rejected
  with 403 — which also covers the "simple request" shapes that skip the preflight, the hole an
  allow-list alone would leave open.
- The dev server keeps working because the rule is on the host name, not on an exact origin list.

**Proved by mutation, not by reading headers.** Restoring the old reflection makes exactly the two
cross-origin tests fail, and the second one fails with `expected 201 to be 403` — i.e. a remote page
really could create a project pointing at `/` and then scan it. Flipping the default host to
`0.0.0.0` fails the bind assertion with `expected '0.0.0.0' to be '127.0.0.1'`.

### The first HTTP tests

`backend/test/apiHttp.test.ts` starts a real server on port 0 with a temp data directory and talks
to it over `fetch`. Eight tests, one per defect class that had shipped unnoticed because every
other suite calls the services directly:

- health and rule metadata, plus the loopback bind assertion;
- findings carry a non-zero line/column, a `WL-` rule id and a module name;
- a Shift_JIS file is served decoded (`no U+FFFD`) and reported not stale;
- a path outside the scanned set is refused with 403;
- a remote origin gets no CORS grant, and its write is refused;
- the Vite dev origin still gets a grant;
- a finished scan's event stream is one `done` event and then closes, measured under 2 s.

Suite: 169 tests.

---

## 22. Eighteenth increment — executing the plan that was reviewed

`execute(scanTaskId, findingIds)` recomputed the plan from scratch. The diff the user confirmed was
therefore a *description* of an earlier computation, not the thing being applied: between the two
calls the selection could differ, a finding's status could have been changed by an ignore rule, or
the overlap decisions in a shared file could come out differently. Each of those changes the
transformation while leaving the file hash identical, so the hash check did not cover it.

**The plan now carries a digest of itself.** `MigrationPlan.planHash` is a SHA-256 over the scan id
and, for every item, the finding id, rule, recipe, level, applicability, the file hash at preview
time, the blocked reasons and the exact edit ranges and replacement text. Sorted by finding id, so
two previews of an untouched tree agree — which is the property the whole mechanism rests on.

`execute` accepts `expectedPlanHash`, recomputes the plan, and refuses with a 207 and
"the plan changed after it was previewed" if the digest moved. Everything else about the
transaction is unchanged: it still aborts before any write, and still returns the digest it applied
(`ExecuteResult.planHash`) so the audit trail records what actually ran.

Omitting the hash keeps the old behaviour, which is what the existing tests and the CLI rely on —
the guarantee is opt-in at the protocol level and *always* sent by the UI.

### Tests

Three service-level tests and one over HTTP:

- preview → execute with the confirmed digest applies both files;
- two previews of the same tree agree, a different finding set does not;
- preview one finding, execute two with the first plan's digest → aborted, file untouched, no
  `migration_execution` row written;
- the same over HTTP, including a hand-made `planHash` that no plan could produce.

The HTTP test also revealed a bad habit worth naming: it had been pointing the project at
`examples/legacy-app` itself, so a wiring bug would have written into the repository. It now copies
the fixture into the temp directory first.

**Mutation-verified twice.** Removing the digest comparison fails both the service test and the HTTP
test; removing only the server's pass-through fails the HTTP test with `expected 200 to be 207` —
i.e. without the wiring, a tampered plan would have been applied.

Suite: 173 tests.

---

## 23. Nineteenth increment — the claim comes before the byte

Until now `execute()` wrote the files first and inserted the `migration_execution` rows afterwards.
A database failure in that window — or a process killed between the two — left edited files with no
audit trail: no row, no backup pointer, no rollback path in the UI, even though the backups were
sitting on disk under `data/backups/`. The transaction model promised "one auditable unit"; the
audit record was the last thing created.

**The transaction now claims what it is about to do, then does it, then confirms.** For every file
it has prepared, `execute()` inserts one `PENDING` row per finding carrying the backup path, the
`beforeHash` and the hash of the bytes it is about to write. Only after the write lands is the row
promoted to `APPLIED` and the finding moved to `MIGRATED`.

That gives the crash case two honest outcomes, decided by the file itself rather than by a guess:

- file hash equals `afterHash` → the write happened, rollback restores the backup;
- file hash equals `beforeHash` → the write never happened, rollback clears the claim and touches
  nothing;
- anything else → refused as drift, exactly as before.

If a write fails mid-transaction, the compensation path now also clears the claims of every file
that ended up back at its original hash. The rows are supposed to describe a difference on disk; if
there is none, they go. Files that could not be reverted keep their claim, which is what makes them
findable — the abort message names them and says they can be rolled back.

The UI marks such a session with an amber "Interrupted" badge next to its validation status (a
crashed transaction must not read like an ordinary applied one), the HTML report counts only
`APPLIED` in its heading and explains the `PENDING` rows below it, and `docs/LIMITATIONS.md` states
what this still cannot survive.

### Tests

- a write that fails after a previous file was written: file restored, **no rows left behind**,
  no finding marked migrated;
- a row whose write landed but was never confirmed → rollback restores the backup;
- a row whose write never happened (file matches `beforeHash`) → rollback clears it without
  rewriting the file.

Each was mutation-verified: filtering rollback back to `APPLIED` fails the second, deleting the
`beforeHash` branch fails the third, and dropping the claim cleanup fails the first — one test per
mutation, no collateral failures.

Suite: 176 tests.

---

## 24. Twentieth increment — one mutation at a time per project

The review listed "no concurrency lock" as the last open item. Working out *where* the race
actually is turned out to matter more than the lock itself.

`execute()` is `async`, but the region that matters — claim, write, confirm — contains no `await`,
so a second call cannot interleave with it: Node runs it to completion. The exposure is the awaits
*around* it. The visual capture sits between "prepare" (read the file, verify its hash, compute the
edit) and "write". That gap is long enough for a second `execute()` to prepare from the same
original bytes, and then both write: the second overwrites the first's edit while both report
`ok: true`.

**Reproduced before fixing.** Two findings in one file, two migrations at once, a capture that
awaits 25 ms:

```
without the queue:  ok: [true, true]   file: one edit applied, the other silently lost
with the queue:     ok: [true, false]  file: one edit applied, the other refused as stale
```

The refusal is the correct outcome: the second plan was computed against bytes that no longer
exist, and `preview()` already knows how to say so ("the file changed after the scan").

- **A per-project queue** wraps `execute()`. The ordinary path — no visual comparison — is a
  promise resolved immediately, so nothing slows down; the capture path is serialized.
- **Rollback refuses while a migration is in flight** rather than joining the queue. Rollback is
  synchronous, so it can only ever land inside a capture; queueing it would mean making three
  public methods async and rewriting a dozen tests to buy nothing. A refusal with a reason the
  user can act on is the honest trade.
- **Temp file names** are now `pid` + counter instead of the millisecond clock. Two writers could
  otherwise pick the same path and rename each other's bytes into place, which no lock in this
  process would prevent.

**Mutation-verified both ways.** Removing the queue makes the concurrency test fail with
`expected [true, true] to have a length of 1` — the lost update, stated plainly. Removing the
rollback guard makes the refusal test fail with `expected true to be false`, i.e. the rollback ran
while a migration was holding a plan against the same bytes.

Suite: 178 tests.

---

## 25. Twenty-first increment — what moved since the last scan

A migration is a sequence of small fixes over weeks, but every scan was an island: the dashboard
listed totals, and to learn whether anything had improved you had to open the Compare page and pick
two scans by hand. The numbers that matter during a migration — what got fixed, what got introduced
— existed only as a derived view.

**The scan now records its own delta.** When it finishes, it compares itself against the scan it
already uses for incremental reuse, and stores `compared_scan_id`, `resolved_count` and
`added_count` on the row. The comparison is the same `compareFindings` the Compare page runs, so
there is one definition of "resolved" in the codebase, not two.

Identity is rule + path + normalised snippet, so the delta survives edits elsewhere in the file and
counts a rewritten file honestly: delete `js/legacy-events.js` from the fixture and the next scan
reports **25 fixed, 0 new** (99 findings → 74), with no offset bookkeeping involved.

The delta is only recorded when a comparable scan exists — same rule signature. Comparing across a
rule change would produce a number that looks like progress and is not; those scans show "no
previous scan to compare" instead.

The scan detail page and the Overview card both show it as two badges with a link to the baseline,
in all three languages.

### A bug the screenshot found

Rendering the card showed **"0 / 11 — 0 %"** on a scan that had just completed 11 of 11 files. The
cause had nothing to do with the trend: a fully incremental scan reuses every file, never enters
the parse loop, and `scannedCount` was only advanced inside that loop. Every fully-cached rescan
therefore recorded `scanned_file_count = 0`, and the dashboard claimed nothing had been scanned.
The prepare phase now emits one final progress tick once every file is accounted for.

Caught by looking at the page, not by an assertion — and it had been wrong for as long as
incremental scanning has existed. The guard added is `expect(second.scannedFileCount).toBe(12)`:
removing the fix makes it fail with `expected +0 to be 12`.

### Also

`createScan()` no longer defaults the rule signature to `null`. A scan created without one silently
lost both incremental reuse *and* the new delta; the parameter is now required, and the nine test
call sites pass the real signature like production does.

Suite: 182 tests.

---

## 26. Twenty-second increment — the trend as a line

§25 gave every scan a delta. A delta is still a pair of numbers; what a migration needs is the
shape of the remaining work over time. The project page now draws it.

`GET /api/projects/:id/trend?limit=12` returns one point per **completed** scan, oldest first, with
the finding count split by migration level. Interrupted scans are excluded on purpose: a cancelled
run only counted the files it reached, so including it would draw a cliff that never happened.

The split comes from one query (`GROUP BY scan_task_id, migration_level`) rather than one read per
scan — a dozen scans would otherwise be a dozen full table reads for a chart. Nothing is
denormalised onto the scan row, so the chart cannot drift from the findings it claims to summarise.

Two lines: findings that need a human, and findings a recipe can still convert. Both are counts of
what is *in the code*, not of statuses — accepting a finding (ignore rule) does not move them, and
the card says so in as many words, because a burn-down that dropped when someone clicked "ignore"
would be measuring paperwork rather than progress.

### The screenshot again

The first render letterboxed the chart into the left two-thirds of its card: a fixed `height`
with `width: 100%` makes the browser scale the viewBox to fit the *height*, leaving the rest of the
width empty. The top y-axis label was clipped by the same fixed geometry. Both were invisible in
the dev tools and obvious the moment the page was rendered. The component now sizes itself with
`width: 100% / height: auto` against a 880×200 viewBox and scales cleanly.

That is the third defect this project has found by looking at a rendered page after the tests were
green — after "0 / 11 — 0 %" (§25) and the all-green phase list (§19).

### Tests

One HTTP test: two completed scans produce two points, oldest first, every point's level breakdown
sums to the finding count the scan recorded, and no point carries a non-terminal status.

Suite: 183 tests.
