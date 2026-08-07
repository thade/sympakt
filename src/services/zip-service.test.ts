import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { importSamplePack } from './zip-service.js';
import { BACKUP_MANIFEST_FILE, backupFromPcm, createVerifiedSyntaktBackup } from './syntakt-backup.js';

function asFile(archive: Uint8Array): File {
  return {
    name: 'ordinary.zip',
    arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
  } as File;
}

describe('ordinary ZIP import', () => {
  it('does not apply Syntakt backup ZIP rules to ordinary packs with trailing bytes', async () => {
    const archive = zipSync({ 'ordinary.txt': strToU8('ordinary pack') });
    const trailingBytes = new Uint8Array(archive.length + 2);
    trailingBytes.set(archive);

    const result = await importSamplePack(asFile(trailingBytes));
    expect(result.syntaktBackup).toBeUndefined();
  });

  it('does not let a malformed Backup ZIP fall through to ordinary import', async () => {
    const { archive } = await createVerifiedSyntaktBackup(
      [{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }],
      [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0))],
    );
    const corrupted = archive.slice();
    const markerHeader = centralHeaderFor(corrupted, BACKUP_MANIFEST_FILE);
    expect(markerHeader).toBeDefined();
    if (markerHeader === undefined) throw new Error('Expected Backup ZIP marker header');
    corrupted[markerHeader] = 0;
    await expect(importSamplePack(asFile(corrupted))).rejects.toThrow('Invalid Syntakt backup ZIP');
  });
});

function centralHeaderFor(archive: Uint8Array, path: string): number | undefined {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 46 <= archive.length; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameBytes = view.getUint16(offset + 28, true);
    if (decoder.decode(archive.slice(offset + 46, offset + 46 + nameBytes)) === path) return offset;
  }
  return undefined;
}
