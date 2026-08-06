import { WebMidiTransport } from '../midi/web-midi-transport.js';
import { ElektronSession } from '../elektron/elektron-session.js';
import { SyntaktDevice, SyntaktWriteStateUnknownError } from '../elektron/syntakt-device.js';
import { buildSyntaktDataSample } from '../elektron/syntakt-data-sample.js';
import type { SyntaktSampleSlot } from '../elektron/syntakt-slot-list.js';
import { prepareSampleExports } from './zip-service.js';
import type { PreparedSampleExport } from './zip-service.js';
import { encodePcm16leWav } from './wav-encoder.js';
import { assertRestorableSyntaktName, sha256Hex } from './syntakt-backup.js';
import type { SyntaktTransferPhase } from './syntakt-backup.js';
import type { Sample } from '../types/index.js';
import type { WebMidiDevice } from '../midi/web-midi-transport.js';

export interface SyntaktConnection { device: SyntaktDevice; session: ElektronSession; identity: { name: string; osVersion: string }; }
export interface ExplicitSlotMapping { sourceSlot: number; targetSlot: number; expectedTarget: SyntaktSampleSlot; }
export interface BankTransferProgress { phase: 'backup' | 'write' | 'verify'; fileIndex: number; fileCount: number; filename: string; fileSentBytes: number; fileTotalBytes: number; totalSentBytes: number; totalBytes: number; }
export interface SyntaktSlotBackup { slot: number; name: string; pcm16le: Uint8Array; wavData: Uint8Array; }
export type BankTransferState = 'pending' | 'backed_up' | 'write_started' | 'written' | 'verified' | 'unknown';
export interface BankTransferResult { sourceSlot: number; targetSlot: number; filename: string; state: BankTransferState; }
export interface SyntaktTransactionIntent { sourceSlot: number; targetSlot: number; intendedName: string; intendedPcm16le: Uint8Array; }
export interface SyntaktRecoveryEntry { sourceSlot: number; targetSlot: number; phase: SyntaktTransferPhase; backup: SyntaktSlotBackup; intendedName: string; intendedPcmSha256: string; }

/** Required durable journal: no writer command can run without it. */
export interface SyntaktTransferJournal {
  initialize(intents: readonly SyntaktTransactionIntent[]): Promise<void>;
  recordBackup(intent: SyntaktTransactionIntent, backup: SyntaktSlotBackup): Promise<void>;
  transition(targetSlot: number, phase: Exclude<SyntaktTransferPhase, 'planned' | 'backed-up'>): Promise<void>;
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
  journal: SyntaktTransferJournal;
  onProgress: (progress: BankTransferProgress) => void;
};

