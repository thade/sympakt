import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { exportSamplePack, importSamplePack, normalizePCM, prepareSampleExports } from './zip-service.js';
import { BACKUP_MANIFEST_FILE, backupFromPcm, createVerifiedSyntaktBackup } from './syntakt-backup.js';
import type { Sample, SplitSample } from '../types/index.js';

const originalOfflineAudioContext = globalThis.OfflineAudioContext;

beforeEach(() => {
  globalThis.OfflineAudioContext = FakeOfflineAudioContext as unknown as typeof OfflineAudioContext;
});

afterEach(() => {
  if (originalOfflineAudioContext) globalThis.OfflineAudioContext = originalOfflineAudioContext;
  else delete (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
});

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

  it('leaves ordinary ZIPs with non-UTF-8 filenames on the normal import path', async () => {
    const archive = zipSync({ 'a.txt': strToU8('ordinary pack') });
    const central = centralHeaderFor(archive, 'a.txt');
    expect(central).toBeDefined();
    if (central === undefined) throw new Error('Expected ordinary ZIP central header');
    archive[30] = 0x82;
    archive[central + 46] = 0x82;

    const result = await importSamplePack(asFile(archive));

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

describe('sample export normalization', () => {
  it('normalizes finite samples when the buffer also contains NaN', () => {
    const pcm = new Float32Array([0.5, Number.NaN, -0.25]);

    normalizePCM(pcm);

    expect(pcm[0]).toBe(1);
    expect(pcm[1]).toBeNaN();
    expect(pcm[2]).toBe(-0.5);
  });
});

describe('shared sample rendering', () => {
  it('renders a normal sample to fixed PCM bytes', async () => {
    const [rendered] = await prepareSampleExports(
      [sample('Kick', [0.25, -0.5, 0.75])],
      false,
    );

    expect(rendered.filename).toBe('01_Kick.wav');
    expect(rendered.pcm16le).toEqual(Uint8Array.of(
      0xff, 0x1f,
      0x00, 0xc0,
      0xff, 0x5f,
    ));
  });

  it('renders only the selected loop region to fixed PCM bytes', async () => {
    const looped = sample('Loop', [0.1, 0.2, 0.3, 0.4]);
    looped.loop = {
      startTime: 1 / 48_000,
      endTime: 3 / 48_000,
      crossfadeDuration: 0,
    };

    const [rendered] = await prepareSampleExports([looped], false);

    expect(rendered.filename).toBe('01_Loop.wav');
    expect(rendered.pcm16le).toEqual(Uint8Array.of(
      0x99, 0x19,
      0x66, 0x26,
    ));
  });

  it('renders fixed dual-sample placement and reversal', async () => {
    const dual = sample('A', [0.2, 0.4]);
    dual.splitEnabled = true;
    dual.splitSample = splitSample('B', [-0.3, -0.6]);

    const [rendered] = await prepareSampleExports([dual], false);
    const expected = new Uint8Array(48_000 * 5 * 2);
    expected.set([0x99, 0x19, 0x32, 0x33]);
    expected.set([0x34, 0xb3, 0x9a, 0xd9], expected.length - 4);

    expect(rendered.filename).toBe('01_A-B_DUAL.wav');
    expect(rendered.pcm16le).toEqual(expected);
  });

  it('uses the same filenames and WAV bytes for prepared and ZIP exports', async () => {
    const normal = sample('Kick', [0.25, -0.5, 0.75]);
    const looped = sample('Loop', [0.1, 0.2, 0.3, 0.4]);
    looped.loop = { startTime: 1 / 48_000, endTime: 3 / 48_000, crossfadeDuration: 0 };
    const dual = sample('A', [0.2, 0.4]);
    dual.splitEnabled = true;
    dual.splitSample = splitSample('B', [-0.3, -0.6]);
    const slots = [normal, looped, dual];

    const prepared = await prepareSampleExports(slots, false);
    const archive = await exportSamplePack(slots, {
      packName: 'Parity',
      includeOriginals: false,
      normalizeOnExport: false,
    });
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));

    expect(prepared.map(({ filename }) => filename)).toEqual([
      '01_Kick.wav',
      '02_Loop.wav',
      '03_A-B_DUAL.wav',
    ]);
    for (const item of prepared) expect(files[item.filename]).toEqual(item.wavData);
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

function audioBuffer(values: readonly number[]): AudioBuffer {
  const channel = new Float32Array(values);
  return {
    duration: channel.length / 48_000,
    length: channel.length,
    numberOfChannels: 1,
    sampleRate: 48_000,
    getChannelData: () => channel,
  } as unknown as AudioBuffer;
}

function sample(name: string, values: readonly number[]): Sample {
  const buffer = audioBuffer(values);
  return {
    id: name,
    name,
    originalFileName: `${name}.wav`,
    audioBuffer: buffer,
    waveformData: [],
    duration: buffer.duration,
    isTruncated: false,
    originalFile: new Uint8Array(),
    loop: null,
    lofi: 'off',
    detectedNote: null,
  };
}

function splitSample(name: string, values: readonly number[]): SplitSample {
  const buffer = audioBuffer(values);
  return {
    name,
    originalFileName: `${name}.wav`,
    audioBuffer: buffer,
    waveformData: [],
    duration: buffer.duration,
    isTruncated: false,
    originalFile: new Uint8Array(),
    loop: null,
    detectedNote: null,
  };
}

class FakeOfflineAudioContext {
  readonly destination = {};
  private source?: { buffer: AudioBuffer | null };

  createBufferSource() {
    const source = {
      buffer: null as AudioBuffer | null,
      playbackRate: { value: 1 },
      connect: () => undefined,
      start: () => undefined,
    };
    this.source = source;
    return source;
  }

  async startRendering(): Promise<AudioBuffer> {
    if (!this.source?.buffer) throw new Error('Expected an export source buffer');
    return this.source.buffer;
  }
}
