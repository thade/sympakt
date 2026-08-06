import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreSyntaktTransactionBackups, uploadPreparedSamples } from './syntakt-transfer.js';
import { sha256Hex } from './syntakt-backup.js';
import { SyntaktTransferJournalCoordinator } from './syntakt-transfer-journal.js';
import type { SyntaktConnection, SyntaktRecoveryEntry, SyntaktTransferJournal } from './syntakt-transfer.js';
import type { SyntaktBackupDirectoryHandle } from './syntakt-transfer-journal.js';
import type { PreparedSampleExport } from './zip-service.js';
import type { SyntaktDataSample } from '../elektron/syntakt-data-sample.js';
import type { SyntaktSampleSlot } from '../elektron/syntakt-slot-list.js';

const target = (slot: number): SyntaktSampleSlot => ({ slot, name: `TARGET ${slot}`, storedBytes: 100, operations: 0x7e, hasData: true, hasMetadata: false });
const sample = (slot: number, name: string, pcm16le: Uint8Array): SyntaktDataSample => ({ slot, name, frames: pcm16le.length / 2, pcm16le, footerHash: 0 });
const prepared = (slot: number, filename: string, pcm16le: Uint8Array): PreparedSampleExport => ({ slot, filename, pcm16le, wavData: new Uint8Array(44 + pcm16le.length) });

function enableSecureSyntaktWrite(): void {
  vi.stubGlobal('window', { isSecureContext: true, location: { hostname: 'sympakt.example', search: '' } });
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve(undefined) });
}

function journal(events: string[]): SyntaktTransferJournal {
  return {
    initialize: async (intents) => { events.push(`journal-start-${intents.map((intent) => `${intent.sourceSlot}:${intent.targetSlot}`).join(',')}`); },
    recordBackup: async (intent) => { events.push(`backup-${intent.targetSlot}`); },
    transition: async (slot, phase) => { events.push(`phase-${slot}-${phase}`); },
  };
}

function fakeConnection(events: string[], values = new Map<number, SyntaktDataSample>([[1, sample(1, 'TARGET 1', Uint8Array.of(1, 0))], [2, sample(2, 'TARGET 2', Uint8Array.of(2, 0))]])): SyntaktConnection {
  const device = {
    downloadSlot: async (slot: number) => { events.push(`download-${slot}`); return values.get(slot)!; },
    listSampleSlots: async () => { events.push('list'); return [target(1), target(2)]; },
    uploadSlot: async (slot: number, name: string, pcm16le: Uint8Array, _expected: SyntaktSampleSlot, _proof: unknown, onProgress: (progress: { sentBytes: number; totalBytes: number }) => void) => {
      events.push(`upload-${slot}`); values.set(slot, sample(slot, name, pcm16le)); onProgress({ sentBytes: pcm16le.length + 107, totalBytes: pcm16le.length + 107 });
    },
  };
  return { device, session: { close: vi.fn(async () => undefined) }, identity: { name: 'Syntakt', osVersion: '1.40' } } as unknown as SyntaktConnection;
}

class MemoryBackupDirectory implements SyntaktBackupDirectoryHandle {
  readonly files = new Map<string, Uint8Array>();
  private manifestWrites = 0;
  constructor(private readonly failure: 'write' | 'close' | 'corrupt' | null = null, private readonly failManifestWrite = 0) {}

