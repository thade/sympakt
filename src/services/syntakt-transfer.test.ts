import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSyntaktTransferCompletion, restoreSyntaktBackup, uploadPreparedSamples } from './syntakt-transfer.js';
import { backupFromPcm, createVerifiedSyntaktBackup } from './syntakt-backup.js';
import type { PreparedSampleExport } from './zip-service.js';
import type { SyntaktSampleSlot } from '../elektron/syntakt-slot-list.js';

const record = (slot: number): SyntaktSampleSlot => ({ slot, name: `TARGET ${slot}`, storedBytes: 100, operations: 0x7e, hasData: true, hasMetadata: false });
const sample = (slot: number, name: string, pcm16le: Uint8Array) => ({ slot, name, frames: pcm16le.length / 2, pcm16le, footerHash: 0 } as const);
const prepared = (slot: number, filename: string, pcm16le: Uint8Array): PreparedSampleExport => ({ slot, filename, pcm16le, wavData: new Uint8Array(44 + pcm16le.length) });

function enabled(): void { vi.stubGlobal('window', { isSecureContext: true }); vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve(undefined) }); }
function connection(events: string[], values = new Map<number, any>([[1, sample(1, 'TARGET 1', Uint8Array.of(1, 0))]])) {
  const device = {
    downloadSlot: async (slot: number) => { events.push(`read-${slot}`); return values.get(slot)!; },
    listSampleSlots: async () => [...values.keys()].map(record),
    clearSlot: async (slot: number) => { events.push(`clear-${slot}`); values.set(slot, { slot, empty: true, footerHash: 0 }); },
    uploadSlot: async (slot: number, name: string, pcm16le: Uint8Array, _record: unknown, _proof: unknown, progress: (value: { sentBytes: number; totalBytes: number }) => void) => { events.push(`write-${slot}`); values.set(slot, sample(slot, name, pcm16le)); progress({ sentBytes: pcm16le.length + 107, totalBytes: pcm16le.length + 107 }); },
  };
  return { device, session: { close: vi.fn(async () => undefined) }, identity: { name: 'Syntakt', osVersion: '1.40' } } as any;
}

afterEach(() => vi.unstubAllGlobals());

