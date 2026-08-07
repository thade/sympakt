import { strFromU8, strToU8, zipSync } from 'fflate';
import { SYNTAKT_MAX_SAMPLE_FRAMES } from '../elektron/syntakt-data-sample.js';
import { extractPcm16leWav } from './wav-decoder.js';
import { encodePcm16leWav } from './wav-encoder.js';

/** The only archive format accepted for Syntakt backup and exact restore. */
export const SYNTAKT_BACKUP_FORMAT = 'sympakt-syntakt-backup' as const;
export const BACKUP_MANIFEST_FILE = 'sympakt-syntakt-backup.json';
const SYNTAKT_BACKUP_HEADER = Uint8Array.of(
  0x53, 0x59, 0x4d, 0x50, 0x41, 0x4b, 0x54, 0x2d,
  0x53, 0x59, 0x4e, 0x54, 0x41, 0x4b, 0x54, 0x2d,
  0x42, 0x41, 0x43, 0x4b, 0x55, 0x50, 0x01,
);
const ORIGINALS_DIRECTORY = 'originals/';
// 64 × five-second mono PCM WAVs are about 30.8 MiB before ZIP overhead.
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 65;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PCM16LE_BYTES = SYNTAKT_MAX_SAMPLE_FRAMES * 2;

export interface SyntaktBackupOriginal {
  name: string;
  fileName: string;
  wavSha256: string;
  pcmSha256: string;
}

export interface SyntaktBackupEntry {
  targetSlot: number;
  /** null represents the exact empty-slot sentinel, not an absent archive entry. */
  original: SyntaktBackupOriginal | null;
  intended: { name: string; pcmSha256: string };
}

export interface SyntaktBackupManifest {
  format: typeof SYNTAKT_BACKUP_FORMAT;
  entries: SyntaktBackupEntry[];
}

export interface SyntaktSlotBackup {
  slot: number;
  name: string;
  pcm16le: Uint8Array;
  wavData: Uint8Array;
}

export interface EmptySyntaktSlotBackup { slot: number; empty: true; }
export type SyntaktBackupContent = SyntaktSlotBackup | EmptySyntaktSlotBackup;

export interface SyntaktBackupIntent {
  targetSlot: number;
  intendedName: string;
  intendedPcm16le: Uint8Array;
}

export interface ParsedSyntaktBackup {
  manifest: SyntaktBackupManifest;
  originals: ReadonlyMap<number, SyntaktBackupContent>;
}

export function assertRestorableSyntaktName(name: string): void {
  const bytes = new TextEncoder().encode(name);
  if (!name || bytes.length > 16 || [...bytes].some((value) => value > 0x7f)) {
    throw new Error('Syntakt sample names must be 1–16 ASCII bytes');
  }
}

export function backupFileName(slot: number, name: string): string {
  assertSlot(slot);
  const safe = name.replace(/[^A-Za-z0-9 _-]/g, '_').trim().slice(0, 16) || 'sample';
  return `${ORIGINALS_DIRECTORY}slot-${String(slot).padStart(2, '0')}-${safe}.wav`;
}

