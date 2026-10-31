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

---

## 27. Twenty-third increment — writing legacy encodings back

The tool could scan Shift_JIS / EUC-JP / ISO-2022-JP / UTF-16 files but refused to write them:
"convert the file to UTF-8 first". For the projects this tool targets, that made a whole class of
files read-only. This increment removes the refusal without letting a lossy rewrite land.

**Two codecs, each verified before committing to it.** iconv-lite 0.7.3 (MIT) covers UTF-8,
Windows-31J, EUC-JP and UTF-16. It has no ISO-2022-JP codec — probed directly:
`encodingExists('iso-2022-jp') === false` — so ISO-2022-JP uses encoding-japanese 2.4.0
(MIT, zero dependencies). Both round-trip the fixture's Japanese comment. Shift_JIS is encoded as
Windows-31J (`cp932`) because that is the mapping the WHATWG decoder behind
`TextDecoder('shift_jis')` actually uses.

**The safety gate is a strict round trip.** `encodeText` encodes the edited text, decodes the bytes
back with `fatal: true`, and compares. A difference — an unrepresentable character, a lone
surrogate, a lossy mapping — blocks the finding and reports the character offset. iconv-lite's
silent `?` substitution therefore cannot reach the disk. The gate is applied at preview (per
finding, so one impossible edit does not poison the rest of the plan) and again before the write.

**The write path carries bytes, not a string.** The byte-order mark is taken from the original file
and re-emitted unchanged, and `after_hash` is computed over the bytes that will land. Rollback
compares like with like; a hash computed over a UTF-8 rendering of the text would have marked every
non-UTF-8 migration as drifted.

**A discovery bug this exposed.** The binary probe treats any NUL byte as binary, and UTF-16 text is
full of them by construction. A file with a UTF-16 BOM is now exempt from that rule; UTF-32 remains
unsupported and stays classified as binary. Without this, the UTF-16 decoder was documented but
unreachable.

**Tests.** `encodingSafety.test.ts` grew from 3 to 9 cases: a migration + rollback for each of
Shift_JIS, EUC-JP, ISO-2022-JP, UTF-16LE, UTF-16BE and UTF-8-with-BOM; unrepresentable-character
refusal; and the no-encoder path. Each migration case asserts that the written bytes still decode to
the expected edited text, the Japanese comment survives, no U+FFFD appears, CRLF is intact, the BOM
is byte-identical, and `afterHash` equals the file's actual SHA-256.

**End-to-end on the fixture.** `js/shift-jis-helper.js` (Shift_JIS, 462 bytes, `attachEvent` at
line 7 column 5) was previewed, executed and rolled back. The file became 465 bytes, still decoded
as Shift_JIS, the Japanese header/comment/label were unchanged, and rollback restored the original
SHA-256. The migration preview now also labels each item with the encoding it will preserve in the
UI (zh/ja/en).

**Remaining limits.** ISO-2022-JP is stateful, so the encoder may choose different escape sequences
than the source even when the decoded text is identical; the diff is the place to confirm that. A
forced encoding with no available encoder is still scan-only. GBK/GB18030 remain outside the
default detection list.

Suite: 189 tests.

---

## 28. Twenty-fourth increment — a scan that survives SIGKILL

Until now a scan wrote its rows only when it stopped. A cancelled scan persisted what it had, but a
hard kill (`SIGKILL`, power loss) lost every file and left the row `RUNNING` forever, so the UI kept
spinning and the next scan started from zero.

**Batches land atomically.** Completed files are committed every 25 files
(`WEBLIFT_SCAN_FLUSH_EVERY` for deliberate overrides). One transaction writes findings, parse
problems, per-file reference facts and the file rows, updates the scan's counts, and commits. The
file row is last inside the transaction; together with the transaction it is the marker that the
rest of that file's data is present. `scanRecovery.test.ts` forces a duplicate file id and asserts
that the finding and fact rows inserted earlier in the same batch are rolled back.

**The mutation check caught a false green in the test itself.** The first version of the mid-run
test wrapped `insertScanFiles` and accepted any flush while the status was `RUNNING`. Disabling the
periodic flush still passed, because the final persistence phase also runs before the status becomes
`COMPLETED`. The probe now requires `phase === 'PARSING'`; with the periodic flush disabled the test
fails at that assertion.

**A dead owner is reclaimed.** Each run records `runner_pid`. Constructing `ScanManager` marks any
`RUNNING` row whose PID is not alive (or is absent) as `FAILED` with an explanatory `errorSummary`;
a live PID — including the current process — is left alone. `FAILED` was already a valid
incremental-reuse source, so the next scan reuses the committed prefix by hash + rule signature and
parses the rest.

**Reference facts are persisted per file.** Reused files are not parsed, so their outgoing edges used
to be copied from the previous scan. A hard-killed scan had no relations at all. The new `file_fact`
table stores `FileRefFacts` per file; reused facts are loaded and `buildRelations` runs over the
whole project, so a resumed scan rebuilds its edges instead of inheriting a partial copy. Scans from
before this table have no facts; for those, the old relation copy remains as a logged fallback.

**Measured end-to-end.** A child process scanned 1 000 files with a 10-file flush cadence, announced
30 committed rows, and was killed with `SIGKILL`. Reopening the data directory showed the scan
`RUNNING` with 30 rows. A new `ScanManager` reclaimed it to `FAILED`
("The scan process stopped before completion..."), and a new scan completed: 1 000 files, 30 reused,
970 parsed, 1 000 findings and 1 000 fact rows. No finding was lost.

**Remaining limits.** Two processes scanning the same project are still uncoordinated; the PID
check protects a live owner but cannot rule out PID reuse. The last uncommitted files are re-parsed.
Files whose previous scan predates `file_fact` fall back to copied relations and log a warning.

Suite: 193 tests.

---

## 29. Twenty-fifth increment — a manual fix that has to prove itself

