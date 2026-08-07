import { WebMidiTransport } from '../midi/web-midi-transport.js';
import { ElektronSession } from '../elektron/elektron-session.js';
import { SYNTAKT_WRITE_SUPPORTED_OS_VERSIONS, SyntaktDevice, SyntaktWriteStateUnknownError } from '../elektron/syntakt-device.js';
import { buildSyntaktDataSample, SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES } from '../elektron/syntakt-data-sample.js';
import type { SyntaktSampleSlot } from '../elektron/syntakt-slot-list.js';
import { prepareSampleExports } from './zip-service.js';
import type { PreparedSampleExport } from './zip-service.js';
import { backupFromPcm, createVerifiedSyntaktBackup, assertRestorableSyntaktName, sha256Hex } from './syntakt-backup.js';
import type { ParsedSyntaktBackup, SyntaktBackupContent, SyntaktBackupIntent } from './syntakt-backup.js';
import type { Sample } from '../types/index.js';
import type { WebMidiDevice } from '../midi/web-midi-transport.js';

export interface SyntaktConnection { device: SyntaktDevice; session: ElektronSession; identity: { name: string; osVersion: string }; }
export interface ExplicitSlotMapping { sourceSlot: number; targetSlot: number; expectedTarget: SyntaktSampleSlot; }
export interface BankTransferProgress { phase: 'backup' | 'clear' | 'write' | 'verify'; fileIndex: number; fileCount: number; completedFiles: number; totalFiles: number; filename: string; fileSentBytes: number; fileTotalBytes: number; totalSentBytes: number; totalBytes: number; }
export type BankTransferState = 'pending' | 'backed_up' | 'cleared' | 'write_started' | 'written' | 'verified' | 'unknown';
export interface BankTransferResult { sourceSlot: number; targetSlot: number; filename: string; state: BankTransferState; }
export interface SyntaktRestoreEntry { targetSlot: number; original: SyntaktBackupContent; intendedName: string; intendedPcmSha256: string; }

/** Canonical completed-transfer label used by both export surfaces. */
export function formatSyntaktTransferCompletion(progress: Pick<BankTransferProgress, 'completedFiles' | 'totalFiles'>): string {
  return `${progress.completedFiles}/${progress.totalFiles}`;
}

export class SyntaktBatchTransferError extends Error {
  constructor(message: string, readonly results: readonly BankTransferResult[]) { super(message); this.name = 'SyntaktBatchTransferError'; }
}

export function isSyntaktTransferSupported(): boolean { return typeof window !== 'undefined' && WebMidiTransport.supported(); }
export function isSyntaktTransferWriteEnabled(): boolean { return isSyntaktTransferSupported() && window.isSecureContext; }
export async function discoverSyntaktDevices(): Promise<WebMidiDevice[]> { return WebMidiTransport.discover(); }
export async function connectSyntakt(deviceId?: string): Promise<SyntaktConnection> {
  const { transport } = await WebMidiTransport.request(deviceId);
  const session = new ElektronSession(transport);
  try { const device = new SyntaktDevice(session); return { device, session, identity: await device.identify() }; }
  catch (error) { await session.close(); throw error; }
}
export async function inspectSyntaktSlots(connection: SyntaktConnection, signal?: AbortSignal): Promise<SyntaktSampleSlot[]> { return connection.device.listSampleSlots(signal); }

export async function uploadSympaktBank(connection: SyntaktConnection, slots: ReadonlyArray<Sample | null>, options: TransferOptions): Promise<readonly BankTransferResult[]> {
  return uploadPreparedSamples(connection, await prepareSampleExports(slots, options.normalizeOnExport), options);
}

type TransferOptions = {
  mappings: readonly ExplicitSlotMapping[];
  normalizeOnExport: boolean;
  verifyReadback?: boolean;
  signal?: AbortSignal;
  /** Must start the browser download synchronously; return only after it is triggered. */
  onBackupReady: (archive: Uint8Array) => Promise<void> | void;
  onProgress: (progress: BankTransferProgress) => void | Promise<void>;
};

