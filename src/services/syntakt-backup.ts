import { extractPcm16leWav } from './wav-decoder.js';

/** One strict, frozen manifest format for guarded Syntakt transfers. */
export const BACKUP_MANIFEST_FILE = 'sympakt-syntakt-backup.json';
export const SYNTAKT_TRANSFER_MANIFEST_FORMAT = 'sympakt-syntakt-transfer' as const;

export type SyntaktTransferPhase = 'planned' | 'backed-up' | 'write-started' | 'written' | 'verified';

export interface SyntaktOriginalBackup {
  name: string;
  fileName: string;
  wavSha256: string;
  pcmSha256: string;
}

export interface SyntaktTransferEntry {
  sourceSlot: number;
  targetSlot: number;
  intendedName: string;
  intendedPcmSha256: string;
  phase: SyntaktTransferPhase;
  original?: SyntaktOriginalBackup;
}

export interface SyntaktTransferManifest {
  format: typeof SYNTAKT_TRANSFER_MANIFEST_FORMAT;
  entries: SyntaktTransferEntry[];
}

export interface ExactPcmBackup {
  slot: number;
  name: string;
  pcm16le: Uint8Array;
  wavData: Uint8Array;
}

/** Narrow File System Access seam for the transfer journal and its tests. */
export interface SyntaktManifestFileHandle {
  createWritable(): Promise<{ write(data: Uint8Array | string): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<{ text(): Promise<string> }>;
}

const PHASES: readonly SyntaktTransferPhase[] = ['planned', 'backed-up', 'write-started', 'written', 'verified'];

export function assertRestorableSyntaktName(name: string): void {
  const bytes = new TextEncoder().encode(name);
  if (!name || bytes.length > 16 || [...bytes].some((value) => value > 0x7f)) {
    throw new Error('The selected Syntakt target name cannot be restored by the supported ASCII writer');
  }
}

export function backupFileName(slot: number, name: string): string {
  assertSlot(slot, 'backup');
  return `slot-${String(slot).padStart(2, '0')}-${name.replace(/[^A-Za-z0-9 _-]/g, '_').trim().slice(0, 16) || 'sample'}.wav`;
}

export async function makeOriginalBackup(backup: ExactPcmBackup): Promise<SyntaktOriginalBackup> {
  assertSlot(backup.slot, 'backup');
  assertRestorableSyntaktName(backup.name);
  return {
    name: backup.name,
    fileName: backupFileName(backup.slot, backup.name),
    wavSha256: await sha256Hex(backup.wavData),
    pcmSha256: await sha256Hex(backup.pcm16le),
  };
}

export async function makeSyntaktTransferManifest(
  intents: ReadonlyArray<{ sourceSlot: number; targetSlot: number; intendedName: string; intendedPcm16le: Uint8Array }>,
): Promise<SyntaktTransferManifest> {
  if (!intents.length) throw new Error('A Syntakt transfer needs at least one slot');
  const sources = new Set<number>();
  const targets = new Set<number>();
  const entries: SyntaktTransferEntry[] = [];
  for (const intent of intents) {
    assertSlot(intent.sourceSlot, 'source');
    assertSlot(intent.targetSlot, 'target');
    if (sources.has(intent.sourceSlot) || targets.has(intent.targetSlot)) throw new Error('Duplicate Syntakt transfer source or target slot');
    assertRestorableSyntaktName(intent.intendedName);
    if (!intent.intendedPcm16le.length || intent.intendedPcm16le.length % 2) throw new Error('Invalid Syntakt transfer PCM');
    sources.add(intent.sourceSlot);
    targets.add(intent.targetSlot);
    entries.push({
      sourceSlot: intent.sourceSlot,
      targetSlot: intent.targetSlot,
      intendedName: intent.intendedName,
      intendedPcmSha256: await sha256Hex(intent.intendedPcm16le),
      phase: 'planned',
    });
  }
  return { format: SYNTAKT_TRANSFER_MANIFEST_FORMAT, entries };
}

export function transitionTransferEntry(entry: SyntaktTransferEntry, phase: SyntaktTransferPhase, original?: SyntaktOriginalBackup): void {
  const from = PHASES.indexOf(entry.phase);
  const to = PHASES.indexOf(phase);
  if (from < 0 || to !== from + 1) throw new Error(`Invalid Syntakt transfer phase transition ${entry.phase} → ${phase}`);
  if (phase === 'backed-up') {
    if (!original) throw new Error('A durable original backup is required before writing');
    entry.original = original;
  } else if (original) {
    throw new Error('Original backup may only be recorded with backed-up phase');
  }
  entry.phase = phase;
}

export function parseSyntaktTransferManifest(value: unknown): SyntaktTransferManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid Syntakt transfer manifest');
  const manifest = value as Record<string, unknown>;
  assertExactKeys(manifest, ['format', 'entries'], 'Syntakt transfer manifest');
  if (manifest.format !== SYNTAKT_TRANSFER_MANIFEST_FORMAT || !Array.isArray(manifest.entries) || !manifest.entries.length) {
    throw new Error('Unsupported or invalid Syntakt transfer manifest');
  }
  const sources = new Set<number>();
  const targets = new Set<number>();
  const entries = manifest.entries.map((value) => parseEntry(value, sources, targets));
  if (!isReachableTransferPhaseSequence(entries.map((entry) => entry.phase))) {
    throw new Error('Impossible Syntakt transfer phase sequence');
  }
  return { format: SYNTAKT_TRANSFER_MANIFEST_FORMAT, entries };
}