A migration sets `MIGRATED` from its execution record, but a fix made by hand had no result: the
finding stayed in whatever state it was in, and the next scan created a new row with no connection
to the claim. `REVIEW_REQUIRED` and `IGNORED` describe intent; neither proves the code changed.

**A new claim state.** `FIXED_IN_CODE` means "the code has been changed; verify it on the next
scan". The finding detail offers a one-click action, the API accepts the status, and the badge and
hint are translated in zh/ja/en.

**The matcher is deliberate about identity and evidence.** `verifyManualFixes` is a pure function.
It matches previous and current findings one-for-one on `findingKey` (rule + file +
whitespace-normalised snippet): line shifts must not break a claim, and duplicate snippets must not
let one surviving occurrence vouch for another. It only draws conclusions for files whose current
row is `PARSED` — a skipped, binary or partially parsed file cannot prove absence — and it skips
rules disabled in the current scan.

Four outcomes:
- `FIXED_IN_CODE` and absent → the claim becomes `VALIDATED`.
- `FIXED_IN_CODE` and present → the claim and the current occurrence both become
  `VALIDATION_FAILED` (the current one is left alone if a project rule ignores it).
- `VALIDATION_FAILED` and absent → `VALIDATED`, so a failed fix resolves automatically once the
  code is repaired; the user does not have to re-mark it.
- `VALIDATION_FAILED` and present → no new history row.

Status updates run in one transaction and append `finding_status_history` rows with actor
`system:verification` and a note naming the scan that decided.

**Tests and mutation checks.** Seven unit cases cover the matcher; two three-scan integration cases
cover claim → failure → repair → validation and claim → repair → validation. Disabling the
`FIXED_IN_CODE` branch turned both integration tests red; removing the parsed-file guard turned the
conservative-case test red.

**Demonstrated end to end.** `legacy.js` was marked fixed, repaired, and the next scan marked the
claim `VALIDATED`. `pending.js` was marked fixed but left broken; the next scan marked both the
claim and the current occurrence `VALIDATION_FAILED`. The finding history shows the user claim and
the `system:verification` decision. In a headless browser the "Mark fixed in code" action changed
the status through the real API and rendered the badge and the verification hint.

Suite: 202 tests.

---

## 30. Twenty-sixth increment — the removed APIs that were invisible

The rule set covered the specification's list but not several APIs that legacy code uses and Chrome
removed. A project could contain `element.runtimeStyle`, `document.createStyleSheet`,
`element.setCapture`, `event.toElement`, `document.frames`, `document.recalc`, `window.showHelp` or
`window.createPopup` and receive a clean scan.

**Eight detection-only rules.** They are `MANUAL` or `UNSUPPORTED`, not fabricated `SAFE`/
`CONDITIONAL`: no recipe exists for these shapes, and the existing automation-level gate already
refuses to claim one.

| Rule | API | Level |
| --- | --- | --- |
| WL-DOM-005 | `element.runtimeStyle` | MANUAL |
| WL-DOM-006 | `document.createStyleSheet` | MANUAL |
| WL-DOM-007 | `element.setCapture` / `releaseCapture` | MANUAL |
| WL-DOM-008 | `event.toElement` / `fromElement` | MANUAL |
| WL-DOM-009 | `document.frames` | MANUAL |
| WL-DOM-010 | `document.recalc` | MANUAL |
| WL-BEH-003 | `window.showHelp` | UNSUPPORTED |
| WL-BEH-004 | `window.createPopup` | UNSUPPORTED |

**False-positive guards are part of each detector.** `document.*` APIs require the `document`
identifier, not any object; `showHelp` and `createPopup` require `window.` or the bare IE global;
`toElement`/`fromElement` require a parameter named like an event on the enclosing function.
Comments and string literals cannot produce findings because the detectors walk the AST.

**Tests.** One firing fixture per rule (the coverage suite asserts set equality), metadata and
zh/ja messages, plus a dedicated test for the second variant (`releaseCapture`, `fromElement`, bare
`showHelp`/`createPopup`) and for lookalikes (`obj.toElement`, `custom.showHelp`, `window.frames`).

**Verification.** A synthetic project with ten occurrences across the eight rules produced ten
findings (eight MANUAL, two UNSUPPORTED) and zero findings from the comment/string decoys. The
bundled fixture stayed at 12 files / 99 findings / 22 auto-convertible, so the new detectors did not
drift the baseline.

**A stale generator was caught.** `scripts/gen-rules-doc.mjs` imports `backend/dist`, so running it
before a rebuild produced a 42-rule document after the registry had 50. `ruleDoc.test.ts` now
compares `docs/RULES.md` with the source registry, so a stale document fails the suite.
Regenerate with `npm run build:api && node scripts/gen-rules-doc.mjs`.

Suite: 207 tests.

---

## 31. Twenty-seventh increment — one writer per project, across processes

Scans and migrations were only serialized inside one process. Two processes against the same data
directory could interleave: a migration's write-ahead claim would surface damage rather than prevent
it, and a scan could read a mixed snapshot while another process wrote project files.

**A database lock keyed by project.** `project_lock(project_id PRIMARY KEY, owner_pid, owner_token,
acquired_at)`. Acquisition runs under `BEGIN IMMEDIATE`, so two processes cannot both insert. A lock
is re-entrant for the same token, refused for a live different owner — even when the pid is the same
— and reclaimed when the owner pid is gone. Ownership is per operation token, not per process, so a
scan and a migration in one process cannot overlap either. SQLite `busy_timeout` is 5 s so a
concurrent write transaction settles instead of failing immediately.

**Every writer takes it and every exit releases it.** A scan acquires at start and releases in the
run's `finally` (including the unknown-task early return). A busy scan is marked `FAILED` with the
owner pid and acquisition time; the start endpoint returns that scan, so the UI shows the reason
instead of an unhandled rejection. A migration acquires inside the in-process queue and releases in
a `finally`; a rollback acquires in `rollbackRows` and releases there too. A migration or rollback
that finds a lock returns the same reason and writes nothing.

