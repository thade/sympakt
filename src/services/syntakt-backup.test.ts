import { describe, expect, it } from 'vitest';
import { BACKUP_MANIFEST_FILE, backupFromPcm, createVerifiedSyntaktBackup, isSyntaktBackupArchive, parseSyntaktBackup, sha256Hex, tryParseSyntaktBackup } from './syntakt-backup.js';
import { encodePcm16leWav } from './wav-encoder.js';

describe('Syntakt Backup archive', () => {
  it('uses an explicit header and strictly round-trips original samples', async () => {
    const { archive, parsed } = await createVerifiedSyntaktBackup(
      [{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }, { targetSlot: 2, intendedName: 'NEXT', intendedPcm16le: Uint8Array.of(2, 0) }],
      [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0)), { slot: 2, empty: true }],
    );
    expect(isSyntaktBackupArchive(archive)).toBe(true);
    expect(parsed.manifest.entries).toHaveLength(2);
    expect(parsed.originals.get(1)).toMatchObject({ name: 'OLD', pcm16le: Uint8Array.of(3, 0) });
    expect(parsed.originals.get(2)).toEqual({ slot: 2, empty: true });
  });

  it('leaves ordinary ZIPs completely outside Backup ZIP parsing', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const ordinary = zipSync({ 'café.wav': strToU8('audio') });
    const trailingBytes = new Uint8Array(ordinary.length + 2);
    trailingBytes.set(ordinary);
    expect(isSyntaktBackupArchive(trailingBytes)).toBe(false);
    await expect(tryParseSyntaktBackup(trailingBytes)).resolves.toBeNull();
  });

  it('rejects a headered archive with missing or tampered data', async () => {
    const { archive } = await createVerifiedSyntaktBackup(
      [{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }],
      [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0))],
    );
    const zipOffset = archive.findIndex((byte, index) => byte === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 0x03 && archive[index + 3] === 0x04);
    expect(zipOffset).toBeGreaterThan(0);
    await expect(tryParseSyntaktBackup(archive.slice(0, zipOffset))).rejects.toThrow('Invalid Syntakt backup ZIP');
    const { unzipSync, zipSync } = await import('fflate');
    const files = unzipSync(archive.slice(zipOffset));
    delete files[Object.keys(files).find((path) => path.endsWith('.wav'))!];
    const tamperedZip = zipSync(files);
    const tamperedArchive = new Uint8Array(zipOffset + tamperedZip.length);
    tamperedArchive.set(archive.slice(0, zipOffset));
    tamperedArchive.set(tamperedZip, zipOffset);
    await expect(parseSyntaktBackup(tamperedArchive)).rejects.toThrow('Unexpected file');
    expect(files[BACKUP_MANIFEST_FILE]).toBeDefined();
  });

  it('rejects an archive whose extracted entries do not validate', async () => {
    const { archive } = await createVerifiedSyntaktBackup(
      [{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }],
      [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0))],
    );
    const zipOffset = findZipOffset(archive);
    const { zipSync, strToU8 } = await import('fflate');
    const payload = zipSync({
      'originals/slot-01-OLD.wav': new Uint8Array(2 * 1024 * 1024),
      [BACKUP_MANIFEST_FILE]: strToU8('{}'),
    });
    const tampered = new Uint8Array(zipOffset + payload.length);
    tampered.set(archive.subarray(0, zipOffset));
    tampered.set(payload, zipOffset);
    const local = zipOffset;
    const central = findSignature(tampered, 0x02014b50, zipOffset);
    new DataView(tampered.buffer).setUint32(local + 22, 2, true);
    new DataView(tampered.buffer).setUint32(central + 24, 2, true);
    await expect(parseSyntaktBackup(tampered)).rejects.toThrow('Invalid Syntakt backup ZIP');
  });

  it('rejects a headered backup whose decoded PCM is too long to restore', async () => {
    const { archive } = await createVerifiedSyntaktBackup(
      [{ targetSlot: 1, intendedName: 'NEW', intendedPcm16le: Uint8Array.of(1, 0) }],
      [backupFromPcm(1, 'OLD', Uint8Array.of(3, 0))],
    );
    const zipOffset = findZipOffset(archive);
    const pcm16le = new Uint8Array(480_002);
    const wavData = encodePcm16leWav(pcm16le);
    const fileName = 'originals/slot-01-OLD.wav';
    const { zipSync, strToU8 } = await import('fflate');
    const manifest = {
      format: 'sympakt-syntakt-backup',
      entries: [{
        targetSlot: 1,
        original: { name: 'OLD', fileName, wavSha256: await sha256Hex(wavData), pcmSha256: await sha256Hex(pcm16le) },
        intended: { name: 'NEW', pcmSha256: await sha256Hex(Uint8Array.of(1, 0)) },
      }],
    };
    const payload = zipSync({ [fileName]: wavData, [BACKUP_MANIFEST_FILE]: strToU8(JSON.stringify(manifest)) });
    const oversized = new Uint8Array(zipOffset + payload.length);
    oversized.set(archive.subarray(0, zipOffset));
    oversized.set(payload, zipOffset);
    await expect(parseSyntaktBackup(oversized)).rejects.toThrow('exceeds the five-second limit');
  });
});

function findZipOffset(archive: Uint8Array): number {
  const offset = findSignature(archive, 0x04034b50);
  expect(offset).toBeGreaterThan(0);
  return offset;
}

function findSignature(data: Uint8Array, signature: number, start = 0): number {
  for (let offset = start; offset <= data.length - 4; offset += 1) {
    if (new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true) === signature) return offset;
  }
  return -1;
}
