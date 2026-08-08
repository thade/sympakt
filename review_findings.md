# Review findings — `feature-syntakt-direct-transfer` vs `main`

Reviewed 2026-08-08 at high effort. 42 candidate findings were verified in batches; 10 correctness findings survived (ranked most-severe first below), 4 candidates were refuted as intentional changes, and the conciseness/simplicity findings cut by the finding cap are written up in full in the second section.

**Goals for fixes:** maximize conciseness and simplicity, while minimizing changes to pre-existing code to reduce the risk of breaking other functionality.

## Status: all 17 findings fixed (2026-08-08)

All fixes are applied to the working tree; `tsc`, `vite build`, and all 71 tests pass. Notable deviations from the recommendations below, discovered during implementation:

- **F2 went deeper than the report suggested.** The ASCII constraint wasn't just the one assertion — it was baked into `buildSyntaktDataSample` and the backup manifest parser too. Fixed at the root with an exact reverse of the windows-1252 decoding (`encodeSyntaktSampleName` in `syntakt-data-sample.ts`, built from the same `TextDecoder` used for reads, so round-tripping is correct by construction); `assertRestorableSyntaktName` now delegates to it.
- **F5's validation already ran before any device I/O** (the intent-build loop precedes the first SysEx command), so the real defects were the healthy session being torn down and the missing slot context. Both fixed: preflight errors now name the offending Sympakt slot, and the dialog only invalidates the connection for `SyntaktBatchTransferError` (thrown only after device I/O began).
- **`uploadSympaktBank` was removed entirely**: the dialog now calls `prepareSampleExports` itself on a snapshot with a revision re-check (F8) and derives the mappings from the prepared list (F6), which made the wrapper dead code.
- **F9's golden CRCs are hardcoded captured constants** (content block `f5 f2 11 ad`, footer block `f3 24 54 ff`, stored content hash `95 49 1f 0d`), and the footer assertion now covers all 12 footer bytes including the previously unchecked embedded content hash.
- **One test premise changed with F2**: a device slot named `é` is now legitimately backupable (new round-trip test); the cannot-back-up case uses `☂`, which windows-1252 genuinely cannot store.

## Blast radius under the minimal-change goal

Almost everything Syntakt-related is new on this branch (`syntakt-*.ts`, `elektron/*`, `midi/*` are all added files), and the findings in modified files (`app-shell.ts`, `zip-service.ts`) sit on branch-added lines. Every finding below has a fix confined to new files or branch-added lines. Two tempting fixes would leak into pre-existing shared code and should be avoided:

- **Do not** change `bank-state.getSlots()` to return a defensive copy (finding 8) — every existing consumer relies on the current semantics. Snapshot in the new export path instead.
- **Do not** add duration/emptiness caps inside the shared `prepareSampleExports` (finding 5) — it is the refactored core of the pre-existing ZIP export, whose behavior should stay identical. Validate in the new transfer path instead.

## Correctness findings

### 1. Hidden tab suspends `requestAnimationFrame`, stalling the transfer mid-write
`src/components/syntakt-transfer-dialog.ts:571`

The export progress callback awaits `nextPaint()` — a bare double `requestAnimationFrame` — so a hidden or backgrounded tab suspends rAF and stalls the device transfer indefinitely between SysEx commands.

**Failure scenario:** A user starts a 64-slot export and switches tabs mid-transfer. `uploadPreparedSamples` awaits `onProgress` between every backup read, write, and verify step (`syntakt-transfer.ts:138,153,173,186`); `nextPaint` (dialog lines 722–724) never resolves in a hidden tab and there is no `setTimeout` fallback or `visibilitychange` handling. The 5 s session timeout only covers in-flight commands, so the Syntakt is left mid-bank-write with slots partially overwritten for as long as the tab stays hidden.

**Minimal-change fix:** race the double-rAF against a short `setTimeout` (~100–250 ms) inside `nextPaint`. Entirely within the new dialog file.

### 2. ASCII-only name assertion rejects legitimate device slot names during backup
`src/services/syntakt-transfer.ts:133`

The backup phase applies `assertBackupTargetName` (ASCII-only, via `assertRestorableSyntaktName`) to names read **off the device**, but the device format legitimately stores non-ASCII names (`parseSyntaktDataSample` decodes windows-1252) — so one accented slot name on the hardware makes every export fail.

