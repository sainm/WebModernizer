# Known limitations and next steps

Written to be read before someone trusts a number in the UI. Each item states the limit,
what it means for a real migration, and the smallest honest workaround.

---

## Access and data safety

**The API is local-only and unauthenticated.** It binds `127.0.0.1` and only grants CORS to loopback
origins, because it can rewrite project files. Do not expose it (`WEBLIFT_HOST=0.0.0.0`) on a network
you do not control: there is no login, no token and no per-user isolation. Anyone who can reach the
port can scan any directory that user can read, read the sources back, and apply migrations.

**Migrations keep the originals, but only as long as the data directory does.** Every written file is
copied to `backups/<executionId>/<path>` and hash-verified before the write, and rollback refuses if
the file drifted since. Deleting the data directory therefore deletes the only backup the tool made.

**Migrations and scans are serialized per project across processes, with a bounded wait.** A
database lock (owner pid + token) makes a second operation wait up to 30 seconds
(`WEBLIFT_LOCK_WAIT_MS`) instead of interleaving, and the in-process queue still orders operations
inside one process. A scan that has to wait stays `QUEUED`, shows the owner's pid and acquisition
time, then starts when the lock is released; at the deadline it fails with a timeout reason.
Migrations and rollbacks wait the same way and write nothing if the deadline expires. The lock is a
bounded retry, not a FIFO queue: several waiters race, which is acceptable for a single-user tool. A
live but hung owner holds the lock until the deadline (or until it is stopped), and PID reuse is a
theoretical way to mistake a stale lock for a live owner. A rollback during an in-process migration
is still refused immediately rather than queued.

**A transaction is claimed in the database before it touches the disk.** If the process is killed
between the write and its confirmation, the row stays `PENDING` and the history shows it as
interrupted; rolling it back either restores the backup or, when the file still matches its original
hash, records that nothing was written. What this cannot survive is the death of the process *before*
the claim, or a disk that loses the file after a successful write.

## Analysis

**Only the implemented pattern set is detected.** 58 rules cover the IE features listed in the
specification plus removed APIs found in real legacy code. Anything outside that set is still
invisible: a legacy `document.body.clientHeight` layout quirk, `event.srcUrn`, `event.recordset`,
`style.setExpression`, and so on. A clean scan means "none of the covered patterns were found", not
"this page works on Chrome".

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

**Fourteen recipes, and "manual" covers three different situations.** Shipped recipes:
`attachEvent`, `detachEvent`, `srcElement`, `cancelBubble`, `returnValue`, `fireEvent`,
`execScript`, the obsolete `<script language>` attribute, the `X-UA-Compatible` meta tag, IE CSS
hack removal, renaming a `-ms-` property whose value syntax matches the standard one, and the
function-level handler-signature rewrite. Everything else is reported as MANUAL or UNSUPPORTED,
but MANUAL is not one thing:

| Situation | Fixture count | What it really means |
| --- | --- | --- |
| Recipe exists, this occurrence fails its preconditions | 9 | Fix the surrounding code first — most of these are `window.event.returnValue = …` outside an eligible handler. |
| Mechanical rewrite exists, recipe not implemented yet | 4 | Labelled "automatable later" in the UI with the reason. Remaining: `createEventObject`, `document.selection.createRange()`, and the `-ms-` properties whose value syntax differs (`-ms-flex`, `-ms-writing-mode`). |
| Needs human judgement or a product decision | 44 | `showModalDialog` control flow, UA-sniff branch semantics, ActiveX/VBScript capability gaps, `.htc` behaviours, generated code. |

The first version of this tool collapsed all three into one MANUAL badge, which made real
opportunities look impossible. The dashboard now reports "automatable later" separately.

**`CONDITIONAL` is not a promise of equivalence.** Rewriting `attachEvent` to `addEventListener`
changes what `this` refers to inside the handler and requires handlers that read `window.event`
to take the event parameter instead. The handler-signature recipe does that for handlers registered
by reference in the same or another scanned file, and for handlers reached only through
`on*="fn(...)"` calls in the same or another scanned file; existing parameters and arguments keep
their order with `event` inserted first. A handler with existing parameters that is also registered
by reference, a handler called outside an inline `on*` attribute, and registrations outside the
project still need a human. The recipe cannot see those consequences; the UI lists them as caveats
that a human must confirm.