/** Build and immediately reopen the archive before it is offered for download. */
export async function createVerifiedSyntaktBackup(
  intents: readonly SyntaktBackupIntent[],
  originals: readonly SyntaktBackupContent[],
): Promise<{ archive: Uint8Array; parsed: ParsedSyntaktBackup }> {
  if (!intents.length || intents.length !== originals.length) throw new Error('Syntakt backup needs one original for every target');
  const files: Record<string, Uint8Array> = {};
  const entries: SyntaktBackupEntry[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];
    const original = originals[index];
    assertSlot(intent.targetSlot);
    assertRestorableSyntaktName(intent.intendedName);
    if (!isRestorablePcm16le(intent.intendedPcm16le) || seen.has(intent.targetSlot) || original.slot !== intent.targetSlot) {
      throw new Error('Invalid Syntakt backup target');
    }
    seen.add(intent.targetSlot);
    if ('empty' in original) {
      entries.push({ targetSlot: intent.targetSlot, original: null, intended: { name: intent.intendedName, pcmSha256: await sha256Hex(intent.intendedPcm16le) } });
      continue;
    }
    assertRestorableSyntaktName(original.name);
    if (!isRestorablePcm16le(original.pcm16le)) throw new Error('Syntakt backup sample exceeds the five-second limit');
    const fileName = backupFileName(original.slot, original.name);
    const wavData = new Uint8Array(original.wavData);
    const originalMeta: SyntaktBackupOriginal = {
      name: original.name,
      fileName,
      wavSha256: await sha256Hex(wavData),
      pcmSha256: await sha256Hex(original.pcm16le),
    };
    files[fileName] = wavData;
    entries.push({ targetSlot: intent.targetSlot, original: originalMeta, intended: { name: intent.intendedName, pcmSha256: await sha256Hex(intent.intendedPcm16le) } });
  }
  const manifest: SyntaktBackupManifest = { format: SYNTAKT_BACKUP_FORMAT, entries };
  files[BACKUP_MANIFEST_FILE] = strToU8(JSON.stringify(manifest, null, 2));
  const archive = wrapSyntaktBackupZip(zipSync(files, { level: 6 }));
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Syntakt backup ZIP exceeds the safe size limit');
  return { archive, parsed: await parseSyntaktBackup(archive) };
}

/** Strictly validate the explicit header, ZIP payload, paths, file set, WAVs, and hashes. */
export async function parseSyntaktBackup(archive: Uint8Array): Promise<ParsedSyntaktBackup> {
  const parsed = await tryParseSyntaktBackup(archive);
  if (!parsed) throw new Error('Not a Syntakt backup ZIP');
  return parsed;
}

/**
 * A normal ZIP returns null without ZIP inspection. A headered backup validates
 * completely or throws; it never falls through to ordinary sample-pack import.
 */