**Failure scenario:** A device slot holds a sample named with any non-ASCII character (e.g. `Böö`) and the same-numbered Sympakt slot is occupied. Every "Export to Syntakt" attempt throws "sample names must be 1-16 ASCII bytes" during the read-only backup phase, and the catch path closes the MIDI session (`transferError` at `syntakt-transfer.ts:336`, dialog `invalidateConnection` at line 580) — export is permanently impossible and each attempt disconnects the user.

**Minimal-change fix:** stop asserting on names *read from* the device (assert only on names Sympakt itself writes), or widen the backup-name assertion to accept anything windows-1252 can round-trip. Both options live in the new `syntakt-transfer.ts` / `syntakt-backup.ts`.

### 3. MIDI port pairing can bind the Syntakt input to the wrong output
`src/midi/web-midi-transport.ts:82`

`pairedDevices` pairs each input with the first name-matching output, falling back to manufacturer equality that matches empty strings (`'' === ''`), so multi-port or differently-named-port setups pair the Syntakt input with the wrong output.

**Failure scenario:** On Windows the Syntakt enumerates as `MIDIIN2 (Elektron Syntakt)` / `MIDIOUT2 (Elektron Syntakt)` (name equality fails), or two same-named port pairs both bind to output #1. Identity SysEx is then sent to an unrelated device while listening on the Syntakt input; `ElektronSession` times out after 5 s with "Syntakt did not answer command 0x1" and terminates — direct transfer is unusable, and SysEx is sprayed at another instrument. The session identity check detects but never corrects the mispairing.

**Minimal-change fix:** in the new transport file only — require a non-empty manufacturer for the fallback, consume each output once so two same-named pairs can't both bind to output #1, and normalize the Windows `MIDIIN*`/`MIDIOUT*` decoration before comparing names.

### 4. Import .zip mid-transfer wipes the bank before the guard throws
`src/components/app-shell.ts:651`

Import .zip stays enabled during an active Syntakt transfer; `onZipSelected` replaces the whole bank via `bankState.loadBank()` **before** `syntaktTransferDialog.armRestore()` throws "Cannot load a Syntakt backup during a transfer", so the user sees a false failure after their bank was already wiped.

**Failure scenario:** While a Syntakt export/restore runs, the user clicks Import .zip (disabled only by `this.importing`, line 396) and picks a backup ZIP. `loadBank` replaces all 64 browser slots and bumps the revision, then `armRestore` throws because `isBusy()` is true; the catch (lines 663–665) shows "Failed to import sample pack" even though the bank was replaced, and "Restore backup exactly" is never armed for that ZIP.

**Minimal-change fix:** check `syntaktTransferDialog?.isBusy()` (or `this.syntaktExporting`) at the top of `onZipSelected` before touching the bank — a guard on branch-added lines; no pre-existing import logic changes.

### 5. Loop-branch slice lacks the 5 s cap and emptiness check the transfer path enforces
`src/services/zip-service.ts:154`

`prepareSampleExports`' loop branch slices the loop region with no `MAX_SAMPLE_DURATION` cap and no emptiness check, but the shared direct-transfer consumer `buildSyntaktDataSample` throws for >240000 frames or zero-length PCM — one bad slot aborts the entire bank export that ZIP export accepts.

**Failure scenario:** `importSamplePack` loads loop metadata unvalidated (`zip-service.ts:419`), so a pack declaring a >5 s loop region (or one whose start/end round to the same sample, yielding empty PCM) fills a bank slot that exports to ZIP without complaint. Clicking "Export to Syntakt" hits `buildSyntaktDataSample` at `syntakt-transfer.ts:105`, which throws "cannot exceed five seconds" / "must be non-empty" before any write, aborting all 64 slots and closing the healthy MIDI connection.

**Minimal-change fix:** validate the prepared PCM in the new `syntakt-transfer.ts` before any SysEx is sent (surface a per-slot error in the confirm dialog rather than aborting mid-transfer). **Leave `prepareSampleExports` untouched** — it is shared with the pre-existing ZIP export, whose behavior must not change.

### 6. Empty dual slots skew the mapping count and abort the export
`src/components/syntakt-transfer-dialog.ts:539`

`runTransfer` builds one mapping per non-null bank slot, but `prepareSampleExports` skips all-empty dual slots (`splitEnabled && aEmpty && !splitSample`), so the counts disagree and `validateMappings` aborts the export while force-closing the connection.