**Tests and mutation checks.** Three store-level cases (two connections contend, the same token
re-enters, a dead pid is reclaimed) and two integration cases (a scan is blocked then succeeds after
release; migration and rollback are blocked, the file bytes stay unchanged, then both succeed).
Disabling the scan, migration or rollback acquisition each turned its test red.

**Two-process verification.** A child process acquired the lock (pid 51067) and the parent's scan was
rejected with "Another operation is already running on this project (pid 51067, since ...)". After
`SIGKILL`, the next scan reclaimed the dead lock, completed with one finding, and the lock table was
empty.

**Remaining limits.** The lock is fail-fast, not a queue; a live but hung owner holds it until it is
stopped, and PID reuse could mistake a stale lock for a live owner. It coordinates this tool's scans
and migrations, not arbitrary external writers.

Suite: 212 tests.

---

## 32. Twenty-eighth increment — waiting instead of failing fast

The project lock rejected a second operation immediately. A CLI scan started while the UI was in the
middle of a migration failed without doing any work, even though the owner was going to finish in a
few seconds.

**A bounded wait, not a queue tax.** `acquireProjectLock` tries the atomic acquisition, then polls
every 200 ms up to `WEBLIFT_LOCK_WAIT_MS` (default 30 s). The try-acquire itself is unchanged: one
`BEGIN IMMEDIATE`, same-token re-entry, dead-pid reclaim. A waiter that reaches the deadline gets
the same owner details as before, prefixed with the elapsed time.

**Scans stay `QUEUED` with a reason.** When the first try finds a live owner, the scan keeps its
`QUEUED` status and records `waitingFor` (owner pid + acquisition time). `ScanTask` gained the
field, the scanner writes it while waiting, and the scan page shows a warning callout next to the
`QUEUED · LIVE` badge. The waiter polls, acquires when the owner releases, clears `waitingFor`, and
runs. A timeout marks the scan `FAILED` with "Timed out after Ns..."; cancel while waiting marks it
`CANCELLED` without taking the lock. A queued scan whose waiting process dies is reclaimed by
`markInterruptedScans` (the query now covers `QUEUED` rows with a `runner_pid`, while rows that were
never started stay untouched).

**Migrations and rollbacks wait too.** `execute` waits inside the in-process queue and appends
"Waited Ns..." to the result warnings; the rollback methods became asynchronous and wait in
`rollbackRows`, so the API handlers await them. A timeout writes nothing. A rollback during an
in-process migration still refuses immediately: that is the existing `mutationInFlight` guard, not
the cross-process lock.

**Tests and mutation checks.** Seven queue tests: scan waits then completes, scan timeout, cancel
while waiting, migration wait with a warning, migration timeout with no writes, rollback wait, and
reclaiming a queued scan whose process died. Existing fail-fast lock tests construct the manager
and service with `lockWaitMs: 0`. Disabling the poll loop turned the scan/migration/rollback wait
tests red.

**Two-process and UI verification.** A child process held the lock (pid 67058). `POST
/api/projects/:id/scans` returned 202 with a `QUEUED` scan whose `waitingFor` named the owner. The
scan page rendered the waiting callout. After `SIGKILL`, the waiting scan acquired the dead owner's
lock, completed with one finding, cleared `waitingFor`, and left the lock table empty.

Suite: 219 tests.

---

## 33. Twenty-ninth increment — the remaining blind spots

Six more IE-only APIs were invisible to the scanner. All six are detection-only; no recipe was
invented for a shape that cannot be rewritten mechanically.

| Rule | API | Level |
| --- | --- | --- |
| WL-HTML-010 | `onpropertychange` attribute | MANUAL |
| WL-DOM-011 | `event.propertyName` / `.onpropertychange` | MANUAL |
| WL-DOM-012 | `element.addBehavior` / `removeBehavior` | UNSUPPORTED |
| WL-DOM-013 | `document.namespaces` | UNSUPPORTED |
| WL-DOM-014 | `element.styleSheet` | MANUAL |
| WL-BEH-005 | `window.offscreenBuffering` | MANUAL |

**Guards that keep them from over-matching.** `propertyName` is only matched on an event-named
parameter of the enclosing function; `document.namespaces` requires the `document` identifier;
`window.offscreenBuffering` requires the `window` identifier. `element.styleSheet` skips the
`styleSheet.rules` chain because WL-DOM-003 already reports that more specific pattern — a
dedicated test asserts the pair produces one finding, not two. The HTML attribute rule only sees
real attributes, so the same text in a comment does not match.

**Tests.** One firing fixture per rule, the metadata/message gates, and a five-case anti-false-
positive file covering comments/strings, lookalike members, the `styleSheet.rules` overlap, the
second variants (`onpropertychange`, `removeBehavior`), and an `onpropertychange` attribute inside a
comment.

**Verification.** A synthetic project containing all six APIs plus comment and string decoys
produced eight findings (five MANUAL, three UNSUPPORTED) and zero decoy hits. The bundled fixture
stayed at 12 files / 99 findings / 22 auto-convertible. The catalog is regenerated at 56 rules; the
rule-doc drift test passes.

Suite: 224 tests.

---

## 34. Thirtieth increment — a function-level rewrite unlocks the biggest manual bucket

`window.event` was the largest MANUAL bucket (17 fixture findings). Per-occurrence recipes cannot
fix it: the handler needs a parameter, and every reference inside it changes. The tool now models
that as one handler-level finding and one recipe.

**Rule WL-JS-017 emits one finding per eligible handler, anchored at the signature.** Eligibility,
all in the same file: zero parameters; a registration through `attachEvent`, `detachEvent`,
`addEventListener`, `removeEventListener` or an `on*` property; no other use of the function name
(a direct call, timer or callback blocks it); no `window.event` inside a nested function; no
`arguments` use; no local `event` binding; and not `beforeunload`/`unload`. The finding's evidence
carries the whole-function range and the exact reference spans. `WL-JS-003` suppresses the
per-reference findings covered by an eligible handler, so the dashboard counts one automatable unit
instead of double-reporting.