export async function tryParseSyntaktBackup(archive: Uint8Array): Promise<ParsedSyntaktBackup | null> {
  if (!hasSyntaktBackupHeader(archive)) return null;
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Syntakt backup ZIP exceeds the safe size limit');
  const zipPayload = unwrapSyntaktBackupZip(archive)!;
  const entries = readZipEntries(zipPayload);
  const marker = entries.find((entry) => entry.path === BACKUP_MANIFEST_FILE);
  if (!marker) throw new Error('Invalid Syntakt backup ZIP');
  if (!zipPayload.length || marker.uncompressedBytes > MAX_MANIFEST_BYTES) {
    throw new Error('Syntakt backup ZIP exceeds the safe size limit');
  }
  const totalUncompressedBytes = entries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
  if (totalUncompressedBytes > MAX_ARCHIVE_BYTES || entries.some((entry) => !isSafeArchivePath(entry.path) || entry.uncompressedBytes > MAX_ENTRY_BYTES)) {
    throw new Error('Invalid Syntakt backup ZIP contents');
  }
  const files = await inflateZipEntriesBounded(zipPayload, entries);
  const manifestBytes = files[BACKUP_MANIFEST_FILE];
  if (!manifestBytes || manifestBytes.length !== marker.uncompressedBytes || manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('Invalid Syntakt backup manifest');
  let raw: unknown;
  try { raw = JSON.parse(strFromU8(manifestBytes)); } catch { throw new Error('Invalid Syntakt backup manifest'); }
  const manifest = parseSyntaktBackupManifest(raw);
  const allowed = new Set<string>([BACKUP_MANIFEST_FILE]);
  for (const entry of manifest.entries) if (entry.original) allowed.add(entry.original.fileName);
  if (entries.length !== allowed.size || entries.some((entry) => !allowed.has(entry.path))) throw new Error('Unexpected file in Syntakt backup ZIP');
  if (Object.keys(files).length !== allowed.size || entries.some((entry) => files[entry.path]?.length !== entry.uncompressedBytes)) throw new Error('Invalid Syntakt backup ZIP contents');
  const originals = new Map<number, SyntaktBackupContent>();
  for (const entry of manifest.entries) {
    if (!entry.original) { originals.set(entry.targetSlot, { slot: entry.targetSlot, empty: true }); continue; }
    const wavData = files[entry.original.fileName];
    if (!wavData || await sha256Hex(wavData) !== entry.original.wavSha256) throw new Error(`Backup WAV checksum mismatch for Syntakt slot ${entry.targetSlot}`);
    const pcm16le = extractPcm16leWav(copyBuffer(wavData));
    if (!isRestorablePcm16le(pcm16le)) throw new Error(`Backup sample for Syntakt slot ${entry.targetSlot} exceeds the five-second limit`);
    if (await sha256Hex(pcm16le) !== entry.original.pcmSha256) throw new Error(`Backup PCM checksum mismatch for Syntakt slot ${entry.targetSlot}`);
    originals.set(entry.targetSlot, { slot: entry.targetSlot, name: entry.original.name, pcm16le, wavData: new Uint8Array(wavData) });
  }
  return { manifest, originals };
}

export function parseSyntaktBackupManifest(value: unknown): SyntaktBackupManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid Syntakt backup manifest');
  const manifest = value as Record<string, unknown>;
  assertExactKeys(manifest, ['format', 'entries'], 'Syntakt backup manifest');
  if (manifest.format !== SYNTAKT_BACKUP_FORMAT || !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('Unsupported or invalid Syntakt backup manifest');
  const targets = new Set<number>();
  const entries = manifest.entries.map((value) => parseEntry(value, targets));
  return { format: SYNTAKT_BACKUP_FORMAT, entries };
}

export function isSyntaktBackupArchive(archive: Uint8Array): boolean {
  return hasSyntaktBackupHeader(archive);
}

function wrapSyntaktBackupZip(zipPayload: Uint8Array): Uint8Array {
  const archive = new Uint8Array(SYNTAKT_BACKUP_HEADER.length + zipPayload.length);
  archive.set(SYNTAKT_BACKUP_HEADER);
  archive.set(zipPayload, SYNTAKT_BACKUP_HEADER.length);
  return archive;
}

function unwrapSyntaktBackupZip(archive: Uint8Array): Uint8Array | null {
  if (!hasSyntaktBackupHeader(archive)) return null;
  return archive.subarray(SYNTAKT_BACKUP_HEADER.length);
}

function hasSyntaktBackupHeader(archive: Uint8Array): boolean {
  return archive.length >= SYNTAKT_BACKUP_HEADER.length && SYNTAKT_BACKUP_HEADER.every((byte, index) => archive[index] === byte);
}

export function backupAsWav(content: SyntaktBackupContent): Uint8Array | null {
  return 'empty' in content ? null : new Uint8Array(content.wavData);
}

export function backupFromPcm(slot: number, name: string, pcm16le: Uint8Array): SyntaktSlotBackup {
  return { slot, name, pcm16le: new Uint8Array(pcm16le), wavData: encodePcm16leWav(pcm16le) };
}

function parseEntry(value: unknown, targets: Set<number>): SyntaktBackupEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid Syntakt backup entry');
  const entry = value as Record<string, unknown>;
  assertExactKeys(entry, ['targetSlot', 'original', 'intended'], 'Syntakt backup entry');
  if (!Number.isInteger(entry.targetSlot) || !entry.intended || typeof entry.intended !== 'object') throw new Error('Invalid Syntakt backup entry');
  const targetSlot = entry.targetSlot as number;
  assertSlot(targetSlot);
  if (targets.has(targetSlot)) throw new Error('Duplicate Syntakt backup target slot');
  targets.add(targetSlot);
  const intended = entry.intended as Record<string, unknown>;
  assertExactKeys(intended, ['name', 'pcmSha256'], 'Syntakt backup intended sample');
  if (typeof intended.name !== 'string' || typeof intended.pcmSha256 !== 'string') throw new Error('Invalid Syntakt backup intended sample');
  assertRestorableSyntaktName(intended.name); assertSha(intended.pcmSha256);
  if (entry.original === null) return { targetSlot, original: null, intended: { name: intended.name, pcmSha256: intended.pcmSha256 } };
  if (!entry.original || typeof entry.original !== 'object') throw new Error('Invalid Syntakt backup original sample');
  const original = entry.original as Record<string, unknown>;
  assertExactKeys(original, ['name', 'fileName', 'wavSha256', 'pcmSha256'], 'Syntakt backup original sample');
  if (typeof original.name !== 'string' || typeof original.fileName !== 'string' || typeof original.wavSha256 !== 'string' || typeof original.pcmSha256 !== 'string') throw new Error('Invalid Syntakt backup original sample');
  assertRestorableSyntaktName(original.name); assertSha(original.wavSha256); assertSha(original.pcmSha256);
  if (original.fileName !== backupFileName(targetSlot, original.name)) throw new Error('Invalid Syntakt backup file mapping');
  return { targetSlot, original: { name: original.name, fileName: original.fileName, wavSha256: original.wavSha256, pcmSha256: original.pcmSha256 }, intended: { name: intended.name, pcmSha256: intended.pcmSha256 } };
}