/**
 * One guarded export: render → read all targets → build/reopen/hash-verify ZIP
 * → trigger its download → write sequentially. No writer can run earlier.
 */
export async function uploadPreparedSamples(connection: SyntaktConnection, prepared: readonly PreparedSampleExport[], options: Omit<TransferOptions, 'normalizeOnExport'>): Promise<readonly BankTransferResult[]> {
  if (!isSyntaktTransferWriteEnabled()) throw new Error('Direct Syntakt writing requires a secure Web MIDI context');
  if (!SYNTAKT_WRITE_SUPPORTED_OS_VERSIONS.has(connection.identity.osVersion)) throw new Error(`Syntakt OS ${connection.identity.osVersion} is read-only until direct-write conformance is complete`);
  const mappings = validateMappings(prepared.map(({ slot }) => slot), options.mappings);
  const intents = prepared.map((item) => {
    const mapping = mappings.get(item.slot)!;
    const intendedName = syntaktSlotName(item.filename);
    buildSyntaktDataSample(mapping.targetSlot, intendedName, item.pcm16le);
    return { sourceSlot: item.slot, targetSlot: mapping.targetSlot, intendedName, intendedPcm16le: new Uint8Array(item.pcm16le), expectedTarget: mapping.expectedTarget };
  });
  const totalBytes = prepared.reduce((total, item) => total + item.pcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES, 0);
  const results = intents.map((intent, index) => ({ sourceSlot: intent.sourceSlot, targetSlot: intent.targetSlot, filename: prepared[index].filename, state: 'pending' as BankTransferState }));
  const originals: SyntaktBackupContent[] = [];
  let totalSentBytes = 0;
  try {
    for (let index = 0; index < intents.length; index += 1) {
      throwIfAborted(options.signal);
      const intent = intents[index];
      const read = await connection.device.downloadSlot(intent.targetSlot, options.signal);
      if (read.empty) originals.push({ slot: intent.targetSlot, empty: true });
      else {
        assertBackupTargetName(intent.targetSlot, read.name);
        buildSyntaktDataSample(intent.targetSlot, read.name, read.pcm16le);
        originals.push(backupFromPcm(intent.targetSlot, read.name, read.pcm16le));
      }
      results[index].state = 'backed_up';
      await options.onProgress(progress('backup', index, prepared.length, prepared[index], 0, totalSentBytes, totalBytes));
    }
    const backupIntents: SyntaktBackupIntent[] = intents.map((intent) => ({ targetSlot: intent.targetSlot, intendedName: intent.intendedName, intendedPcm16le: intent.intendedPcm16le }));
    const verifiedBackup = await createVerifiedSyntaktBackup(backupIntents, originals);
    throwIfAborted(options.signal);
    await options.onBackupReady(verifiedBackup.archive);
    for (let index = 0; index < intents.length; index += 1) {
      throwIfAborted(options.signal);
      const intent = intents[index];
      const original = originals[index];
      results[index].state = 'write_started';
      await options.onProgress({
        phase: 'write', fileIndex: index, fileCount: prepared.length, filename: prepared[index].filename,
        completedFiles: index, totalFiles: prepared.length,
        fileSentBytes: 0, fileTotalBytes: intent.intendedPcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES, totalSentBytes, totalBytes,
      });
      await connection.device.uploadSlot(intent.targetSlot, intent.intendedName, intent.intendedPcm16le, intent.expectedTarget, 'empty' in original ? { empty: true } : { name: original.name, pcm16le: original.pcm16le }, () => undefined, options.signal);
      results[index].state = 'written';
      const writerBytes = intent.intendedPcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES;
      totalSentBytes += writerBytes;
      await options.onProgress(progress('write', index, prepared.length, prepared[index], writerBytes, totalSentBytes, totalBytes));
      if (options.verifyReadback !== false) {
        const readback = await connection.device.downloadSlot(intent.targetSlot, options.signal);
        if (readback.empty || readback.name !== intent.intendedName || !bytesEqual(readback.pcm16le, intent.intendedPcm16le)) throw new Error(`Slot ${intent.targetSlot} didn't read back as expected. Check it on the Syntakt.`);
        results[index].state = 'verified';
        await options.onProgress(progress('verify', index, prepared.length, prepared[index], writerBytes, totalSentBytes, totalBytes));
      }
    }
    return results;
  } catch (error) { throw transferError(connection, error, results); }
}