/** Export-independent guarded transfer orchestrator used by replay tests. */
export async function uploadPreparedSamples(connection: SyntaktConnection, prepared: readonly PreparedSampleExport[], options: Omit<TransferOptions, 'normalizeOnExport'>): Promise<readonly BankTransferResult[]> {
  if (!isSyntaktTransferWriteEnabled()) throw new Error('Direct Syntakt writing requires a secure Web MIDI context');
  const mappings = validateMappings(prepared.map(({ slot }) => slot), options.mappings);
  const intents = prepared.map((item) => {
    const mapping = mappings.get(item.slot)!;
    const intendedName = syntaktSlotName(item.filename);
    // Validate all intended files before any device writer command.
    buildSyntaktDataSample(mapping.targetSlot, intendedName, item.pcm16le);
    return { sourceSlot: item.slot, targetSlot: mapping.targetSlot, intendedName, intendedPcm16le: new Uint8Array(item.pcm16le) };
  });
  const totalBytes = prepared.reduce((total, item) => total + item.pcm16le.length + 107, 0);
  const results = intents.map((intent, index) => ({ sourceSlot: intent.sourceSlot, targetSlot: intent.targetSlot, filename: prepared[index].filename, state: 'pending' as BankTransferState }));
  const backups = new Map<number, SyntaktSlotBackup>();
  let totalSentBytes = 0;
  try {
    await options.journal.initialize(intents);
    for (let index = 0; index < intents.length; index += 1) {
      throwIfAborted(options.signal);
      const intent = intents[index];
      const read = await connection.device.downloadSlot(intent.targetSlot, options.signal);
      if (read.empty) throw new Error(`Syntakt slot ${intent.targetSlot} is empty and cannot be safely restored after export`);
      assertRestorableSyntaktName(read.name);
      // The actual writer builder is the single source of restore limits.
      buildSyntaktDataSample(intent.targetSlot, read.name, read.pcm16le);
      const backup: SyntaktSlotBackup = { slot: intent.targetSlot, name: read.name, pcm16le: new Uint8Array(read.pcm16le), wavData: encodePcm16leWav(read.pcm16le) };
      await options.journal.recordBackup(intent, backup);
      backups.set(intent.targetSlot, backup);
      results[index].state = 'backed_up';
      options.onProgress(progress('backup', index, prepared.length, prepared[index], 0, totalSentBytes, totalBytes));
    }
    for (let index = 0; index < intents.length; index += 1) {
      throwIfAborted(options.signal);
      const intent = intents[index];
      const backup = backups.get(intent.targetSlot);
      if (!backup) throw new Error(`Syntakt target ${intent.targetSlot} has no durable backup`);
      // This is durable before the exclusive operation can open 0x57.
      await options.journal.transition(intent.targetSlot, 'write-started');
      results[index].state = 'write_started';
      await connection.device.uploadSlot(intent.targetSlot, intent.intendedName, intent.intendedPcm16le, mappings.get(intent.sourceSlot)!.expectedTarget, { name: backup.name, pcm16le: backup.pcm16le }, ({ sentBytes, totalBytes: fileTotalBytes }) => {
        options.onProgress({ phase: 'write', fileIndex: index, fileCount: prepared.length, filename: prepared[index].filename, fileSentBytes: sentBytes, fileTotalBytes, totalSentBytes: totalSentBytes + sentBytes, totalBytes });
      }, options.signal);
      await options.journal.transition(intent.targetSlot, 'written');
      results[index].state = 'written';
      const writerBytes = intent.intendedPcm16le.length + 107;
      totalSentBytes += writerBytes;
      if (options.verifyReadback !== false) {
        const readback = await connection.device.downloadSlot(intent.targetSlot, options.signal);
        if (readback.empty || readback.name !== intent.intendedName || !bytesEqual(readback.pcm16le, intent.intendedPcm16le)) throw new Error(`Readback verification failed for Syntakt slot ${intent.targetSlot}`);
        await options.journal.transition(intent.targetSlot, 'verified');
        results[index].state = 'verified';
        options.onProgress(progress('verify', index, prepared.length, prepared[index], writerBytes, totalSentBytes, totalBytes));
      }
    }
    return results;
  } catch (error) {
    const active = results.find((result) => result.state === 'write_started');
    if (active && error instanceof SyntaktWriteStateUnknownError) active.state = 'unknown';
    await connection.session.close().catch(() => undefined);
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? 'Transfer cancelled. The MIDI session was closed; inspect the target slot before reconnecting.'
      : asError(error).message;
    throw new SyntaktBatchTransferError(message, results);
  }
}

