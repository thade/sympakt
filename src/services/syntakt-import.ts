import type { SyntaktDataSampleRead } from '../elektron/syntakt-data-sample.js';
import type { SyntaktSampleSlot } from '../elektron/syntakt-slot-list.js';
import { detectPitchWithDebug, generateWaveformData } from './audio-engine.js';
import { encodePcm16leWav } from './wav-encoder.js';
import type { Sample } from '../types/index.js';
import { MAX_SAMPLE_DURATION, MAX_SLOTS, EXPORT_SAMPLE_RATE } from '../types/index.js';
import type { SyntaktConnection } from './syntakt-transfer.js';

/** A sample read from one global Syntakt sample-library slot. */
export interface ImportedSyntaktSlot {
  slot: number;
  name: string;
  pcm16le: Uint8Array;
}

export interface SyntaktBankImportProgress {
  completedSlots: number;
  totalSlots: number;
  currentSlot: number;
  importedSamples: number;
}

/**
 * Read all 64 global library positions one at a time.
 *
 * No command in this flow changes the Syntakt. Every position is read. A null
 * result is accepted only for the exact OS 1.40 empty-slot sentinel and a
 * matching empty inventory record; an unreadable position remains an error.
 * Closing the session after an interrupted reader is intentional: it ensures
 * a subsequent connection starts from a known state.
 */
export async function downloadSyntaktBank(
  connection: SyntaktConnection,
  inventory: readonly SyntaktSampleSlot[],
  options: { signal?: AbortSignal; onProgress: (progress: SyntaktBankImportProgress) => void },
): Promise<ReadonlyArray<ImportedSyntaktSlot | null>> {
  if (inventory.length !== MAX_SLOTS) throw new Error('Import requires a verified 64-slot Syntakt inventory');
  const bySlot = new Map(inventory.map((entry) => [entry.slot, entry]));
  if (bySlot.size !== MAX_SLOTS || [...bySlot.keys()].some((slot) => slot < 1 || slot > MAX_SLOTS)) {
    throw new Error('Syntakt inventory is malformed');
  }

  const result: Array<ImportedSyntaktSlot | null> = new Array(MAX_SLOTS).fill(null);
  let importedSamples = 0;
  try {
    for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
      if (options.signal?.aborted) throw new DOMException('Syntakt import cancelled', 'AbortError');
      const record = bySlot.get(slot);
      if (!record) throw new Error(`Syntakt inventory is missing slot ${slot}`);
      const sample = await connection.device.downloadSlot(slot, options.signal);
      if (sample.empty) {
        assertMatchingEmptySlot(record, sample);
        options.onProgress({ completedSlots: slot, totalSlots: MAX_SLOTS, currentSlot: slot, importedSamples });
        continue;
      }
      assertMatchingSlot(record, sample);
      result[slot - 1] = { slot, name: sample.name, pcm16le: sample.pcm16le };
      importedSamples += 1;
      options.onProgress({ completedSlots: slot, totalSlots: MAX_SLOTS, currentSlot: slot, importedSamples });
    }
    return result;
  } catch (error) {
    await connection.session.close().catch(() => undefined);
    throw error;
  }
}

/** Convert exact 48 kHz / 16-bit device PCM into a normal Sympakt bank sample. */
export function createSampleFromSyntaktSlot(imported: ImportedSyntaktSlot, enablePitchDetection: boolean): Sample {
  if (!Number.isInteger(imported.slot) || imported.slot < 1 || imported.slot > MAX_SLOTS || !imported.pcm16le.length || imported.pcm16le.length % 2) {
    throw new Error('Invalid Syntakt sample import');
  }
  const frames = imported.pcm16le.length / 2;
  const audioBuffer = new AudioBuffer({ numberOfChannels: 1, length: frames, sampleRate: EXPORT_SAMPLE_RATE });
  const channel = audioBuffer.getChannelData(0);
  const view = new DataView(imported.pcm16le.buffer, imported.pcm16le.byteOffset, imported.pcm16le.byteLength);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = view.getInt16(frame * 2, true);
    channel[frame] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  const name = imported.name.trim() || `Syntakt ${String(imported.slot).padStart(2, '0')}`;
  const pitch = enablePitchDetection ? detectPitchWithDebug(audioBuffer) : { note: null, debug: undefined };
  return {
    id: crypto.randomUUID(),
    name,
    originalFileName: `${String(imported.slot).padStart(2, '0')}_${safeFilenamePart(name)}.wav`,
    audioBuffer,
    waveformData: generateWaveformData(audioBuffer),
    duration: audioBuffer.duration,
    isTruncated: audioBuffer.duration > MAX_SAMPLE_DURATION,
    originalFile: encodePcm16leWav(imported.pcm16le),
    loop: null,
    lofi: 'off',
    detectedNote: pitch.note,
    pitchDebug: pitch.debug,
  };
}

function assertMatchingSlot(record: SyntaktSampleSlot, sample: SyntaktDataSampleRead): void {
  if (sample.empty) throw new Error(`Syntakt sample ${record.slot} unexpectedly resolved as empty`);
  if (sample.slot !== record.slot || sample.pcm16le.length !== sample.frames * 2 || !sample.pcm16le.length) {
    throw new Error(`Syntakt sample ${record.slot} did not match its inventory record`);
  }
}

function assertMatchingEmptySlot(record: SyntaktSampleSlot, sample: SyntaktDataSampleRead): void {
  if (!sample.empty || sample.slot !== record.slot || record.hasData || record.storedBytes !== 0 || record.name !== '') {
    throw new Error(`Syntakt sample ${record.slot} empty-slot response did not match its inventory record`);
  }
}

function safeFilenamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9 _-]/g, '_').trim();
  return sanitized || 'sample';
}
