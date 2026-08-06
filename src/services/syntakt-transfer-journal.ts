import {
  BACKUP_MANIFEST_FILE,
  loadExactPcmBackup,
  makeOriginalBackup,
  makeSyntaktTransferManifest,
  parseSyntaktTransferManifest,
  persistSyntaktTransferManifest,
  transitionTransferEntry,
} from './syntakt-backup.js';
import type { SyntaktManifestFileHandle, SyntaktTransferManifest, SyntaktTransferPhase } from './syntakt-backup.js';
import type { SyntaktRecoveryEntry, SyntaktSlotBackup, SyntaktTransactionIntent, SyntaktTransferJournal } from './syntakt-transfer.js';

/** Minimal File System Access surface used by the durable transfer journal. */
export interface SyntaktBackupDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SyntaktBackupFileHandle>;
}

export interface SyntaktBackupFileHandle extends SyntaktManifestFileHandle {
  getFile(): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
}

/**
 * Copy-on-write transfer journal. A failed write, close, or reopen never
 * changes this object's committed snapshot and consequently never authorizes
 * a device writer.
 */
export class SyntaktTransferJournalCoordinator implements SyntaktTransferJournal {
  private manifest: SyntaktTransferManifest | null = null;
  private readonly backupsBySlot = new Map<number, SyntaktSlotBackup>();
  private entries: readonly SyntaktRecoveryEntry[] = [];

  constructor(private readonly directory: SyntaktBackupDirectoryHandle) {}

  get recoveryEntries(): readonly SyntaktRecoveryEntry[] { return this.entries; }

  async initialize(intents: readonly SyntaktTransactionIntent[]): Promise<void> {
    await this.commit(await makeSyntaktTransferManifest(intents));
  }

  async recordBackup(intent: SyntaktTransactionIntent, backup: SyntaktSlotBackup): Promise<void> {
    const original = await makeOriginalBackup(backup);
    await writeAndRevalidateBackup(this.directory, original.fileName, backup.wavData, original, intent.targetSlot, backup);
    const candidate = this.copyManifest();
    const entry = candidate.entries.find((item) => item.targetSlot === intent.targetSlot);
    if (!entry) throw new Error(`Syntakt transaction is missing backup slot ${backup.slot}`);
    transitionTransferEntry(entry, 'backed-up', original);
    await this.commit(candidate);
    this.backupsBySlot.set(backup.slot, copyBackup(backup));
    this.refreshRecoveryEntries();
  }

  async transition(targetSlot: number, phase: Exclude<SyntaktTransferPhase, 'planned' | 'backed-up'>): Promise<void> {
    const candidate = this.copyManifest();
    const entry = candidate.entries.find((item) => item.targetSlot === targetSlot);
    if (!entry) throw new Error(`Syntakt transaction is missing slot ${targetSlot}`);
    transitionTransferEntry(entry, phase);
    await this.commit(candidate);
  }

  private copyManifest(): SyntaktTransferManifest {
    if (!this.manifest) throw new Error('Syntakt transaction was not initialized before update');
    return parseSyntaktTransferManifest(JSON.parse(JSON.stringify(this.manifest)));
  }

  private async commit(candidate: SyntaktTransferManifest): Promise<void> {
    const file = await this.directory.getFileHandle(BACKUP_MANIFEST_FILE, { create: true });
    const persisted = await persistSyntaktTransferManifest(file, candidate);
    this.manifest = persisted;
    this.refreshRecoveryEntries();
  }

  private refreshRecoveryEntries(): void {
    if (!this.manifest) { this.entries = []; return; }
    this.entries = buildRecoveryEntries(this.manifest, this.backupsBySlot);
  }
}

/** Loads only strict manifests and WAVs whose reopened hash and PCM match. */
export async function loadSyntaktRecoveryEntries(directory: SyntaktBackupDirectoryHandle): Promise<readonly SyntaktRecoveryEntry[]> {
  const manifestFile = await (await directory.getFileHandle(BACKUP_MANIFEST_FILE)).getFile();
  const rawManifest: unknown = JSON.parse(await manifestFile.text());
  if (!rawManifest || typeof rawManifest !== 'object') throw new Error('Invalid saved Syntakt backup run');
  const manifest = parseSyntaktTransferManifest(rawManifest);
  const backups = new Map<number, SyntaktSlotBackup>();
  for (const entry of manifest.entries) {
    if (!entry.original) continue;
    const file = await (await directory.getFileHandle(entry.original.fileName)).getFile();
    const backup = await loadExactPcmBackup(entry.original, entry.targetSlot, new Uint8Array(await file.arrayBuffer()));
    backups.set(entry.targetSlot, backup);
  }
  const entries = buildRecoveryEntries(manifest, backups);
  if (!entries.length) throw new Error('This saved transaction has no durable backups to recover');
  return entries;
}

async function writeAndRevalidateBackup(
  directory: SyntaktBackupDirectoryHandle,
  fileName: string,
  wavData: Uint8Array,
  original: Awaited<ReturnType<typeof makeOriginalBackup>>,
  targetSlot: number,
  expected: SyntaktSlotBackup,
): Promise<void> {
  const file = await directory.getFileHandle(fileName, { create: true });
  const writer = await file.createWritable();
  await writer.write(new Uint8Array(wavData));
  await writer.close();
  const revalidated = await loadExactPcmBackup(original, targetSlot, new Uint8Array(await (await file.getFile()).arrayBuffer()));
  if (revalidated.name !== expected.name || !bytesEqual(revalidated.pcm16le, expected.pcm16le)) {
    throw new Error(`Durable backup revalidation failed for Syntakt slot ${expected.slot}`);
  }
}

function buildRecoveryEntries(manifest: SyntaktTransferManifest, backupsBySlot: ReadonlyMap<number, SyntaktSlotBackup>): readonly SyntaktRecoveryEntry[] {
  const entries: SyntaktRecoveryEntry[] = [];
  for (const entry of manifest.entries) {
    const backup = backupsBySlot.get(entry.targetSlot);
    if (!entry.original || !backup) continue;
    entries.push({ sourceSlot: entry.sourceSlot, targetSlot: entry.targetSlot, phase: entry.phase, backup, intendedName: entry.intendedName, intendedPcmSha256: entry.intendedPcmSha256 });
  }
  return entries;
}

function copyBackup(backup: SyntaktSlotBackup): SyntaktSlotBackup {
  return { slot: backup.slot, name: backup.name, pcm16le: new Uint8Array(backup.pcm16le), wavData: new Uint8Array(backup.wavData) };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