  async getFileHandle(name: string): Promise<{
    createWritable(): Promise<{ write(data: Uint8Array | string): Promise<void>; close(): Promise<void> }>;
    getFile(): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
  }> {
    return {
      createWritable: async () => {
        let pending = new Uint8Array();
        return {
          write: async (data) => {
            if (this.failure === 'write' && name.endsWith('.wav')) throw new Error('backup write failed');
            if (name.endsWith('.json')) {
              this.manifestWrites += 1;
              if (this.manifestWrites === this.failManifestWrite) throw new Error('manifest write failed');
            }
            pending = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
          },
          close: async () => {
            if (this.failure === 'close' && name.endsWith('.wav')) throw new Error('backup close failed');
            this.files.set(name, this.failure === 'corrupt' && name.endsWith('.wav') ? Uint8Array.of(0) : pending);
          },
        };
      },
      getFile: async () => {
        const bytes = this.files.get(name) ?? new Uint8Array();
        return {
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.slice().buffer,
        };
      },
    };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('guarded Syntakt transfers', () => {
  it('durably records all target backups before the first writer and keeps target-bound intents', async () => {
    enableSecureSyntaktWrite(); const events: string[] = []; const connection = fakeConnection(events);
    await uploadPreparedSamples(connection, [prepared(1, '01_Alpha.wav', Uint8Array.of(11, 0)), prepared(2, '02_Beta.wav', Uint8Array.of(12, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 2, expectedTarget: target(2) }, { sourceSlot: 2, targetSlot: 1, expectedTarget: target(1) }],
      journal: journal(events), onProgress: () => undefined,
    });
    expect(events.slice(0, 7)).toEqual(['journal-start-1:2,2:1', 'download-2', 'backup-2', 'download-1', 'backup-1', 'phase-2-write-started', 'upload-2']);
    expect(events).toContain('phase-1-written');
    expect(connection.session.close).not.toHaveBeenCalled();
  });

  it('does not open a writer if durable write-started persistence fails', async () => {
    enableSecureSyntaktWrite(); const events: string[] = []; const connection = fakeConnection(events);
    const failing = journal(events); failing.transition = async () => { throw new Error('disk unavailable'); };
    await expect(uploadPreparedSamples(connection, [prepared(1, '01_Alpha.wav', Uint8Array.of(11, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: target(1) }], journal: failing, onProgress: () => undefined,
    })).rejects.toThrow('disk unavailable');
    expect(events).not.toContain('upload-1');
  });

  it('keeps a durable write-started recovery snapshot when the following device write fails', async () => {
    enableSecureSyntaktWrite(); const events: string[] = []; const connection = fakeConnection(events);
    (connection.device.uploadSlot as unknown as (slot: number, ...rest: unknown[]) => Promise<void>) = async (slot: number) => {
      events.push(`upload-${slot}`);
      if (slot === 2) throw new Error('device rejected writer');
    };
    const journal = new SyntaktTransferJournalCoordinator(new MemoryBackupDirectory());
    await expect(uploadPreparedSamples(connection, [prepared(1, '01_Alpha.wav', Uint8Array.of(11, 0)), prepared(2, '02_Beta.wav', Uint8Array.of(12, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: target(1) }, { sourceSlot: 2, targetSlot: 2, expectedTarget: target(2) }], verifyReadback: false, journal, onProgress: () => undefined,
    })).rejects.toThrow('device rejected writer');
    expect(journal.recoveryEntries.map((entry) => [entry.targetSlot, entry.phase])).toEqual([[1, 'written'], [2, 'write-started']]);
    expect(events).toContain('upload-2');
  });

  it.each(['write', 'close', 'corrupt'] as const)('does not open a writer when the WAV backup %s fails', async (failure) => {
    enableSecureSyntaktWrite(); const events: string[] = []; const connection = fakeConnection(events);
    const journal = new SyntaktTransferJournalCoordinator(new MemoryBackupDirectory(failure));
    await expect(uploadPreparedSamples(connection, [prepared(1, '01_Alpha.wav', Uint8Array.of(11, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: target(1) }], journal, onProgress: () => undefined,
    })).rejects.toThrow();
    expect(events).not.toContain('upload-1');
    expect(journal.recoveryEntries).toEqual([]);
  });

  it('does not open a writer when the real journal cannot durably mark write-started', async () => {
    enableSecureSyntaktWrite(); const events: string[] = []; const connection = fakeConnection(events);
    const journal = new SyntaktTransferJournalCoordinator(new MemoryBackupDirectory(null, 3));
    await expect(uploadPreparedSamples(connection, [prepared(1, '01_Alpha.wav', Uint8Array.of(11, 0))], {
      mappings: [{ sourceSlot: 1, targetSlot: 1, expectedTarget: target(1) }], journal, onProgress: () => undefined,
    })).rejects.toThrow('manifest write failed');
    expect(events).not.toContain('upload-1');
    expect(connection.session.close).toHaveBeenCalledOnce();
    expect(journal.recoveryEntries.map((entry) => [entry.targetSlot, entry.phase])).toEqual([[1, 'backed-up']]);
  });

  it('preflights every recovery entry before opening any restore writer', async () => {
    enableSecureSyntaktWrite(); const events: string[] = [];
    const original1 = sample(1, 'TARGET 1', Uint8Array.of(1, 0)); const intended1 = sample(1, 'Alpha', Uint8Array.of(11, 0));
    const original2 = sample(2, 'TARGET 2', Uint8Array.of(2, 0)); const unrelated2 = sample(2, 'Other', Uint8Array.of(9, 0));
    const connection = fakeConnection(events, new Map([[1, intended1], [2, unrelated2]]));
    const entries: SyntaktRecoveryEntry[] = [
      { sourceSlot: 1, targetSlot: 1, phase: 'written', backup: { ...original1, wavData: new Uint8Array(46) }, intendedName: 'Alpha', intendedPcmSha256: await sha256Hex(intended1.pcm16le) },
      { sourceSlot: 2, targetSlot: 2, phase: 'written', backup: { ...original2, wavData: new Uint8Array(46) }, intendedName: 'Beta', intendedPcmSha256: await sha256Hex(Uint8Array.of(12, 0)) },
    ];
    await expect(restoreSyntaktTransactionBackups(connection, entries, { onProgress: () => undefined })).rejects.toThrow('original or intended');
    expect(events).not.toContain('upload-1');
  });

  it('never restores a known-no-write entry whose original no longer matches', async () => {
    enableSecureSyntaktWrite(); const events: string[] = []; const intended = sample(1, 'Alpha', Uint8Array.of(11, 0));
    const connection = fakeConnection(events, new Map([[1, intended]]));
    await expect(restoreSyntaktTransactionBackups(connection, [{ sourceSlot: 1, targetSlot: 1, phase: 'backed-up', backup: { ...sample(1, 'TARGET 1', Uint8Array.of(1, 0)), wavData: new Uint8Array(46) }, intendedName: 'Alpha', intendedPcmSha256: await sha256Hex(intended.pcm16le) }], { onProgress: () => undefined })).rejects.toThrow('never written');
    expect(events).not.toContain('upload-1');
  });
});