**Failure scenario:** A pack whose metadata declares a dual slot with A empty and a missing/undecodable B file imports with `splitEnabled`+`aEmpty` set and no `splitSample` (`zip-service.ts:428-450`), and `loadBank`/`replaceAll` never run `cleanupEmptyDual`. Export then produces N−1 prepared samples against N mappings; `validateMappings` (`syntakt-transfer.ts:369-371`) throws "Every occupied Sympakt slot needs one same-numbered Syntakt target" and `invalidateConnection` closes a healthy session — export is impossible and every attempt disconnects the device.

**Minimal-change fix:** derive the mappings from the prepared-samples list (which already encodes the real occupied set) instead of re-deriving them from bank slots in `runTransfer`. Confined to the new dialog file.

### 7. Deliberate cancel during in-flight writes is reported as a red export failure
`src/components/syntakt-transfer-dialog.ts:579`

Cancellation is classified by `message.startsWith('Transfer cancelled')`, but an abort landing during in-flight write blocks is wrapped into `SyntaktWriteStateUnknownError` ("The write may not have finished (...)"), so a deliberate user cancel is reported as a red export failure.

**Failure scenario:** The user clicks "Cancel export" while 0x58 write blocks are streaming. The `AbortError` rejects the pending request (`elektron-session.ts:102,118`), `uploadSlot`'s catch wraps it because `writeAttempted` is true (`syntakt-device.ts:307-314`), the string check yields `cancelled=false`, and app-shell (lines 809–813) shows "Syntakt export failed — The write may not have finished..." instead of the cancellation notice. Any rewording of the `transferError` message also silently breaks all cancel classification (the import path already uses the robust `AbortError` instanceof check).

**Minimal-change fix:** preserve the original error as `cause` when wrapping into `SyntaktWriteStateUnknownError`, and classify cancellation with the same `AbortError` instanceof check the import path already uses. New files only (`syntakt-device.ts`, dialog).

### 8. Export renders from the live bank array with no revision guard
`src/services/syntakt-transfer.ts:73`

`uploadSympaktBank` renders from the **live** bank array (bank-state `getSlots()` returns its internal array by reference; `setSample` mutates in place) across many awaits of `OfflineAudioContext.startRendering`, with no revision guard on the export path.

**Failure scenario:** Async work started before the confirm — e.g. a dropped file still decoding — lands via `setSample` while `prepareSampleExports` is mid-render. If the occupied set changes, `validateMappings` throws and force-closes the session; if a sample is replaced in place, audio the user never saw in the confirmation dialog is written to the hardware slot. The import and restore paths both carry revision guards (`app-shell.ts:734`, dialog `restoreRevision` at 595); export has none.

**Minimal-change fix:** snapshot the slots array (`[...bankState.getSlots()]`) and capture `bankState.revision` at confirm time in the new export path, re-checking the revision before writing — mirroring the guard the restore path already has. **Do not** change `bank-state.getSlots()` to return copies; every pre-existing consumer relies on its current semantics.

### 9. Golden write-block test embeds the output's own CRC, so the CRC is never verified
`src/elektron/syntakt-device.test.ts:403`

The golden write-block assertions embed the output's own CRC bytes (`contentWrite![13..16]`, and `footerWrite![13..16]` at line 409) in the expected arrays, so the per-block CRC actually sent to the device is never verified by any test.

**Failure scenario:** A regression in the block-CRC wiring in `uploadSlot` (wrong slice, wrong placement, standard 0xffffffff-seeded CRC swapped in) keeps the whole suite green — the FakeTransport's `writerBlockResponse` never validates CRC and the device response check only covers writerId/sequence/byte-total — while every real-hardware write block would be rejected or corrupt slot data, exactly the failure class these golden tests exist to catch.

**Minimal-change fix:** hardcode the captured CRC bytes (or compute them independently with `syntaktCrc32` over the known payload) in the expected arrays. Test-only change.

### 10. Toolbar shows "64/64" during the read-only backup phase, before any write
`src/components/app-shell.ts:370`

The toolbar renders `Exporting Syntakt ${completedFiles}/${totalFiles}` with no phase label, but `completedFiles` is per-phase: it counts to 64/64 during the read-only backup phase, then restarts at 0/64 when writing begins.

**Failure scenario:** During a 64-slot export the toolbar climbs to "Exporting Syntakt 64/64" while zero slots have been written (backup reads only, `progress()` at `syntakt-transfer.ts:356` vs write-phase `completedFiles: index` at 153–155), then drops back to "0/64". A user watching only the toolbar can believe the export finished at 64/64 and disconnect the device before any write has happened; the export dialog itself includes the phase label, the toolbar does not.