**Function-level handler migration is deliberately narrow.** It offers a zero-parameter handler when
all of these hold across the scanned files: a registration by reference through `attachEvent`,
`detachEvent`, `addEventListener`, `removeEventListener` or an `on*` property; the function name has
no other use anywhere in the scanned files (a direct call, timer or callback blocks it); no
`arguments` use; no local `event` binding or parameter named `event`; and not
`beforeunload`/`unload`. A nested helper may read `window.event` only when it is declared in the
handler, called directly from the handler body, not async or a generator, and does not bind
`event`; a returned, passed, timer-invoked or deeper-nested helper blocks the finding. A handler
with existing parameters is offered only when every call site is an inline `on*` call, because a
by-reference registration would pass the browser event into the old first parameter instead of the
new one. The recipe injects `event` first and replaces the handler's `window.event` references,
including those in a synchronously called helper. For a cross-file registration the finding is emitted in the definition file (a `.js`
file), the registration file is not edited, and preview verifies that the registration file still
has the hash it had at scan time; if it changed, the finding is blocked until a rescan. Inline
`on*="fn(...)"` calls in the same or another file are a source; existing arguments are kept and
`event` is inserted before them. Same-file calls are edited by the handler's recipe; a cross-file
call site becomes its own finding linked to the definition by companion ids, so selecting either
expands the plan to the definition and every call site. The multi-file transaction applies them
together, and every call-site file must still match its scan-time hash: a changed call site marks
the item stale and the execution refuses the whole plan. A non-inline call or an inline unit that
intersects a JSP dynamic region blocks the group. The per-reference `window.event` findings covered by a handler are
suppressed (in-file during analysis, cross-file in the project pass) and the file row's finding
count is adjusted. Property rewrites (`srcElement`, `returnValue`, `cancelBubble`) become applicable
only after a rescan, and the `attachEvent` registration is a separate migration.

**Inline handler attributes are a separate, narrower migration.** An `onclick="..."` attribute
already receives the standard event object as `event`, so `WL-JS-018` replaces `window.event`
inside the attribute without any signature or call-site edit. The rule skips dynamic units,
`onunload`/`onbeforeunload`, attributes that declare their own `event` binding, `window.event`
inside a nested function, and uses as an assignment target or a `typeof`/`delete` probe. After a
rescan, the `srcElement`/`returnValue`/`cancelBubble` recipes apply because the bare `event` is
recognized as the implicit inline-handler argument; `window.event` in script blocks still requires
the function-level migration.

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

**Manual fix verification is next-scan-only and identity-based.** Marking a finding `FIXED_IN_CODE`
only schedules verification. The next completed scan that shares the rule signature checks it, and
only for files that were parsed completely in that scan; a skipped, binary, oversized or partially
parsed file leaves the claim unverified. Identity is rule + file + whitespace-normalised snippet, so
reformatting can look like a fix, and a rename or rule-set change defers verification. A disabled
rule is skipped. If the finding is still present, both the old claim and the current occurrence
become `VALIDATION_FAILED` (an occurrence ignored by a project rule is not overwritten); a later
scan that no longer finds it validates the old claim. The burn-down still counts code, not statuses.

**Browser validation needs an installed browser.** Playwright is a dev dependency and Chromium
is downloaded separately; without it the endpoint answers `available: false` with instructions
rather than failing. When present, the load check reports page errors and failed requests for a
single URL.

**Before/after screenshots need a running app.** The migration compares the page against itself
captured seconds earlier, which requires the app to be served: a JSP page cannot be rendered from
the backup copy. Captures happen inside `execute()`, so a slow page delays the write by roughly two
screenshot times per page (max five pages). A page that fails to capture is reported per page and
never fails the migration.

**Visual regression supports a viewport matrix, with a fixed capture size and threshold per
viewport.** The matrix endpoint captures desktop/tablet/mobile (or caller-supplied viewports) and
stores one baseline per `<pageKey>@<viewport>`; selector masking is applied before comparison. Each
capture is a full-page screenshot at that viewport's size, compared per channel with threshold 12,
and a size change counts as a mismatch. There is no anti-aliasing-aware comparison. A zero-diff
result means "this page did not change at this viewport", not "the layout is correct".

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

