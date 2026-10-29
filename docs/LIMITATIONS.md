# Known limitations and next steps

Written to be read before someone trusts a number in the UI. Each item states the limit,
what it means for a real migration, and the smallest honest workaround.

---

## Analysis

**Only the implemented pattern set is detected.** 42 rules cover the IE features listed in the
specification plus a few closely related ones. Anything outside that set is invisible: a legacy
`document.body.clientHeight` quirk used for layout, `element.currentStyle`, `navigator.appName`
branches written as comparisons against other IE strings, and so on. A clean scan means "none of
the covered patterns were found", not "this page works on Chrome".

**Comment and string safety is per-rule.** The AST-based rules cannot match inside comments or
string literals. Two rules are text-based by necessity — conditional compilation (`@cc_on`) and
CSS value hacks — because the pattern *is* the literal text. They are documented as such and
their messages say so.

**JSP analysis is fragment-level.** Only `<script>`, `<style>` and inline handler attributes are
analyzed as real code. A scriptlet that emits an entire `<script>` block at runtime is masked,
recorded as a dynamic region, and cannot be inspected. Server-side generated handler names,
URLs and event names are therefore unknown.

**No cross-project analysis.** Each project is scanned alone. A shared script living outside the
project root will be reported as an unresolved reference rather than followed.

**Call graph resolution is shallow.** `SHARED_FUNCTION_CALL` edges come from global function
names. Aliases, `window["fn"]`, reassignment and prototype methods are not resolved. That is why
those edges are labelled `INFERRED`, and why ambiguous names are `UNKNOWN` rather than guessed.

---

## Migration

**Disabling a rule is not retroactive by itself.** The toggle affects new scans only; an existing
scan keeps its findings until someone re-evaluates it, which the scan page offers as a one-click
action when it notices the rule signature no longer matches. Re-evaluation silences findings of
disabled rules with a note and restores them when the rule comes back, but it cannot *add* findings
that a newly enabled rule would produce — that needs a rescan.

**Ignore rules match rule + path, not code identity.** A rule silences "this rule in these files",
which is right for accepted technical debt, but it cannot say "just this one occurrence" — use the
per-finding ignore for that. Rules apply at scan time, so earlier scans keep their original
statuses; nothing is rewritten retroactively. A rule can be created from the finding detail
(scope: this file / this directory / any file) and both forms count the impact before saving:
matched / already ignored / newly ignored, plus a per-rule breakdown so a path-only rule that
would swallow 20 findings is visible as such. That count is computed against the newest completed
scan; creating the rule does not retro-apply it, so the visible result still arrives on the next
scan (the dialog offers a rescan button).

**Thirteen recipes, and "manual" covers three different situations.** Shipped recipes:
`attachEvent`, `detachEvent`, `srcElement`, `cancelBubble`, `returnValue`, `fireEvent`,
`execScript`, the obsolete `<script language>` attribute, the `X-UA-Compatible` meta tag, IE CSS
hack removal, and renaming a `-ms-` property whose value syntax matches the standard one.
Everything else is reported as MANUAL or UNSUPPORTED, but MANUAL is not one thing:

| Situation | Fixture count | What it really means |
| --- | --- | --- |
| Recipe exists, this occurrence fails its preconditions | 9 | Fix the surrounding code first — most of these are `window.event.returnValue = …`, which becomes convertible once the handler takes the event parameter. |
| Mechanical rewrite exists, recipe not implemented yet | 4 | Labelled "automatable later" in the UI with the reason. Remaining: `createEventObject`, `document.selection.createRange()`, and the `-ms-` properties whose value syntax differs (`-ms-flex`, `-ms-writing-mode`). |
| Needs human judgement or a product decision | 54 | `showModalDialog` control flow, UA-sniff branch semantics, ActiveX/VBScript capability gaps, `.htc` behaviours, generated code. |