/** Restore a validated archive. The full run is read-only-preflighted before any change. */
export async function restoreSyntaktBackup(connection: SyntaktConnection, backup: ParsedSyntaktBackup, options: { signal?: AbortSignal; onProgress: (progress: BankTransferProgress) => void }): Promise<readonly BankTransferResult[]> {
  if (!isSyntaktTransferWriteEnabled()) throw new Error('Direct Syntakt writing requires a secure Web MIDI context');
  if (!SYNTAKT_WRITE_SUPPORTED_OS_VERSIONS.has(connection.identity.osVersion)) throw new Error(`Syntakt OS ${connection.identity.osVersion} is read-only until direct-write conformance is complete`);
  const entries: SyntaktRestoreEntry[] = backup.manifest.entries.map((entry) => ({ targetSlot: entry.targetSlot, original: backup.originals.get(entry.targetSlot)!, intendedName: entry.intended.name, intendedPcmSha256: entry.intended.pcmSha256 }));
  if (!entries.length || entries.some((entry) => !entry.original)) throw new Error('Invalid Syntakt backup restore data');
  // Validate every write container before the read-only device preflight can advance to a writer.
  for (const entry of entries) {
    if (!('empty' in entry.original)) buildSyntaktDataSample(entry.targetSlot, entry.original.name, entry.original.pcm16le);
  }
  const totalBytes = entries.reduce((sum, entry) => sum + ('empty' in entry.original ? 0 : entry.original.pcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES), 0);
  const results = entries.map((entry) => ({ sourceSlot: entry.targetSlot, targetSlot: entry.targetSlot, filename: 'empty' in entry.original ? 'empty' : entry.original.name, state: 'pending' as BankTransferState }));
  const candidates: Array<{ index: number; entry: SyntaktRestoreEntry; expected: SyntaktSampleSlot }> = [];
  try {
    const inventory = await connection.device.listSampleSlots(options.signal);
    for (let index = 0; index < entries.length; index += 1) {
      throwIfAborted(options.signal);
      const entry = entries[index];
      const expected = inventory.find((slot) => slot.slot === entry.targetSlot);
      if (!expected) throw new Error(`Syntakt slot ${entry.targetSlot} is no longer present`);
      const current = await connection.device.downloadSlot(entry.targetSlot, options.signal);
      if (sameOriginal(current, entry.original)) { results[index].state = 'verified'; continue; }
      if (current.empty || current.name !== entry.intendedName || await sha256Hex(current.pcm16le) !== entry.intendedPcmSha256) throw new Error(`Syntakt slot ${entry.targetSlot} no longer matches its recorded original or intended upload`);
      candidates.push({ index, entry, expected });
    }
    let totalSentBytes = 0;
    for (const { index, entry, expected } of candidates) {
      throwIfAborted(options.signal);
      if ('empty' in entry.original) {
        try {
          await connection.device.clearSlot(entry.targetSlot, expected, { name: entry.intendedName, pcmSha256: entry.intendedPcmSha256 }, options.signal);
        } catch (error) {
          if (error instanceof SyntaktWriteStateUnknownError) results[index].state = 'unknown';
          throw error;
        }
        results[index].state = 'verified';
        options.onProgress({ phase: 'clear', fileIndex: index, fileCount: entries.length, completedFiles: index + 1, totalFiles: entries.length, filename: 'empty', fileSentBytes: 0, fileTotalBytes: 0, totalSentBytes, totalBytes });
        continue;
      }
      const original = entry.original;
      results[index].state = 'write_started';
      await connection.device.uploadSlot(entry.targetSlot, original.name, original.pcm16le, expected, { name: entry.intendedName, pcmSha256: entry.intendedPcmSha256 }, ({ sentBytes, totalBytes: fileTotalBytes }) => {
        options.onProgress({ phase: 'write', fileIndex: index, fileCount: entries.length, completedFiles: sentBytes < fileTotalBytes ? index : index + 1, totalFiles: entries.length, filename: original.name, fileSentBytes: sentBytes, fileTotalBytes, totalSentBytes: totalSentBytes + sentBytes, totalBytes });
      }, options.signal);
      const readback = await connection.device.downloadSlot(entry.targetSlot, options.signal);
      if (!sameOriginal(readback, original)) throw new Error(`Syntakt recovery verification failed for slot ${entry.targetSlot}`);
      totalSentBytes += original.pcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES;
      results[index].state = 'verified';
      options.onProgress({ phase: 'verify', fileIndex: index, fileCount: entries.length, completedFiles: index + 1, totalFiles: entries.length, filename: original.name, fileSentBytes: original.pcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES, fileTotalBytes: original.pcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES, totalSentBytes, totalBytes });
    }
    return results;
  } catch (error) { throw transferError(connection, error, results); }
}