**Recipe RCP-HANDLER-EVENT-PARAM** injects `event` into the empty parameter list and replaces each
covered `window.event` with it, as multiple non-overlapping edits. Preconditions re-run the handler
analysis on the current file; a changed shape blocks. It deliberately does not rewrite
`srcElement`/`returnValue`/`cancelBubble`: after the signature migration and a rescan those findings
satisfy their existing recipes. The integration test proves the whole chain: handler finding →
`function onRowClick(event)` with no `window.event` → rescan → `srcElement`/`cancelBubble` become
SAFE → migrate → `event.target`/`event.stopPropagation()`.

**Counts.** The fixture moved from 99 to 98 findings: six covered `window.event` references are
suppressed and five handler findings are added. Auto-convertible rose from 22 to 27 (10 SAFE, 17
CONDITIONAL); MANUAL fell from 67 to 61 (4 candidates, 9 blocked, 48 judgement); high risk 44 → 43;
`modern.js` is still 0. The count moved because one handler unit replaced per-reference manual
findings, not because coverage was lost.

**Tests and mutation checks.** Five handler tests cover the one-finding-plus-suppression shape,
the direct-call/local-event/nested/`arguments` exclusions, the beforeunload/parameter exclusions,
anonymous and `on*` positives, and the migration → rescan → property-migration chain. The nested
negative was first a false green — a handler whose only reference was nested was already ineligible
for a different reason — and was strengthened with a top-level plus nested reference. Disabling the
identifier-use guard, the nested guard or the `WL-JS-003` suppression each turned the relevant
assertion red.

**UI.** The handler finding appears as a migration candidate; previewing it shows the signature edit
and every reference replacement in one diff. The fixture file was only previewed, never written.

Suite: 229 tests.

---

## 35. Thirty-first increment — a handler registered in another file

The function-level handler rewrite could only see a registration in the same file. Shared JS files
often define handlers that a page script or another JS file registers **by reference**; those
definitions stayed invisible.

**File facts now carry handler evidence.** Each `FileRefFacts` records eligible zero-argument
handler definitions (signature offsets, lines, snippet, `window.event` spans, `otherUses`) and named
registrations (`attachEvent`/`addEventListener`/`on*`, event name, line). The facts live in
`file_fact`, so they survive incremental reuse. Old facts lack the fields; `WL-JS-017` and its
recipe were bumped to `1.1.0`, which changes the rule signature and forces the first post-upgrade
scan to parse every file and rebuild the facts.