The first version of this tool collapsed all three into one MANUAL badge, which made real
opportunities look impossible. The dashboard now reports "automatable later" separately.

**`CONDITIONAL` is not a promise of equivalence.** Rewriting `attachEvent` to `addEventListener`
changes what `this` refers to inside the handler and requires handlers that read `window.event`
to take the event parameter instead. The recipe cannot see those consequences; the UI lists them
as caveats that a human must confirm.

**A transaction covers one execute() call, nothing more.** One call is one session: every file
it touches is prepared (hash check, backup, in-memory edit, re-parse) before anything is written,
and a failed write compensates the files already written. What it does not cover:

- Two separate execute() calls are two transactions; there is no way to group them later.
- There is no lock. Two people running migrations on the same checkout are protected only by the
  per-file hash check, which fails the second transaction rather than merging it.
- A rollback restores every file in the session or none of them; there is no per-file undo inside
  a multi-file transaction (per-file rollback exists at the batch level via the API).

The UI groups history by transaction so the unit that can actually be reverted is the unit shown.

**No merge with concurrent edits.** If a file changes between preview and execution the write is
refused. That is deliberate, but it means a long review session may need a re-scan before applying.

**Rollback is last-writer-wins.** Rollback refuses when the file no longer matches the recorded
`afterHash`, because restoring would discard newer edits. In that case the tool tells the user to
restore from version control instead of guessing.

---

## Validation

**The report summarises comparisons, it does not embed them.** The HTML/JSON report lists every
migration and every verification run, including the per-page diff percentage and changed pixel
count, but the before/after images stay in the UI: a single screenshot is ~150 KB, and base64 in
the report would multiply that by the number of pages. CSV export remains findings only.

**Module grouping is path-prefix based.** A finding is attributed to the first configured module
whose path prefixes the file; a file outside every configured path falls back to the first module,
which is right when that module is the project root and misleading when it is not. Modules are a
project setting, so changing them changes the grouping of *future* summaries only.

**Scan comparison matches on the snippet, not on the code's identity.** A finding is "the same"
when rule + file + whitespace-normalised snippet match, so a line that merely moved is correctly
unchanged while a rewritten line shows up as fixed + introduced. The catch: reformatting a matched
line makes it look replaced, and a file renamed between scans loses all its matches. Comparison
also stops at 200 sample rows per side — the counts in the roll-up tables are complete.

**Static validation is rule-level, per file.** It checks that the migrated rule stopped being
reported for that file and that the file still parses. It cannot prove the feature still works.

**Browser validation needs an installed browser.** Playwright is a dev dependency and Chromium
is downloaded separately; without it the endpoint answers `available: false` with instructions
rather than failing. When present, the load check reports page errors and failed requests for a
single URL.

**Before/after screenshots need a running app.** The migration compares the page against itself
captured seconds earlier, which requires the app to be served: a JSP page cannot be rendered from
the backup copy. Captures happen inside `execute()`, so a slow page delays the write by roughly two
screenshot times per page (max five pages). A page that fails to capture is reported per page and
never fails the migration.

**Visual regression is one viewport and one fixed threshold.** A capture is 1280×900 full page,
compared against one baseline per page key with a per-channel threshold of 12. There is no
multi-viewport matrix, no region masking (a live clock or ad slot will always differ), and no
anti-aliasing-aware comparison. A zero-diff result means "this page did not change at this
viewport", not "the layout is correct".

**Visual baselines are per project and page key, stored on disk.** They are not versioned with
the code, so a baseline captured against a broken page will happily "pass" forever. Re-capture
deliberately, and treat a baseline update as a reviewable change.

**Visual baselines are browser-build specific.** Re-capturing the same page with a different
Chromium build produced an 8.8% pixel difference on identical markup and CSS (font
rasterisation), while re-captures on the same build are 0 px. Pin the browser version, or
refresh baselines whenever Playwright upgrades — otherwise every comparison reports noise.

---

## Platform