/** Close, reopen, strictly parse, and return the only durable manifest value. */
export async function persistSyntaktTransferManifest(file: SyntaktManifestFileHandle, manifest: SyntaktTransferManifest): Promise<SyntaktTransferManifest> {
  const writer = await file.createWritable();
  await writer.write(JSON.stringify(manifest, null, 2));
  await writer.close();
  const persisted = parseSyntaktTransferManifest(JSON.parse(await (await file.getFile()).text()));
  if (JSON.stringify(persisted) !== JSON.stringify(manifest)) throw new Error('Durable Syntakt transfer manifest revalidation failed');
  return persisted;
}

/**
 * The writer is sequential and every backup finishes before the first write.
 * A manifest is therefore one of exactly three shapes:
 * backed-up* planned*, verified* (written|write-started)? backed-up*, or
 * written* write-started? backed-up*. Keeping this predicate pure makes the
 * crash-state grammar easy to test independently of manifest parsing.
 */
export function isReachableTransferPhaseSequence(phases: readonly SyntaktTransferPhase[]): boolean {
  if (!phases.length) return false;
  const matches = (prefix: readonly SyntaktTransferPhase[], optional: SyntaktTransferPhase | null, suffix: readonly SyntaktTransferPhase[]): boolean => {
    let index = 0;
    while (index < phases.length && prefix.includes(phases[index])) index += 1;
    if (optional && phases[index] === optional) index += 1;
    while (index < phases.length && suffix.includes(phases[index])) index += 1;
    return index === phases.length;
  };
  return matches(['backed-up'], null, ['planned'])
    || matches(['verified'], 'written', ['backed-up'])
    || matches(['verified'], 'write-started', ['backed-up'])
    || matches(['verified'], null, ['backed-up'])
    || matches(['written'], 'write-started', ['backed-up'])
    || matches(['written'], null, ['backed-up']);
}

function parseEntry(value: unknown, sources: Set<number>, targets: Set<number>): SyntaktTransferEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid Syntakt transfer entry');
  const entry = value as Record<string, unknown>;
  const allowed = ['sourceSlot', 'targetSlot', 'intendedName', 'intendedPcmSha256', 'phase', 'original'];
  assertExactKeys(entry, allowed, 'Syntakt transfer entry', ['original']);
  if (!Number.isInteger(entry.sourceSlot) || !Number.isInteger(entry.targetSlot) || typeof entry.intendedName !== 'string'
    || typeof entry.intendedPcmSha256 !== 'string' || typeof entry.phase !== 'string' || !PHASES.includes(entry.phase as SyntaktTransferPhase)) {
    throw new Error('Invalid Syntakt transfer entry');
  }
  const sourceSlot = entry.sourceSlot as number;
  const targetSlot = entry.targetSlot as number;
  assertSlot(sourceSlot, 'source'); assertSlot(targetSlot, 'target');
  if (sources.has(sourceSlot) || targets.has(targetSlot)) throw new Error('Duplicate Syntakt transfer source or target slot');
  sources.add(sourceSlot); targets.add(targetSlot);
  assertRestorableSyntaktName(entry.intendedName);
  assertSha(entry.intendedPcmSha256, 'intended PCM');
  const phase = entry.phase as SyntaktTransferPhase;
  const original = entry.original === undefined ? undefined : parseOriginal(entry.original, targetSlot);
  if ((phase === 'planned') !== (original === undefined)) throw new Error('Syntakt transfer phase and original backup disagree');
  return { sourceSlot, targetSlot, intendedName: entry.intendedName, intendedPcmSha256: entry.intendedPcmSha256, phase, original };
}

function parseOriginal(value: unknown, targetSlot: number): SyntaktOriginalBackup {
  if (!value || typeof value !== 'object') throw new Error('Invalid Syntakt original backup');
  const original = value as Record<string, unknown>;
  assertExactKeys(original, ['name', 'fileName', 'wavSha256', 'pcmSha256'], 'Syntakt original backup');
  if (typeof original.name !== 'string' || typeof original.fileName !== 'string' || typeof original.wavSha256 !== 'string' || typeof original.pcmSha256 !== 'string') throw new Error('Invalid Syntakt original backup');
  assertRestorableSyntaktName(original.name);
  if (original.fileName !== backupFileName(targetSlot, original.name)) throw new Error('Syntakt backup manifest file mapping is invalid');
  assertSha(original.wavSha256, 'WAV'); assertSha(original.pcmSha256, 'PCM');
  return { name: original.name, fileName: original.fileName, wavSha256: original.wavSha256, pcmSha256: original.pcmSha256 };
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unexpected ${label} field`);
  for (const key of keys) if (!optional.includes(key) && !(key in value)) throw new Error(`Missing ${label} field`);
}

function assertSlot(slot: number, label: string): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > 64) throw new Error(`Invalid Syntakt ${label} slot`);
}

function assertSha(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid Syntakt ${label} SHA-256`);
}

export async function loadExactPcmBackup(original: SyntaktOriginalBackup, slot: number, wavData: Uint8Array): Promise<ExactPcmBackup> {
  if (await sha256Hex(wavData) !== original.wavSha256) throw new Error(`Backup WAV checksum mismatch for Syntakt slot ${slot}`);
  const pcm16le = extractPcm16leWav(wavData.buffer.slice(wavData.byteOffset, wavData.byteOffset + wavData.byteLength));
  if (await sha256Hex(pcm16le) !== original.pcmSha256) throw new Error(`Backup PCM checksum mismatch for Syntakt slot ${slot}`);
  return { slot, name: original.name, pcm16le, wavData };
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure SHA-256 support is required for Syntakt backup recovery');
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(data)));
  return [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
}
