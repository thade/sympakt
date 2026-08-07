import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { extractPcm16leWav } from './wav-decoder.js';
import { encodePcm16leWav } from './wav-encoder.js';

/** The only archive format accepted for Syntakt backup and exact restore. */
export const SYNTAKT_BACKUP_FORMAT = 'sympakt-syntakt-backup' as const;
export const BACKUP_MANIFEST_FILE = 'sympakt-syntakt-backup.json';
const ORIGINALS_DIRECTORY = 'originals/';
// 64 × five-second mono PCM WAVs are about 30.8 MiB before ZIP overhead.
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 65;
const MAX_MANIFEST_BYTES = 64 * 1024;

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
    if (!intent.intendedPcm16le.length || intent.intendedPcm16le.length % 2 || seen.has(intent.targetSlot) || original.slot !== intent.targetSlot) {
      throw new Error('Invalid Syntakt backup target');
    }
    seen.add(intent.targetSlot);
    if ('empty' in original) {
      entries.push({ targetSlot: intent.targetSlot, original: null, intended: { name: intent.intendedName, pcmSha256: await sha256Hex(intent.intendedPcm16le) } });
      continue;
    }
    assertRestorableSyntaktName(original.name);
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
  const archive = zipSync(files, { level: 6 });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Syntakt backup ZIP exceeds the safe size limit');
  return { archive, parsed: await parseSyntaktBackup(archive) };
}

/** Strictly validate the marker, all archive paths, file set, WAVs, and hashes. */
export async function parseSyntaktBackup(archive: Uint8Array): Promise<ParsedSyntaktBackup> {
  const parsed = await tryParseSyntaktBackup(archive);
  if (!parsed) throw new Error('Not a Syntakt backup ZIP');
  return parsed;
}

/**
 * Inspect ZIP metadata before inflating anything. A normal ZIP returns null;
 * a ZIP containing our reserved marker either validates completely or throws.
 */
export async function tryParseSyntaktBackup(archive: Uint8Array): Promise<ParsedSyntaktBackup | null> {
  const entries = readZipEntries(archive);
  const marker = entries.find((entry) => entry.path === BACKUP_MANIFEST_FILE);
  if (!marker) return null;
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES || entries.length > MAX_BACKUP_ENTRIES || marker.uncompressedBytes > MAX_MANIFEST_BYTES) {
    throw new Error('Syntakt backup ZIP exceeds the safe size limit');
  }
  const totalUncompressedBytes = entries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
  if (totalUncompressedBytes > MAX_ARCHIVE_BYTES || entries.some((entry) => !isSafeArchivePath(entry.path) || entry.uncompressedBytes > MAX_ENTRY_BYTES)) {
    throw new Error('Invalid Syntakt backup ZIP contents');
  }
  let manifestBytes: Uint8Array | undefined;
  try { manifestBytes = unzipSync(archive, { filter: (file) => file.name === BACKUP_MANIFEST_FILE })[BACKUP_MANIFEST_FILE]; }
  catch { throw new Error('Invalid Syntakt backup ZIP'); }
  if (!manifestBytes || manifestBytes.length !== marker.uncompressedBytes || manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('Invalid Syntakt backup manifest');
  let raw: unknown;
  try { raw = JSON.parse(strFromU8(manifestBytes)); } catch { throw new Error('Invalid Syntakt backup manifest'); }
  const manifest = parseSyntaktBackupManifest(raw);
  const allowed = new Set<string>([BACKUP_MANIFEST_FILE]);
  for (const entry of manifest.entries) if (entry.original) allowed.add(entry.original.fileName);
  if (entries.length !== allowed.size || entries.some((entry) => !allowed.has(entry.path))) throw new Error('Unexpected file in Syntakt backup ZIP');
  let originalFiles: Record<string, Uint8Array>;
  try { originalFiles = unzipSync(archive, { filter: (file) => file.name !== BACKUP_MANIFEST_FILE && allowed.has(file.name) }); } catch { throw new Error('Invalid Syntakt backup ZIP'); }
  const files: Record<string, Uint8Array> = { [BACKUP_MANIFEST_FILE]: manifestBytes, ...originalFiles };
  if (Object.keys(files).length !== allowed.size || entries.some((entry) => files[entry.path]?.length !== entry.uncompressedBytes)) throw new Error('Invalid Syntakt backup ZIP contents');
  const originals = new Map<number, SyntaktBackupContent>();
  for (const entry of manifest.entries) {
    if (!entry.original) { originals.set(entry.targetSlot, { slot: entry.targetSlot, empty: true }); continue; }
    const wavData = files[entry.original.fileName];
    if (!wavData || await sha256Hex(wavData) !== entry.original.wavSha256) throw new Error(`Backup WAV checksum mismatch for Syntakt slot ${entry.targetSlot}`);
    const pcm16le = extractPcm16leWav(copyBuffer(wavData));
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
  try { return readZipEntries(archive).some((entry) => entry.path === BACKUP_MANIFEST_FILE); } catch { return false; }
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
interface ZipEntry { path: string; uncompressedBytes: number; }

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
  if (disk || centralDisk || entriesOnDisk !== entryCount || eocd + 22 + commentBytes !== archive.length || entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralBytes > eocd) {
    throw new Error('Invalid Syntakt backup ZIP');
  }
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralOffset + centralBytes || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid Syntakt backup ZIP');
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameBytes + extraBytes + commentLength;
    if (next > centralOffset + centralBytes || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) throw new Error('Invalid Syntakt backup ZIP');
    let path: string;
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(archive.slice(offset + 46, offset + 46 + nameBytes)); } catch { throw new Error('Invalid Syntakt backup ZIP'); }
    entries.push({ path, uncompressedBytes });
    offset = next;
  }
  if (offset !== centralOffset + centralBytes) throw new Error('Invalid Syntakt backup ZIP');
  return entries;
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
function copyBuffer(data: Uint8Array): ArrayBuffer { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer; }

export async function sha256Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure SHA-256 support is required for Syntakt backup verification');
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(data)));
  return [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
}