**Non-UTF-8 files are migrated in their own encoding, but only when the rewrite round-trips.**
The file is decoded once, recipes edit that text, and the result is encoded back in the recorded
encoding. Before anything is written, the tool decodes those bytes strictly and refuses the finding
unless the result is character-for-character identical to the edited text. An unrepresentable
character is never substituted with `?`; it blocks that finding, while the rest of the reviewed plan
can still apply. BOMs are re-emitted from the original bytes, line endings are untouched, and
rollback restores the original bytes. ISO-2022-JP is stateful, so the encoder may choose different
escape sequences than the source even when the decoded text is identical. A forced encoding with no
available encoder remains scan-only.

**UTF-16 sources need a BOM to be discovered.** UTF-16 text is full of NUL bytes, which the binary
probe reads as binary; the BOM exempts the file from that rule. UTF-32 is not a supported source
encoding and stays classified as binary.

**Large-file and binary handling is coarse.** Files above 2 MB are skipped with a recorded reason;
binary detection is a NUL-byte probe over the first 8 KB.

**The burn-down counts code, not triage.** Ignoring a finding does not lower the line — the pattern
is still in the file. Interrupted scans are excluded from the chart, so a cancelled run does not
look like a cliff.

**The trend is only recorded when the rule set is unchanged.** A scan after a rule change shows no
delta, because the two numbers would not be comparable. Comparing any two scans by hand (the Compare
page) still works; it says what it is comparing.

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
every 8 files so SSE progress and cancellation stay responsive. Worker threads are available but
off by default (see above), and the batched commit path is what makes a hard kill recoverable.

**Cancelling a scan stops between files, and keeps what it finished.** A file is written only once
it has been fully analysed, so the stored rows of a cancelled scan are a clean prefix of the work,
never a half-parsed file. The next scan on the same project picks it up: files whose SHA-256 and
rule signature match are reused, the rest are parsed. Two caveats:

- Granularity is one file. A single enormous file cannot be interrupted midway.
- With a worker pool (`WEBLIFT_WORKERS`) every file of the batch is dispatched at once, so
  cancellation is only observed as replies arrive — files already in flight still complete. The pool
  is off by default, and this is one more reason not to turn it on for large trees.

**A hard-killed scan keeps its last committed batch.** Results are persisted every 25 files by
default (`WEBLIFT_SCAN_FLUSH_EVERY` overrides it) in one transaction covering files, findings,
parse problems and reference facts; the file row is written last, so its presence proves the rest
of that file's batch is there. A kill loses only the files since the last commit, which are
re-parsed. On the next start, a `RUNNING` scan whose recorded PID is no longer alive is marked
`FAILED` with a reason, and the next scan reuses the persisted prefix. The project lock is reclaimed
the same way, so a killed scan does not leave the project blocked. One limit remains: scans written
before reference facts were stored have none, so a resumed scan copies their relations from the
interrupted run and logs a warning instead of rebuilding them.

---

## Suggested next steps, in order of value

1. **More recipes for the highest-volume patterns** once real projects show which ones dominate.
   The function-level handler signature now covers zero-argument handlers registered by reference,
   same-file inline calls, cross-file inline calls, and parameterized handlers whose call sites are
   all inline `on*` calls; inline attributes rewrite their own `window.event`; synchronous nested
   helpers are covered. The remaining candidates are timers/async callbacks that read
   `window.event` (they need a capture decision) and by-reference registrations of parameterized
   handlers, each needing its own precondition argument.
2. **Broaden detection coverage further.** Remaining examples include `event.srcUrn`,
   `event.recordset`, `style.setExpression` and the layout quirks around
   `document.body.clientHeight`. Each needs a rule, metadata and a firing fixture before it can be
   reported.
3. **Make the project lock a strict FIFO queue.** Waiters currently poll and race; operations are
   bounded and visible, but not ordered. A ticket table would make the order predictable when a
   CLI and the UI compete for the same project.

