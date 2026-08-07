import { describe, expect, it } from 'vitest';
import { BACKUP_MANIFEST_FILE, backupFromPcm, createVerifiedSyntaktBackup, isSyntaktBackupArchive, parseSyntaktBackup, tryParseSyntaktBackup } from './syntakt-backup.js';

describe('Syntakt Backup ZIP', () => {
  it('reopens, hashes, and strictly maps original WAVs to their slots', async () => {
    const { archive, parsed } = await createVerifiedSyntaktBackup(
      [{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }, { targetSlot: 2, intendedName: 'NEXT', intendedPcm16le: Uint8Array.of(2, 0) }],
      [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0)), { slot: 2, empty: true }],
    );
    expect(isSyntaktBackupArchive(archive)).toBe(true);
    expect(parsed.manifest).toMatchObject({ format: 'sympakt-syntakt-backup', entries: [{ targetSlot: 1, original: { name: 'OLD' } }, { targetSlot: 2, original: null }] });
    expect(parsed.originals.get(1)).toMatchObject({ name: 'OLD', pcm16le: Uint8Array.of(3, 0) });
    expect(parsed.originals.get(2)).toEqual({ slot: 2, empty: true });
  });

  it('rejects a marker archive with missing or tampered data', async () => {
    const { archive } = await createVerifiedSyntaktBackup([{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }], [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0))]);
    const { unzipSync, zipSync, strToU8 } = await import('fflate');
    const files = unzipSync(archive);
    delete files[Object.keys(files).find((path) => path.endsWith('.wav'))!];
    await expect(parseSyntaktBackup(zipSync(files))).rejects.toThrow('Unexpected file');
    files[BACKUP_MANIFEST_FILE] = strToU8('{"format":"sympakt-syntakt-backup","entries":[]}');
    await expect(parseSyntaktBackup(zipSync(files))).rejects.toThrow();
  });

  it('rejects an over-limit marker from central-directory metadata before inflation', async () => {
    const { archive } = await createVerifiedSyntaktBackup([{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }], [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0))]);
    const modified = archive.slice();
    const central = modified.findIndex((value, index) => value === 0x50 && modified[index + 1] === 0x4b && modified[index + 2] === 0x01 && modified[index + 3] === 0x02);
    expect(central).toBeGreaterThan(0);
    modified.set(Uint8Array.of(0, 0, 0, 3), central + 24); // 48 MiB
    await expect(tryParseSyntaktBackup(modified)).rejects.toThrow('contents');
  });
});