function isSafeArchivePath(path: string): boolean {
  return path === BACKUP_MANIFEST_FILE || (/^originals\/slot-\d{2}-[A-Za-z0-9 _-]+\.wav$/.test(path) && !path.includes('..'));
}
interface ZipEntry {
  path: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localOffset: number;
  dataOffset: number;
}

/** Read a non-ZIP64 central directory without inflating file contents. */
function readZipEntries(archive: Uint8Array): ZipEntry[] {
  if (archive.length < 22) return [];
  const eocd = findEndOfCentralDirectory(archive);
  if (eocd < 0) return [];
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralBytes = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentBytes = view.getUint16(eocd + 20, true);
  if (disk || centralDisk || entriesOnDisk !== entryCount || eocd + 22 + commentBytes !== archive.length || entryCount === 0xffff || entryCount > MAX_BACKUP_ENTRIES || centralBytes === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralBytes > eocd) {
    throw new Error('Invalid Syntakt backup ZIP');
  }
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralOffset + centralBytes || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid Syntakt backup ZIP');
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameBytes + extraBytes + commentLength;
    if (next > centralOffset + centralBytes || (flags & 0x0009) !== 0 || (compression !== 0 && compression !== 8) || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) throw new Error('Invalid Syntakt backup ZIP');
    let path: string;
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(offset + 46, offset + 46 + nameBytes)); } catch { throw new Error('Invalid Syntakt backup ZIP'); }
    const dataOffset = assertCentralLocalLink(archive, centralOffset, { path, flags, compression, crc32, compressedBytes, uncompressedBytes, localOffset, dataOffset: 0 });
    entries.push({ path, flags, compression, crc32, compressedBytes, uncompressedBytes, localOffset, dataOffset });
    offset = next;
  }
  if (offset !== centralOffset + centralBytes) throw new Error('Invalid Syntakt backup ZIP');
  let localEnd = 0;
  for (const entry of [...entries].sort((left, right) => left.localOffset - right.localOffset)) {
    if (entry.localOffset !== localEnd) throw new Error('Invalid Syntakt backup ZIP');
    localEnd = entry.dataOffset + entry.compressedBytes;
  }
  if (localEnd !== centralOffset) throw new Error('Invalid Syntakt backup ZIP');
  return entries;
}

function assertCentralLocalLink(archive: Uint8Array, centralOffset: number, entry: ZipEntry): number {
  if (entry.localOffset + 30 > centralOffset) throw new Error('Invalid Syntakt backup ZIP');
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50 || view.getUint16(entry.localOffset + 6, true) !== entry.flags || view.getUint16(entry.localOffset + 8, true) !== entry.compression || view.getUint32(entry.localOffset + 14, true) !== entry.crc32 || view.getUint32(entry.localOffset + 18, true) !== entry.compressedBytes || view.getUint32(entry.localOffset + 22, true) !== entry.uncompressedBytes) throw new Error('Invalid Syntakt backup ZIP');
  const nameBytes = view.getUint16(entry.localOffset + 26, true);
  const extraBytes = view.getUint16(entry.localOffset + 28, true);
  const nameOffset = entry.localOffset + 30;
  const dataOffset = nameOffset + nameBytes + extraBytes;
  if (dataOffset + entry.compressedBytes > centralOffset) throw new Error('Invalid Syntakt backup ZIP');
  let localPath: string;
  try { localPath = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(nameOffset, nameOffset + nameBytes)); } catch { throw new Error('Invalid Syntakt backup ZIP'); }
  if (localPath !== entry.path) throw new Error('Invalid Syntakt backup ZIP');
  return dataOffset;
}