**Single-machine, single-user.** SQLite in `./data`, no authentication, no multi-tenant isolation.
The API binds to localhost only; it is not hardened for exposure to a network.

**No source snapshots are stored.** Findings reference file paths and hashes, not file contents.
If the file changes, the UI flags the finding as stale and refuses to migrate; it does not show
the original code. Version control is the intended source of history.

**Encoding candidates exclude GBK/GB18030.** Per the product decision for this build they are not
auto-detected. A GBK file without a declared charset will be decoded as UTF-8 with replacement
characters, reported as a decode problem, and its findings may be mislocated. Set `forceEncoding`
per project in that case.

**A file that is not UTF-8 is scanned, but never migrated.** Detection, parsing and finding
locations all work for Shift_JIS / EUC-JP / ISO-2022-JP, but writing back would require re-encoding
the whole file, and the tool has no encoder for those charsets. Rewriting one as UTF-8 destroys
every non-ASCII character in it — this was the behaviour until it was caught by review and covered
by `backend/test/encodingSafety.test.ts`. Such files are now refused at preview time with an
explicit reason; convert the file to UTF-8 (or migrate it by hand) and rescan.

**Large-file and binary handling is coarse.** Files above 2 MB are skipped with a recorded reason;
binary detection is a NUL-byte probe over the first 8 KB.

**Incremental scans skip parsing, not file reads.** A file is reused only when its SHA-256 and
the rule signature both match the previous scan, so every file is still read once. On a normal
filesystem that read is negligible; in a sandboxed environment it dominated the measurement
(1 440 files, 2 MB: 9.5 s of read+hash versus 5.4 s of parsing). The measured end-to-end gain was
therefore only ~11 %, while the CPU work it removes is ~38 %. A size+mtime fast path would avoid
the read, but the tool trades that speed for the guarantee that a reused finding was computed from
the exact same bytes.

**Worker threads are available but off by default.** Measured on the 1 440-file project:
in-process 13.2 s, 2 workers 12.7 s, 4 workers 14.3 s, 8 workers 14.6 s. Per-file I/O plus
cloning findings back dominates, so extra workers add contention; `WEBLIFT_WORKERS=2` is the only
setting that helped at all (~4 %). Enable it deliberately on a machine where parsing, not I/O, is
the bottleneck — it is not a default because it measured slower.

**Performance is single-process and synchronous per file.** The fixture (12 files) scans in ~0.3 s.
A 5 000-file legacy tree will work but blocks the event loop in bursts; the orchestrator yields
every 8 files so SSE progress and cancellation stay responsive. Parallel workers are the obvious
next step.

**Cancelling a scan stops between files, and keeps what it finished.** A file is written only once
it has been fully analysed, so the stored rows of a cancelled scan are a clean prefix of the work,
never a half-parsed file. The next scan on the same project picks it up: files whose SHA-256 and
rule signature match are reused, the rest are parsed. Two caveats:

- Granularity is one file. A single enormous file cannot be interrupted midway.
- With a worker pool (`WEBLIFT_WORKERS`) every file of the batch is dispatched at once, so
  cancellation is only observed as replies arrive — files already in flight still complete. The pool
  is off by default, and this is one more reason not to turn it on for large trees.

---

## Suggested next steps, in order of value

1. **More recipes for the highest-volume patterns** once real projects show which ones dominate —
   `document.all`, `element.innerText` and `window.event` handler signatures are the likely
   candidates, each needing its own precondition argument.
2. **Persist progress while the scan runs, not only when it stops.** A cancelled or failed scan is
   saved, but a hard kill (`SIGKILL`, power loss) still loses the run, because rows are written when
   the run ends. Writing a batch every N files would make even that case resumable.
3. **Manual-status adoption.** Every MANUAL finding currently keeps its initial status until someone
   touches it; a lightweight "fixed in code, verified by the next scan" loop would turn the dashboard
   into a real burn-down chart instead of two independent snapshots.