describe('guarded Syntakt transfer', () => {
  it('formats only canonical completed-transfer counts for every export surface', () => {
    expect(formatSyntaktTransferCompletion({ completedFiles: 0, totalFiles: 64 })).toBe('0/64');
    expect(formatSyntaktTransferCompletion({ completedFiles: 1, totalFiles: 64 })).toBe('1/64');
  });

  it('downloads the verified ZIP before opening a writer', async () => {
    enabled(); const events: string[] = []; const link = connection(events);
    await uploadPreparedSamples(link, [prepared(1, '01_NEW.wav', Uint8Array.of(2, 0))], { mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: record(1) }], onBackupReady: async () => { events.push('download-zip'); }, onProgress: () => undefined });
    expect(events).toEqual(['read-1', 'download-zip', 'write-1', 'read-1']);
  });

  it('reports completed backup slots and a zero-percent write state before the writer opens', async () => {
    enabled(); const events: string[] = []; const progress: Array<{ phase: string; fileSentBytes: number }> = [];
    await uploadPreparedSamples(connection(events), [prepared(1, '01_NEW.wav', Uint8Array.of(2, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: record(1) }],
      onBackupReady: () => undefined,
      onProgress: (update) => { progress.push({ phase: update.phase, fileSentBytes: update.fileSentBytes }); },
    });
    expect(progress).toEqual([
      { phase: 'backup', fileSentBytes: 0 },
      { phase: 'write', fileSentBytes: 0 },
      { phase: 'write', fileSentBytes: 109 },
      { phase: 'verify', fileSentBytes: 109 },
    ]);
  });

  it('reports canonical completion counts for every export phase', async () => {
    enabled(); const events: string[] = []; const updates: Array<{ phase: string; fileIndex: number; completedFiles: number; totalFiles: number }> = [];
    const bank = Array.from({ length: 64 }, (_, index) => prepared(index + 1, `${String(index + 1).padStart(2, '0')}_NEW.wav`, Uint8Array.of(index, 0)));
    const values = new Map(bank.map((item) => [item.slot, sample(item.slot, `TARGET ${item.slot}`, Uint8Array.of(item.slot, 0))]));
    await uploadPreparedSamples(connection(events, values), bank, {
      mappings: bank.map((item) => ({ sourceSlot: item.slot, targetSlot: item.slot, expectedTarget: record(item.slot) })),
      onBackupReady: () => undefined,
      onProgress: ({ phase, fileIndex, completedFiles, totalFiles }) => { updates.push({ phase, fileIndex, completedFiles, totalFiles }); },
    });
    expect(updates.find((update) => update.phase === 'backup' && update.fileIndex === 0)).toMatchObject({ completedFiles: 1, totalFiles: 64 });
    expect(updates.find((update) => update.phase === 'write' && update.fileIndex === 0 && update.completedFiles === 0)).toMatchObject({ totalFiles: 64 });
    expect(updates.find((update) => update.phase === 'write' && update.fileIndex === 0 && update.completedFiles === 1)).toMatchObject({ totalFiles: 64 });
    expect(updates.find((update) => update.phase === 'verify' && update.fileIndex === 0)).toMatchObject({ completedFiles: 1, totalFiles: 64 });
    expect(updates.at(-1)).toMatchObject({ phase: 'verify', completedFiles: 64, totalFiles: 64 });
  });

  it('does not start the next writer until verification progress has been observed', async () => {
    enabled(); const events: string[] = []; const values = new Map([[1, sample(1, 'TARGET 1', Uint8Array.of(1, 0))], [2, sample(2, 'TARGET 2', Uint8Array.of(2, 0))]]);
    let signalVerify!: () => void;
    let releaseVerify!: () => void;
    const verifyReached = new Promise<void>((resolve) => { signalVerify = resolve; });
    const transfer = uploadPreparedSamples(connection(events, values), [prepared(1, '01_NEW.wav', Uint8Array.of(3, 0)), prepared(2, '02_NEW.wav', Uint8Array.of(4, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: record(1) }, { sourceSlot: 2, targetSlot: 2, expectedTarget: record(2) }],
      onBackupReady: () => undefined,
      onProgress: (update) => {
        if (update.phase !== 'verify' || update.fileIndex !== 0) return;
        signalVerify();
        return new Promise<void>((resolve) => { releaseVerify = resolve; });
      },
    });
    await verifyReached;
    expect(events).not.toContain('write-2');
    releaseVerify();
    await transfer;
  });

  it('writes a verified empty backup target without an unnecessary clear', async () => {
    enabled(); const events: string[] = []; const link = connection(events, new Map([[1, { slot: 1, empty: true, footerHash: 0 }]]));
    await uploadPreparedSamples(link, [prepared(1, '01_NEW.wav', Uint8Array.of(2, 0))], { mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: record(1) }], onBackupReady: () => { events.push('download-zip'); }, onProgress: () => undefined });
    expect(events).toEqual(['read-1', 'download-zip', 'write-1', 'read-1']);
  });

  it('does not open a writer when triggering the backup download fails or export is already cancelled', async () => {
    enabled(); const failedEvents: string[] = []; const failedLink = connection(failedEvents);
    await expect(uploadPreparedSamples(failedLink, [prepared(1, '01_NEW.wav', Uint8Array.of(2, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: record(1) }], onBackupReady: () => { throw new Error('download failed'); }, onProgress: () => undefined,
    })).rejects.toThrow('download failed');
    expect(failedEvents).not.toContain('write-1');

    const signal = new AbortController(); signal.abort(); const cancelledEvents: string[] = []; const cancelledLink = connection(cancelledEvents);
    await expect(uploadPreparedSamples(cancelledLink, [prepared(1, '01_NEW.wav', Uint8Array.of(2, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: record(1) }], signal: signal.signal, onBackupReady: () => { cancelledEvents.push('download-zip'); }, onProgress: () => undefined,
    })).rejects.toThrow('cancelled');
    expect(cancelledEvents).toEqual([]);
  });

  it('preflights every restore entry before any write', async () => {
    enabled(); const events: string[] = []; const link = connection(events, new Map([[1, sample(1, 'OTHER', Uint8Array.of(9, 0))]]));
    const { parsed } = await createVerifiedSyntaktBackup([{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(2, 0) }], [backupFromPcm(1, 'OLD', Uint8Array.of(1, 0))]);
    await expect(restoreSyntaktBackup(link, parsed, { onProgress: () => undefined })).rejects.toThrow('original or intended');
    expect(events).not.toContain('write-1');
  });
});