function transferError(connection: SyntaktConnection, error: unknown, results: readonly BankTransferResult[]): SyntaktBatchTransferError {
  const active = results.find((result) => result.state === 'write_started');
  if (active && error instanceof SyntaktWriteStateUnknownError) active.state = 'unknown';
  void connection.session.close().catch(() => undefined);
  const message = error instanceof DOMException && error.name === 'AbortError' ? 'Transfer cancelled. Reconnect the Syntakt to continue.' : asError(error).message;
  return new SyntaktBatchTransferError(message, results);
}
function progress(phase: 'backup' | 'clear' | 'write' | 'verify', fileIndex: number, fileCount: number, item: PreparedSampleExport, sentBytes: number, totalSentBytes: number, totalBytes: number): BankTransferProgress {
  const fileTotalBytes = item.pcm16le.length + SYNTAKT_DATA_SAMPLE_CONTAINER_OVERHEAD_BYTES;
  return { phase, fileIndex, fileCount, completedFiles: phase === 'write' && sentBytes < fileTotalBytes ? fileIndex : fileIndex + 1, totalFiles: fileCount, filename: item.filename, fileSentBytes: sentBytes, fileTotalBytes, totalSentBytes, totalBytes };
}
function validateMappings(sourceSlots: readonly number[], mappings: readonly ExplicitSlotMapping[]): Map<number, ExplicitSlotMapping> {
  if (mappings.length !== sourceSlots.length) throw new Error('Every occupied Sympakt slot needs one same-numbered Syntakt target');
  const expectedSources = new Set(sourceSlots); const bySource = new Map<number, ExplicitSlotMapping>(); const targets = new Set<number>();
  for (const mapping of mappings) {
    if (!expectedSources.has(mapping.sourceSlot) || mapping.sourceSlot !== mapping.targetSlot || bySource.has(mapping.sourceSlot) || targets.has(mapping.targetSlot)) throw new Error('Invalid Syntakt same-slot mapping');
    if (!Number.isInteger(mapping.targetSlot) || mapping.targetSlot < 1 || mapping.targetSlot > 64 || mapping.expectedTarget.slot !== mapping.targetSlot) throw new Error('Invalid Syntakt target mapping');
    bySource.set(mapping.sourceSlot, mapping); targets.add(mapping.targetSlot);
  }
  return bySource;
}
function assertBackupTargetName(slot: number, name: string): void {
  try { assertRestorableSyntaktName(name); }
  catch { throw new Error(`Syntakt slot ${slot} cannot be backed up: sample names must be 1–16 ASCII bytes`); }
}
function sameOriginal(current: Awaited<ReturnType<SyntaktDevice['downloadSlot']>>, original: SyntaktBackupContent): boolean { return 'empty' in original ? current.empty === true : !current.empty && current.name === original.name && bytesEqual(current.pcm16le, original.pcm16le); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Transfer cancelled', 'AbortError'); }
function syntaktSlotName(filename: string): string { const base = filename.replace(/\.wav$/i, '').replace(/[^A-Za-z0-9 _-]/g, '_').replace(/^\d+_/, '').trim(); return (base || 'Sympakt').slice(0, 16); }
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error('Syntakt transfer failed'); }