/** Guarded recovery from the one transfer manifest. */
export async function restoreSyntaktTransactionBackups(connection: SyntaktConnection, entries: readonly SyntaktRecoveryEntry[], options: { signal?: AbortSignal; onProgress: (progress: BankTransferProgress) => void }): Promise<readonly BankTransferResult[]> {
  if (!isSyntaktTransferWriteEnabled()) throw new Error('Direct Syntakt writing requires a secure Web MIDI context');
  if (!entries.length) throw new Error('No durable Syntakt transfer backups are available for recovery');
  const totalBytes = entries.reduce((sum, entry) => sum + entry.backup.pcm16le.length + 107, 0);
  const results = entries.map((entry) => ({ sourceSlot: entry.sourceSlot, targetSlot: entry.targetSlot, filename: entry.backup.name, state: 'pending' as BankTransferState }));
  const candidates: Array<{ index: number; entry: SyntaktRecoveryEntry; expected: SyntaktSampleSlot }> = [];
  try {
    const inventory = await connection.device.listSampleSlots(options.signal);
    const sources = new Set<number>();
    const targets = new Set<number>();
    // Whole-run read-only preflight: a later invalid entry means zero writers.
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      validateRecoveryEntry(entry);
      if (sources.has(entry.sourceSlot) || targets.has(entry.targetSlot)) throw new Error('Duplicate Syntakt recovery source or target slot');
      sources.add(entry.sourceSlot); targets.add(entry.targetSlot);
      const current = await connection.device.downloadSlot(entry.targetSlot, options.signal);
      if (!current.empty && current.name === entry.backup.name && bytesEqual(current.pcm16le, entry.backup.pcm16le)) { results[index].state = 'verified'; continue; }
      if (!mayHaveWritten(entry.phase)) throw new Error(`Syntakt slot ${entry.targetSlot} was never written by this transfer and no longer matches its original`);
      if (current.empty || current.name !== entry.intendedName || await sha256Hex(current.pcm16le) !== entry.intendedPcmSha256) throw new Error(`Syntakt slot ${entry.targetSlot} no longer matches its recorded original or intended upload`);
      const expected = inventory.find((slot) => slot.slot === entry.targetSlot);
      if (!expected) throw new Error(`Syntakt slot ${entry.targetSlot} is no longer present`);
      candidates.push({ index, entry, expected });
    }
    let totalSentBytes = 0;
    for (const { index, entry, expected } of candidates) {
      throwIfAborted(options.signal);
      results[index].state = 'write_started';
      await connection.device.uploadSlot(entry.targetSlot, entry.backup.name, entry.backup.pcm16le, expected, { name: entry.intendedName, pcmSha256: entry.intendedPcmSha256 }, ({ sentBytes, totalBytes: fileTotalBytes }) => {
        options.onProgress({ phase: 'write', fileIndex: index, fileCount: entries.length, filename: entry.backup.name, fileSentBytes: sentBytes, fileTotalBytes, totalSentBytes: totalSentBytes + sentBytes, totalBytes });
      }, options.signal);
      const readback = await connection.device.downloadSlot(entry.targetSlot, options.signal);
      if (readback.empty || readback.name !== entry.backup.name || !bytesEqual(readback.pcm16le, entry.backup.pcm16le)) throw new Error(`Syntakt recovery verification failed for slot ${entry.targetSlot}`);
      totalSentBytes += entry.backup.pcm16le.length + 107;
      results[index].state = 'verified';
      options.onProgress({ phase: 'verify', fileIndex: index, fileCount: entries.length, filename: entry.backup.name, fileSentBytes: entry.backup.pcm16le.length + 107, fileTotalBytes: entry.backup.pcm16le.length + 107, totalSentBytes, totalBytes });
    }
    return results;
  } catch (error) {
    const active = results.find((result) => result.state === 'write_started');
    if (active && error instanceof SyntaktWriteStateUnknownError) active.state = 'unknown';
    await connection.session.close().catch(() => undefined);
    throw new SyntaktBatchTransferError(asError(error).message, results);
  }
}

function progress(phase: 'backup' | 'verify', fileIndex: number, fileCount: number, item: PreparedSampleExport, sentBytes: number, totalSentBytes: number, totalBytes: number): BankTransferProgress {
  return { phase, fileIndex, fileCount, filename: item.filename, fileSentBytes: sentBytes, fileTotalBytes: item.pcm16le.length + 107, totalSentBytes, totalBytes };
}
function validateMappings(sourceSlots: readonly number[], mappings: readonly ExplicitSlotMapping[]): Map<number, ExplicitSlotMapping> {
  if (mappings.length !== sourceSlots.length) throw new Error('Every occupied Sympakt slot needs one explicit Syntakt target');
  const expectedSources = new Set(sourceSlots); const bySource = new Map<number, ExplicitSlotMapping>(); const targets = new Set<number>();
  for (const mapping of mappings) {
    if (!expectedSources.has(mapping.sourceSlot) || bySource.has(mapping.sourceSlot) || targets.has(mapping.targetSlot)) throw new Error('Invalid or duplicate Sympakt source-slot mapping');
    if (!Number.isInteger(mapping.targetSlot) || mapping.targetSlot < 1 || mapping.targetSlot > 64 || mapping.expectedTarget.slot !== mapping.targetSlot) throw new Error('Invalid Syntakt target mapping');
    bySource.set(mapping.sourceSlot, mapping); targets.add(mapping.targetSlot);
  }
  return bySource;
}
function validateRecoveryEntry(entry: SyntaktRecoveryEntry): void {
  if (entry.targetSlot !== entry.backup.slot || !Number.isInteger(entry.sourceSlot) || entry.sourceSlot < 1 || entry.sourceSlot > 64 || !/^[a-f0-9]{64}$/.test(entry.intendedPcmSha256)) throw new Error('Invalid Syntakt recovery entry');
  assertRestorableSyntaktName(entry.backup.name); assertRestorableSyntaktName(entry.intendedName); buildSyntaktDataSample(entry.targetSlot, entry.backup.name, entry.backup.pcm16le);
}
function mayHaveWritten(phase: SyntaktTransferPhase): boolean { return phase === 'write-started' || phase === 'written' || phase === 'verified'; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Transfer cancelled', 'AbortError'); }
function syntaktSlotName(filename: string): string { const base = filename.replace(/\.wav$/i, '').replace(/[^A-Za-z0-9 _-]/g, '_').replace(/^\d+_/, '').trim(); return (base || 'Sympakt').slice(0, 16); }
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error('Syntakt transfer failed'); }