**Minimal-change fix:** include the phase in `formatSyntaktTransferCompletion` (new `syntakt-transfer-results.ts`) or in the branch-added toolbar template line. Branch-added lines only.

## Conciseness & simplicity findings (cut by the cap, verified)

All seven are confined to files added by this branch, so they carry no risk to pre-existing functionality — the one exception is noted in C6.

### C1. OS-version write guard is triplicated
`src/elektron/syntakt-device.ts:47`, `src/services/syntakt-transfer.ts:96`, `src/services/syntakt-transfer.ts:202`

All three sites perform the identical `!SYNTAKT_WRITE_SUPPORTED_OS_VERSIONS.has(identity.osVersion)` check with near-identical error messages. Extract one `assertWriteSupported(identity)` helper (natural home: `syntakt-device.ts`, next to the set at line 15) and call it everywhere. New files only.

### C2. `bytesEqual` is defined twice, identically
`src/elektron/syntakt-device.ts:64` and `src/services/syntakt-transfer.ts:421`

Byte-for-byte the same function. Export the one in `syntakt-device.ts` and delete the copy in `syntakt-transfer.ts`. New files only.

### C3. Two hand-rolled bitwise CRC-32 loops share the same core
`src/elektron/syntakt-data-sample.ts:128` (`syntaktCrc32`, seed 0, final XOR) and `src/services/syntakt-backup.ts:415` (`zipCrc32Update`, seed 0xffffffff)

The inner `0xedb88320` bit-loop is identical; only seeding/finalization differ (deliberately — the Elektron variant's captured initial state is documented at `syntakt-data-sample.ts:124`). Extract one `crc32Update(crc, data)` core and express both variants as one-line wrappers. While consolidating, switch to a precomputed 256-entry table: both CRCs run on the transfer hot path over roughly 30–90 MB of sample/backup data, and the bit-at-a-time loop does 8 iterations per byte where a table lookup does one. The existing `123456789 → 0xd202d277` test vector pins correctness through the change. New files only.

### C4. `unpack7Bit` builds a `number[]` and copies it on a multi-megabyte hot path
`src/elektron/sysex-codec.ts:21`

Every incoming SysEx payload is decoded by pushing bytes one at a time into a growing `number[]`, then copying into a `Uint8Array`. The output length is computable directly from `packed.length` (7 data bytes per full 8-byte group, partial group handled by the same bound already in the loop), so the function can allocate the `Uint8Array` once and write by index — simpler, no intermediate array, and materially faster on full-bank reads. New file only, covered by `sysex-codec.test.ts`.

### C5. Dead export: `backupAsWav`
`src/services/syntakt-backup.ts:255`

No non-test call sites. Delete it along with its tests (or give it a consumer if it's intended API). Note `SyntaktSlotBackup` already eagerly stores `wavData` for every slot (`backupFromPcm` at line 259); if WAV materialization is only needed on demand, dropping the eager `encodePcm16leWav` there is a follow-on memory win for 64-slot backups. New file only.

### C6. Modal CSS and overlay orchestration duplicated between the two new dialogs
`src/components/syntakt-export-dialog.ts` (263 lines) and `src/components/syntakt-transfer-dialog.ts` (730 lines)

Both implement the same `:host { display:none }` / `:host([open])` toggle, `.overlay` backdrop styles, and `onOverlayClick` dismissal plumbing (export dialog lines 11–13, 153; transfer dialog lines 35, 220). Share a base class or exported style sheet **between these two new files only**. Under the minimal-change goal, do *not* migrate the pre-existing dialogs (`help-dialog.ts`, `settings-dialog.ts`, `export-dialog.ts`) to the shared base — that would be exactly the kind of working-code churn to avoid; they can adopt it later if it ever pays for itself.

### C7. Device selection resets to the "preferred" device on every refresh
`src/components/syntakt-transfer-dialog.ts:387`

`findDevices()` assigns `preferred?.id ?? (current-if-still-present) ?? first`, so whenever a preferred (name-matched) device exists, a refresh silently discards the user's explicit selection of a different port. Reorder the fallback so an existing valid selection wins, and only fall back to preferred/first when the current selection disappeared. (A small behavioral fix rather than pure conciseness, but verified and cut only by the cap.) New file only.

## Verified non-issues

Four candidates were investigated and confirmed intentional: the wav-decoder input narrowing, the ZIP backup dispatch change, and the delayed `revokeObjectURL` are deliberate strictness/bug fixes, not regressions.