**A project pass matches definitions to registrations in other files.** After preparation, a
definition in file A is matched to a by-reference registration in file B when: the registration is
not in A (that is the per-file rule's job); the name is not called anywhere in the scanned files
(`facts.calls`); the definition has no other local use; and the definition lives in a `.js` file.
The finding is emitted in the definition file with the `rules.WL-JS-017.crossFile` message and
evidence carrying the registration file(s) and the handler offsets. The covered per-reference
`WL-JS-003` rows are deleted before the finding is added, the file row's finding count is adjusted,
and the dashboard therefore counts one automatable unit.

**The recipe works from evidence offsets.** `findHandlerAt` locates the definition by
`handlerStart`/`handlerEnd` and re-checks its body eligibility. The registration file is not edited:
a by-reference registration passes the event as the first argument.

**Cross-file safety.** Preview reads every registration file and compares its bytes with the
`scan_file.hash` captured at scan time. A changed registration blocks the item with "Registration
file ... changed after the scan". Execute recomputes the preview, so an execution against the old
plan aborts on the changed `planHash`.

**Scope exclusions.** Inline handler calls such as `onclick="fn()"` are recorded as calls and block
the by-reference path; handlers with parameters, registrations outside the scanned project, and
definitions in non-`.js` files are not offered. These remain for a later increment.

**Tests and mutations.** Five cross-file cases: the full cycle (definition finding → signature
migration → rescan → `srcElement`/`cancelBubble` become SAFE → migrate to `target`/
`stopPropagation`), a direct-call negative, same-file deduplication, a changed-registration block,
and the zh/ja message variant. Disabling the direct-call check or the registration-hash check each
turned a test red. The bundled fixture stayed at 12 files / 98 findings / 27 auto-convertible.

**UI.** A `shared.js` + `page.js` demo shows the cross-file finding as a migration candidate; the
preview shows the signature and reference edits while the evidence names `page.js` as the
registration file.

Suite: 234 tests.

---

## 36. Thirty-second increment — an inline on* call rewritten with its function

The handler rewrite covered by-reference registrations but not the common JSP shape
`onclick="onUpdateClick()"` calling a zero-argument function defined in the same file. The function
needed an event parameter and the call needed to pass it; both changes belong to one reviewed plan.

**Inline on* calls are a handler source.** The per-file handler analysis treats a zero-argument call
inside an inline `on*` unit (container `onclick attribute (<input>)`) as a registration. The callee
identifier is allowed in the function's use check; a non-inline call, an inline call with
arguments, or a dynamic inline unit leaves the handler ineligible. The rule emits the `.inline`
message variant with the inline-call count, and the covered per-reference `window.event` findings
are suppressed as before.

**One recipe, one file, every covered edit.** The recipe injects the event parameter, replaces the
function's `window.event` references, and inserts `event` into each inline call. The insertion only
works when the call's argument list is empty; otherwise the recipe blocks. The plan preview, the
hash check and the atomic write are unchanged.

**Tests and mutations.** A JSP with `onclick="onUpdateClick()"` and the function in the same file
goes through signature + call rewrite, then a rescan makes the `returnValue` finding applicable; a
non-inline call and an inline call with an argument are rejected; the zh/ja `.inline` variant
renders. Allowing an argument-passing call made the ineligible test red; disabling the inline-call
edit made the plan-edits/execution assertions red.

**Fixture.** 98 → 96 findings: four `window.event` references in the two inline handlers are
suppressed and two handler findings are added. Auto-convertible 27 → 29 (10 SAFE, 19 CONDITIONAL);
MANUAL 61 → 57 (4 candidates, 9 blocked, 44 judgement); high risk 43 → 41; `window.event` findings
11 → 7; `modern.js` stays 0. There are now seven handler findings, two of them inline.

**Remaining.** Cross-file inline calls (a shared definition called from another file) are still
recorded as calls and block the by-reference path; they need a multi-file plan and are the next
increment. Handlers with parameters and timer/async uses remain manual.

Suite: 238 tests.

---

## 37. Thirty-third increment — a cross-file inline call goes into one reviewed plan

The inline-call rewrite covered calls in the same file. A shared JS handler called from a JSP inline
attribute needed a definition edit in one file and a call edit in another; the old architecture had
no way to review or apply them as one unit.

**Facts now include inline calls and direct calls.** `FileRefFacts.inlineCalls` records every
zero-argument call inside an inline `on*` unit (file, line/column, offsets, event, snippet) and
`directCalls` records names called anywhere else — a script block, an inline handler with
arguments, or a dynamic unit. The latter is the block signal: a function called anywhere outside a
zero-argument inline handler cannot be migrated by changing one signature.

**The project pass emits a companion group.** A definition in a `.js` file matched to inline calls
in other files produces a definition finding (`rules.WL-JS-017.inlineCalls`) and one call-site
finding per call (`rules.WL-JS-017.inlineCallSite`). The definition finding carries the call-site
files and counts; every finding carries the shared `companionFindingIds` string. The per-file
handler finding for the same definition is replaced, and the covered `WL-JS-003` rows are removed
with the file row counts kept aligned. The `.crossFile` by-reference path and inline sources can
coexist in one definition finding.

**Selection expands to the group.** `MigrationService.preview` walks `companionFindingIds`
recursively, so selecting the definition or any call site returns the complete plan. The UI now
selects every plan item after a preview; the execute set check and the planHash therefore cover the
whole group. The definition recipe injects the parameter and replaces `window.event`; the call-site
recipe inserts `event` in its own file. The existing multi-file transaction applies every file or
none, and a call-site file changed after the scan marks its item stale, which aborts the execution.

**Tests and mutations.** Five cross-file inline cases: definition-only and call-site-only expansion,
atomic execution across two files, rescan making the property recipes applicable, direct-call and
argument-passing negatives, a changed call-site abort, and both zh/ja message variants. Disabling
the companion expansion or the direct-call guard each turned a test red. The bundled fixture is
unchanged at 12 files / 96 findings / 29 auto-convertible.

**UI.** A `shared.js` + `page.jsp` demo: the definition finding previews as a two-item plan, the
UI auto-selects both, and the call-site diff shows `sharedRowClick(event)` while the definition
diff shows the signature and `window.event` replacements.

## 38. Thirty-fourth increment — a handler that already takes parameters

Every earlier handler path rejected a function with parameters. That was too strict for the common
JSP shape where the inline attribute passes arguments by hand: `onclick="sharedRowClick(rowId, this)"`
calling `function sharedRowClick(row, sender)`. Inserting `event` in front of both the signature and
every call is mechanical as long as the handler has no call site that the tool cannot edit.

**The edit is position-aware.** `handlerParamEdit` inserts bare `event` when the parameter list is
empty and `event, ` before the first parameter otherwise. `inlineCallEventEdit` does the same for
the call's argument list: `event` when there are no arguments, `event, ` before the first one when
there are. Existing parameters and arguments keep their order and spelling.

**Only handlers whose every call site is an inline `on*` call qualify.** A by-reference
registration (`attachEvent`, `on*` property) would pass the browser event into the old first
parameter and shift all existing meanings, so a handler with parameters and any reference
registration is rejected in both the per-file analysis and the cross-file project pass. A direct
call outside an inline attribute still blocks through the existing use check. The body gate now
also recognizes a parameter or local named `event`, and any other `event` identifier already in
scope, as a binding conflict; `arguments` use and `window.event` inside a nested function remain
exclusions.

**Facts, companions, and the plan.** Handler facts now carry parameterized definitions (with
`paramCount`) and inline calls of any arity (with `argumentCount`). The cross-file pass emits the
definition finding with a call-site companion per inline call, as before. The definition recipe
uses the position-aware signature edit; the call-site recipe inserts `event` first. The existing
multi-file transaction, plan hash, auto-selection, and stale-file abort apply unchanged, so a
parameterized cross-file group is reviewed and applied as one unit.

**Tests and mutations.** Same-file positive (`onUpdateClick(this)` with a `sender` parameter),
cross-file positive (two-item plan, both files edited), by-reference-with-parameters negatives in
both the per-file and cross-file paths, and an existing-`event` negative. Disabling the
by-reference/parameters guard in `findMigratableHandlers` or in the cross-file pass each turned its
test red, and disabling the event-binding gate turned the existing-`event` test red. The bundled
fixture is unchanged at 12 files / 96 findings / 29 auto-convertible because none of its handlers
take parameters.

**UI.** A demo project with `page.jsp` (`onclick="sharedRowClick(rowId, this)"`) and
`js/shared.js` (`function sharedRowClick(row, sender)`): selecting the definition auto-selects the
call site, the preview lists both files as 2/2 applicable, the signature becomes
`function sharedRowClick(event, row, sender)`, and the call becomes
`sharedRowClick(event, rowId, this)`.

Suite: 245 tests.

## 39. Thirty-fifth increment — window.event inside the attribute itself

The handler work covered functions, by-reference registrations and calls made from inline
attributes, but not the attribute's own code. An element such as
`onclick="window.event.cancelBubble = true; window.event.returnValue = false"` produced two
`WL-JS-003` findings plus two property findings, all MANUAL, even though an inline handler already
receives the standard event object as `event`. No signature or call-site change is needed.

**A separate rule with a separate recipe.** `WL-JS-018` fires once per inline `on*` attribute that
reads `window.event`; the finding is anchored at the first reference and records the attribute, the
reference count and the unit's start/end. `RCP-INLINE-HANDLER-EVENT` re-locates the unit, verifies
the reference count, and replaces every `window.event` span with `event`. It never touches script
blocks, where `event` is not in scope.

**The guards are part of eligibility.** A unit is skipped when: it is dynamic; it is
`onunload`/`onbeforeunload`; any binding named `event` exists (parameters, `var`/`let`/`const`,
function/class names, catch params, imports); any `window.event` sits inside a nested function; or
any reference is an assignment target, update target, or `typeof`/`delete` operand. A unit with one
clean reference and one blocked reference is excluded whole, so the finding never claims a partial
rewrite. `WL-JS-003` suppresses the references covered by an eligible unit, the same way it already
suppresses handler-covered references.

**The property recipes recognize the implicit binding.** After the rewrite and a rescan,
`event.cancelBubble = true` and `event.returnValue = false` must become applicable even though
`event` is not a parameter. `eventObjectConfidence` and the recipes' `isEventObject` now accept the
implicit event of an inline unit when that unit has no `event` binding, so both sides agree:
`WL-JS-008` reaches SAFE and `WL-JS-007` CONDITIONAL, and their recipes fire.

**Tests and mutations.** Five cases: the finding shape and suppression, the full chain
(window.event rewrite → rescan → stopPropagation/preventDefault), a negative group (top-level plus
nested reference, shadowed `event`, assignment target, `typeof` probe, script block), unload
exclusion, and the zh/ja messages. Disabling the nested-function guard, the shadowing guard, the
write/probe guard, the implicit-binding recognition, or the `WL-JS-003` suppression each turned its
test red. The parser offset test now asserts on `WL-JS-018`, since the inline reference is no longer
reported as `WL-JS-003`. The bundled fixture is unchanged at 12 files / 96 findings / 29
auto-convertible because its only inline attributes call functions and do not read `window.event`.

**UI.** A demo page with
`onclick="window.event.cancelBubble = true; window.event.returnValue = false"` previews as a
single-item plan; after applying it the attribute reads `event.cancelBubble` / `event.returnValue`,
and a rescan turns the two property findings applicable.

Suite: 250 tests.

## 40. Thirty-sixth increment — a nested helper the handler calls synchronously

Handler analysis used to reject any `window.event` inside a nested function; the test suite even
asserted that a returned closure blocked the finding. A helper declared inside the handler and
invoked synchronously during dispatch is different: the injected event parameter is already in
scope, so the rewrite is a closure capture, not a behavioural change.

**Nested references are now classified.** `inspectHandlerBody` partitions `window.event` references
by their nearest enclosing function. References in the handler's own body are always included. A
reference inside a nested function is included only when that function is a `FunctionDeclaration`
directly inside the handler, is not async or a generator, contains no `event` read or binding in its
own scope, is referenced only as a direct call callee, and has at least one such call in the
handler's top-level body. A returned closure, a callback passed to `setTimeout`, a `.call`, a call
inside another callback or a deeper nesting still sets `nestedRef` and blocks the finding.

**Why closure capture is correct.** The helper runs synchronously while the handler's event
parameter is live. The recipe injects `event` at the signature and replaces every included reference
with `event`, including those inside the helper; no call site changes. After a rescan,
`findEnclosingParam` walks past the helper to the outer handler, so the `srcElement`,
`returnValue` and `cancelBubble` recipes treat the captured object as an event argument and apply.

**Facts and cross-file paths share the inspection.** `collectHandlerFacts` and `findHandlerAt` call
the same `inspectHandlerBody`, so by-reference and cross-file definition findings include the nested
spans, suppress their `WL-JS-003` rows, and replace them when the recipe runs. The recipe version
moved to 1.5.0 (rule 1.5.0), so an old incremental result is not reused.

**Tests and mutations.** Four cases: one synchronously called helper, two helpers, the full chain
through a rescan to `stopPropagation()`/`preventDefault()`, and a cross-file by-reference definition
whose helper is rewritten through the persisted facts. Negatives: a returned closure, a
helper both called and returned, a helper passed to `setTimeout`, a call inside a timer callback,
`.call`, an async helper, a helper that binds `event`, a helper never called, an unsafe helper next
to a safe one, and a deeper nested function. Disabling the synchronous-use check, the call-site
requirement, the event-shadow check, or the async check each turned a test red. The bundled fixture
is unchanged at 12 files / 96 findings / 29 auto-convertible.

**UI.** A demo handler with `function mark()` reading `window.event` twice: the finding reports two
references, the diff injects `event` into `onRowClick` and rewrites both references inside `mark()`,
and after a rescan the two property recipes are applicable while `attachEvent` remains a separate
conditional finding.

Suite: 254 tests.

## 41. Thirty-seventh increment — reuse the parameter an event-first registration already fills

The parameter gate treated every parameterized handler registered by reference as unsafe. That is
right for `attachEvent`, which passes nothing, but wrong for `addEventListener` and `on*` properties:
the browser already passes the event as the first argument, so a handler that also reads
`window.event` only needs its references renamed.

**Candidate facts now distinguish registration kinds.** Each candidate records whether it was
registered by `addEventListener`/an `on*` property (event first) or by `attachEvent` (nothing
passed). A handler with parameters is offered in reuse mode only when it has an event-first
registration, no `attachEvent` registration, no inline call sites, and a plain first parameter that
is not named `event` (the conservative existing-binding gate still rejects that spelling). Otherwise
the previous rules apply: inline-only call sites insert `event`, and everything else with parameters
stays manual.

**The recipe skips the signature edit.** With `eventParam` in the evidence, the recipe verifies the
first parameter still has that name and that the registration is not `attachEvent`, then replaces
every `window.event` span with the parameter name; nested helpers are accepted only when the helper
does not bind that name. The finding uses `rules.WL-JS-017.reuse` and names the parameter in the
summary. Cross-file definitions with parameters are still skipped by the project pass, because the
same-file registration kind is what makes reuse safe.

**Tests and mutations.** Five cases: an `addEventListener` handler reused through `evt` (then a
rescan makes `stopPropagation` applicable), an `on*` property with `sender` (then `preventDefault`),
an anonymous handler, a nested helper, and the reuse message in zh/ja. Negatives: `attachEvent` with
a parameter, a direct call, mixed `addEventListener` + `attachEvent`, an inline call plus a
reference registration, a first parameter named `event`, a destructured first parameter,
`arguments`, a local `event` binding, and a nested helper that shadows the reused name. Disabling the
mixed-registration guard, the inline-call guard, the helper-shadow guard, or the signature-skip each
turned a test red. The bundled fixture is unchanged at 12 files / 96 findings / 29
auto-convertible.

**UI.** A demo with `function onRowClick(evt)` registered through `addEventListener`: the finding
reads "已通过 evt 接收事件…", the diff changes only the two `window.event` references, and after a
rescan the `cancelBubble`/`returnValue` recipes are applicable.

Suite: 259 tests.

## 42. Thirty-eighth increment — the button numbering that silently changes meaning

The rule set covered `window.event`, `srcElement`, `returnValue` and `cancelBubble`, but not
`event.button`. IE reported left/right/middle as 1/2/4 and could combine them; Chrome reports a
single standard button as 0/1/2 and exposes held buttons through `event.buttons`. Comparing the same
number therefore changes meaning without throwing, which is exactly the silent breakage the tool
exists to surface.

**One rule, two levels.** `WL-JS-019` matches `.button` only on a confirmed event object — a handler
parameter or the implicit inline-handler `event` — and skips `window.event.button`, which `WL-JS-003`
already covers. An equality/inequality (`==`, `===`, `!=`, `!==`) against the literal 1 or 4 is
`CONDITIONAL`; every other read, bitmask test, comparison against 0/2/3 and combined-button use is
`MANUAL`. The finding records the compared literal (or `(expression)`) in its evidence.

**The recipe rewrites only the literal.** `RCP-EVENT-BUTTON` re-locates the member and its immediate
comparison, checks that the object is still a confirmed event, and replaces 1 with 0 (left) or 4
with 1 (middle); the operator and the rest of the expression are untouched. The caveats state that
bitmask tests and held-button logic need `event.buttons`, and that on `mousemove` IE's "no button" 0
collides with Chrome's left-button 0.

**Why the other values stay manual.** Right is 2 in both models, but a value that matches by
coincidence is not a migration; combined IE values (3, 5, 6, 7) and 0 have no single-button Chrome
equivalent. The honest replacement for held-button logic is the `buttons` bitmask, which the recipe
cannot synthesize from a `button` comparison.

**Tests and mutations.** Five cases: level mapping across `==1`, `4===`, `!=4`, `==2`, bitmask and a
plain read; the implicit inline-handler event; lookalikes (`obj.button`, `event.buttonId`,
`event.buttons`, `custom.button`) and `window.event.button`; a full preview/execute that changes the
literal to 0; and the zh/ja messages. Disabling the 1/4 gate, the comparison-operator gate, or the
confirmed-event gate each turned a test red. The bundled fixture has no `event.button`, so it stays
at 12 files / 96 findings / 29 auto-convertible.

**UI.** A demo `mousedown` handler with `event.button == 1` and `event.button & 4`: only the literal
comparison appears as a migration item, and its diff changes `1` to `0`; the bitmask line remains a
manual finding.

Suite: 264 tests.

## 43. Thirty-ninth increment — three more blind spots that fail quietly

`event.srcUrn`, `event.recordset` and `style.setExpression` were listed in the limitations as
invisible, and each fails without a recognizable exception in Chrome.

**Three detection rules, no invented recipes.** `WL-DOM-015` matches `srcUrn` only on a confirmed
event object and stays MANUAL: the URN came from an HTML behavior, which needs a component
redesign. `WL-DOM-016` matches `recordset` on a confirmed event and is UNSUPPORTED: IE data binding
has no Chrome subsystem to map onto. `WL-JS-020` matches `setExpression`/`removeExpression` calls
on a style object (`element.style` or an identifier ending in `style`) and is MANUAL: the expression
ran continuously and needs to become an explicit style update. `window.event.*` forms stay with
`WL-JS-003`, so the same reference is never counted twice.

**Guards are part of the detectors.** `srcUrn`/`recordset` require an event-like parameter of the
enclosing function or the implicit inline-handler `event`; `obj.recordset` and `obj.srcUrn` do not
match. `setExpression` requires the call target to look like a style object, so a custom
`custom.setExpression()` does not match; `myStyle.setExpression()` does.

**Tests and mutations.** Four cases: `srcUrn` on a parameter and inline event with lookalikes and
`window.event`; `recordset` on a parameter and inline event plus non-event objects; `setExpression`
and `removeExpression` on style objects with lookalikes; and zh/ja rendering for all three. Removing
the event-confirmed gate from `srcUrn` or `recordset`, the style-object gate from
`setExpression`, or the `removeExpression` alternative each turned a test red. The bundled fixture
contains none of the three APIs, so it stays at 12 files / 96 findings / 29 auto-convertible.

**UI.** A demo file with one use of each API reports `WL-DOM-015` (manual), `WL-DOM-016`
(unsupported) and `WL-JS-020` (manual) on the findings page; none appears as a migration item,
which is the honest outcome.

Suite: 268 tests.

## 44. Fortieth increment — the lock queue becomes strictly FIFO

The project lock was bounded but unfair: every waiter polled the same row, and whichever process
happened to poll after a release won. That is acceptable for one user and unacceptable once a CLI
and the UI compete for the same project, because the loser can starve across several attempts.

**A ticket table makes the order explicit.** `project_lock_queue` stores `(project_id, token,
owner_pid, ticket, created_at)`; a ticket is `MAX(ticket)+1` for the project, allocated inside the
same `BEGIN IMMEDIATE` transaction that inserts it. `tryAcquireProjectLock` removes dead waiters,
lets the current owner re-enter, reclaims a dead owner, and then checks the lowest live ticket: only
that token may take the free lock. A caller without a ticket cannot jump a live waiter. When the
lock is free but an earlier ticket exists, the failure carries `queued: true` and the waiter's
pid/time, which `projectBusyReason` renders differently from "already running".

**Tickets are removed on every exit path.** `acquireProjectLock` enqueues before its first attempt
and removes the ticket in `finally`, so timeout and cancellation do not leave a stale waiter that
blocks later callers; a successful acquire deletes the ticket as part of the grant. Scan start
enqueues before its immediate attempt and drops the ticket when the wait is disabled. Dead waiters
are also cleaned lazily on the next enqueue or acquire, and `releaseProjectLock` deletes any ticket
for the owner token.

**Tests and mutations.** Store-level tests cover strict order while the lock is free, a caller
without a ticket being refused, dead-waiter cleanup, and the `queued` flag. Async tests cover two
concurrent `acquireProjectLock` calls resolving in enqueue order and timeout/cancellation removing
tickets. Disabling the lowest-ticket check, the dead-waiter cleanup, or the `finally` dequeue each
turned a test red. A two-process script (parent holds, children B then C enqueue) printed
`queue B,C`, then `B acquired` followed by `C acquired`, with C blocked until B released.

**UI.** A waiting scan or migration still shows `waitingFor`; when another waiter is ahead while the
lock is momentarily free, the text now says it is queued behind that operation instead of claiming
an owner is running.

Suite: 273 tests.

## 45. Forty-first increment — alpha-only filters become opacity

`filter: alpha(opacity=90)` and its `-ms-filter` progid twin are the most common IE CSS leftovers,
and they are mechanically equivalent to `opacity`. The rule already reported them, but every
occurrence stayed MANUAL because dropping an arbitrary filter could remove gradients or shadows.

**The value must be alpha-only.** `alphaOpacityValue` accepts exactly `alpha(opacity=N)` or
`progid:DXImageTransform.Microsoft.Alpha(Opacity=N)` (quotes stripped) with N between 0 and 100.
`WL-CSS-003` promotes an opacity finding to CONDITIONAL only when that parser succeeds and records
the numeric value in evidence; filtered values that combine alpha with a gradient, shadow or other
effect remain MANUAL, as do gradients themselves.

**The recipe replaces the declaration, not just the token.** `RCP-FILTER-OPACITY` re-reads the
declaration, verifies the property is `filter`/`-ms-filter` and the value is still alpha-only,
refuses when the same rule already declares `opacity`, and replaces the declaration with
`opacity: N/100`. It preserves `!important` and the trailing semicolon. The caveats name the real
semantic gap: `opacity` creates a stacking context and fades descendants, so layered and nested
content needs a visual check.

**Tests and mutations.** Three cases: level mapping across alpha, MS Alpha, opacity 100, mixed
alpha+gradient and shadow; a full migration of three declarations that leaves the gradient and
shadow untouched; and the duplicate-opacity refusal. Disabling the alpha-only gate, the duplicate
guard, `!important` preservation, or the semicolon preservation each turned a test red. The fixture
moves from 29 to 31 auto-convertible (10 SAFE, 21 CONDITIONAL) and from 57 to 55 manual
(recipe-blocked 9 -> 7); the catalog is 62 rules / 17 recipes, and the suite is 276 tests.

**UI.** A demo stylesheet with two alpha filters and one gradient: both alpha declarations appear as
migration items with diffs to `opacity: 0.9` and `opacity: 0.85 !important`, while the gradient
remains a manual finding and is not touched by the applied plan.

Suite: 276 tests.

## 46. Forty-second increment — simple IE gradients become linear-gradient

The gradient half of `WL-CSS-003` stayed manual: `progid:DXImageTransform.Microsoft.gradient(...)`
was reported, but dropping an arbitrary filter could remove shadows or combined effects. A single
two-color gradient is mechanically mappable, and the fixture's `.app-header` is exactly that shape.

**Only the strict two-color form parses.** `ieGradientValue` requires a single
`gradient(startColorstr=..., endColorstr=...)` call, optionally with `gradientType=0|1`, both colors
as 3/6-digit hex, no unknown arguments, and no quotes beyond the outer `-ms-filter` pair. 8-digit
ARGB colors, extra stops, missing colors, shadows and mixed filter lists return null and stay
MANUAL. `WL-CSS-003` (1.2.0) promotes only parsed gradients and records direction and colors in
evidence.

**One filter recipe, two branches.** The recipe registry maps one recipe per rule, so the alpha and
gradient conversions live in `RCP-IE-FILTER`: alpha values become `opacity: N/100`, gradients become
`background-image: linear-gradient(to bottom|to right, start, end)`, and both preserve `!important`
and the trailing semicolon. Gradient preconditions additionally refuse an existing
`background-image` in the same rule and a `background` shorthand declared after the filter; `opacity`
preconditions refuse a second `opacity`. A `background` shorthand before the filter is kept as the
fallback color.

**Tests and mutations.** Three gradient cases: level mapping across alpha, MS Alpha, two valid
gradients, an 8-digit ARGB color, a mixed filter and a missing end color; a full migration that
converts three declarations while preserving fallback, direction and `!important`; and the two
cascade conflicts (existing `background-image`, later `background` shorthand) being blocked.
Disabling the gradient parser, the direction mapping, the ARGB color guard, or either cascade guard
each turned a test red. The fixture moves from 31 to 32 auto-convertible (10 SAFE, 22 CONDITIONAL)
and from 55 to 54 manual (recipe-blocked 7 -> 6); the catalog stays at 62 rules / 17 recipes and the
suite is 279 tests.

**UI.** A demo rule with `background: #003366` and a two-color gradient filter previews as
`background-image: linear-gradient(to bottom, #003366, #005599)` while the fallback color is kept;
gradients with unsupported colors stay manual.

Suite: 279 tests.