/** Inflate entries with the browser's incremental decompressor, rejecting each chunk before retaining it. */
async function inflateZipEntriesBounded(archive: Uint8Array, entries: readonly ZipEntry[]): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  try {
    for (const entry of entries) {
      const compressed = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes);
      const chunks: Uint8Array[] = [];
      let fileBytes = 0;
      let crc = 0xffffffff;
      const chunksToRead = entry.compression === 0 ? [compressed] : inflateDeflateRaw(compressed);
      for await (const data of chunksToRead) {
        const nextFileBytes = fileBytes + data.length;
        const nextTotalBytes = totalBytes + data.length;
        if (nextFileBytes > entry.uncompressedBytes || nextFileBytes > MAX_ENTRY_BYTES || nextTotalBytes > MAX_ARCHIVE_BYTES) {
          throw new Error('Syntakt backup ZIP exceeds the safe size limit');
        }
        fileBytes = nextFileBytes;
        totalBytes = nextTotalBytes;
        crc = zipCrc32Update(crc, data);
        chunks.push(data);
      }
      if (fileBytes !== entry.uncompressedBytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('Invalid Syntakt backup ZIP');
      files[entry.path] = concatChunks(chunks, fileBytes);
    }
  } catch (error) {
    throw backupZipError(error);
  }
  return files;
}

async function* inflateDeflateRaw(compressed: Uint8Array): AsyncGenerator<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('Syntakt backup ZIP requires browser decompression support');
  let offset = 0;
  const input = new ReadableStream<BufferSource>({
    pull(controller) {
      if (offset === compressed.length) { controller.close(); return; }
      const end = Math.min(offset + 16 * 1024, compressed.length);
      controller.enqueue(compressed.subarray(offset, end) as BufferSource);
      offset = end;
    },
  });
  let decompressor: DecompressionStream;
  try { decompressor = new DecompressionStream('deflate-raw'); }
  catch { throw new Error('Syntakt backup ZIP requires browser decompression support'); }
  const reader = input.pipeThrough(decompressor).getReader();
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { finished = true; return; }
      if (value) yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function backupZipError(error: unknown): Error {
  return error instanceof Error && (error.message === 'Syntakt backup ZIP exceeds the safe size limit' || error.message === 'Syntakt backup ZIP requires browser decompression support')
    ? error
    : new Error('Invalid Syntakt backup ZIP');
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return joined;
}

function zipCrc32Update(crc: number, data: Uint8Array): number {
  let next = crc;
  for (const value of data) {
    next ^= value;
    for (let bit = 0; bit < 8; bit += 1) next = (next & 1) ? (next >>> 1) ^ 0xedb88320 : next >>> 1;
  }
  return next >>> 0;
}

function findEndOfCentralDirectory(archive: Uint8Array): number {
  const lowerBound = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= lowerBound; offset -= 1) {
    if (archive[offset] === 0x50 && archive[offset + 1] === 0x4b && archive[offset + 2] === 0x05 && archive[offset + 3] === 0x06) return offset;
  }
  return -1;
}
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) throw new Error(`Invalid ${label}`);
}
function assertSlot(slot: number): void { if (!Number.isInteger(slot) || slot < 1 || slot > 64) throw new Error('Invalid Syntakt target slot'); }
function assertSha(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid Syntakt backup SHA-256'); }
function isRestorablePcm16le(pcm16le: Uint8Array): boolean { return pcm16le.length > 0 && pcm16le.length % 2 === 0 && pcm16le.length <= MAX_PCM16LE_BYTES; }
function copyBuffer(data: Uint8Array): ArrayBuffer { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer; }

export async function sha256Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure SHA-256 support is required for Syntakt backup verification');
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(data)));
  return [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
}
