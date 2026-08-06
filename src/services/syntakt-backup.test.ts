import { describe, expect, it } from 'vitest';
import { backupFileName, isReachableTransferPhaseSequence, loadExactPcmBackup, makeOriginalBackup, makeSyntaktTransferManifest, parseSyntaktTransferManifest, persistSyntaktTransferManifest, transitionTransferEntry } from './syntakt-backup.js';
import type { SyntaktTransferPhase } from './syntakt-backup.js';
import { encodePcm16leWav } from './wav-encoder.js';

describe('durable Syntakt transfer manifest', () => {
  it('uses one strict format with target-bound intents and monotonic phases', async () => {
    const pcm16le = Uint8Array.of(0x34, 0x12);
    const manifest = await makeSyntaktTransferManifest([{ sourceSlot: 2, targetSlot: 1, intendedName: 'NEW SAMPLE', intendedPcm16le: pcm16le }]);
    expect(manifest).toMatchObject({ format: 'sympakt-syntakt-transfer', entries: [{ sourceSlot: 2, targetSlot: 1, phase: 'planned' }] });
    const wavData = encodePcm16leWav(pcm16le);
    const original = await makeOriginalBackup({ slot: 1, name: 'BD BAUTA', pcm16le, wavData });
    transitionTransferEntry(manifest.entries[0], 'backed-up', original);
    transitionTransferEntry(manifest.entries[0], 'write-started');
    expect(parseSyntaktTransferManifest(manifest)).toEqual(manifest);
    expect(() => transitionTransferEntry(manifest.entries[0], 'verified')).toThrow('transition');
  });

  it('binds backup WAV data to its target slot and rejects legacy/extra fields', async () => {
    const pcm16le = Uint8Array.of(0x34, 0x12, 0xdc, 0xfe);
    const wavData = encodePcm16leWav(pcm16le);
    const original = await makeOriginalBackup({ slot: 1, name: 'BD BAUTA', pcm16le, wavData });
    expect(original.fileName).toBe(backupFileName(1, 'BD BAUTA'));
    await expect(loadExactPcmBackup(original, 1, wavData)).resolves.toMatchObject({ slot: 1, name: 'BD BAUTA', pcm16le });
    const manifest = await makeSyntaktTransferManifest([{ sourceSlot: 1, targetSlot: 1, intendedName: 'NEW', intendedPcm16le: pcm16le }]);
    expect(() => parseSyntaktTransferManifest({ ...manifest, format: 'sympakt-syntakt-backup/v2' })).toThrow('Unsupported');
    expect(() => parseSyntaktTransferManifest({ ...manifest, extra: true })).toThrow('Unexpected');
  });

  it('accepts only reachable backup and sequential writer crash states', async () => {
    const pcm16le = Uint8Array.of(0x34, 0x12);
    const wavData = encodePcm16leWav(pcm16le);
    const original1 = await makeOriginalBackup({ slot: 1, name: 'ONE', pcm16le, wavData });
    const original2 = await makeOriginalBackup({ slot: 2, name: 'TWO', pcm16le, wavData });
    const partial = await makeSyntaktTransferManifest([
      { sourceSlot: 1, targetSlot: 1, intendedName: 'A', intendedPcm16le: pcm16le },
      { sourceSlot: 2, targetSlot: 2, intendedName: 'B', intendedPcm16le: pcm16le },
    ]);
    transitionTransferEntry(partial.entries[0], 'backed-up', original1);
    expect(parseSyntaktTransferManifest(partial)).toEqual(partial);

    const writeStarted = structuredClone(partial);
    transitionTransferEntry(writeStarted.entries[1], 'backed-up', original2);
    transitionTransferEntry(writeStarted.entries[0], 'write-started');
    expect(parseSyntaktTransferManifest(writeStarted)).toEqual(writeStarted);

    const impossiblePlanned = structuredClone(writeStarted);
    impossiblePlanned.entries[1] = { ...impossiblePlanned.entries[1], phase: 'planned', original: undefined };
    expect(() => parseSyntaktTransferManifest(impossiblePlanned)).toThrow('phase sequence');
    const impossibleOrder = structuredClone(writeStarted);
    impossibleOrder.entries.reverse();
    expect(() => parseSyntaktTransferManifest(impossibleOrder)).toThrow('phase sequence');
  });

  it('accepts exactly the sequential crash-state grammar', () => {
    const phases: SyntaktTransferPhase[] = ['planned', 'backed-up', 'write-started', 'written', 'verified'];
    const expected = (sequence: readonly SyntaktTransferPhase[]): boolean => {
      const pattern = (first: SyntaktTransferPhase, optional: SyntaktTransferPhase | null, last: SyntaktTransferPhase): boolean => {
        let index = 0;
        while (sequence[index] === first) index += 1;
        if (optional && sequence[index] === optional) index += 1;
        while (sequence[index] === last) index += 1;
        return index === sequence.length;
      };
      return pattern('backed-up', null, 'planned')
        || pattern('verified', 'written', 'backed-up')
        || pattern('verified', 'write-started', 'backed-up')
        || pattern('verified', null, 'backed-up')
        || pattern('written', 'write-started', 'backed-up')
        || pattern('written', null, 'backed-up');
    };
    const visit = (prefix: SyntaktTransferPhase[], remaining: number): void => {
      if (!remaining) { expect(isReachableTransferPhaseSequence(prefix), prefix.join(',')).toBe(expected(prefix)); return; }
      for (const phase of phases) visit([...prefix, phase], remaining - 1);
    };
    for (let length = 1; length <= 4; length += 1) visit([], length);
    expect(isReachableTransferPhaseSequence(['verified', 'written', 'written'])).toBe(false);
  });

  it('uses the reopened strict manifest as the sole durable journal value', async () => {
    const manifest = await makeSyntaktTransferManifest([{ sourceSlot: 1, targetSlot: 1, intendedName: 'A', intendedPcm16le: Uint8Array.of(0, 1) }]);
    let stored = '';
    const file = {
      createWritable: async () => ({ write: async (data: string) => { stored = data; }, close: async () => undefined }),
      getFile: async () => ({ text: async () => stored }),
    };
    await expect(persistSyntaktTransferManifest(file, manifest)).resolves.toEqual(manifest);
    await expect(persistSyntaktTransferManifest({
      createWritable: async () => ({ write: async () => { throw new Error('write failed'); }, close: async () => undefined }),
      getFile: file.getFile,
    }, manifest)).rejects.toThrow('write failed');
    await expect(persistSyntaktTransferManifest({
      createWritable: async () => ({ write: async () => undefined, close: async () => { throw new Error('close failed'); } }),
      getFile: file.getFile,
    }, manifest)).rejects.toThrow('close failed');
    await expect(persistSyntaktTransferManifest({
      createWritable: async () => ({ write: async () => { stored = '{bad'; }, close: async () => undefined }),
      getFile: file.getFile,
    }, manifest)).rejects.toThrow();
  });
});
