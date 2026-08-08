import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exportSamplePack, importSamplePack, normalizePCM, prepareSampleExports } from './zip-service.js';
import { BACKUP_MANIFEST_FILE, backupFromPcm, createVerifiedSyntaktBackup } from './syntakt-backup.js';
import { METADATA_FILENAME } from '../types/index.js';
import type { Sample, SplitSample } from '../types/index.js';
import { encodePcm16leWav } from './wav-encoder.js';

const originalOfflineAudioContext = globalThis.OfflineAudioContext;
const originalAudioContext = globalThis.AudioContext;

beforeEach(() => {
  globalThis.OfflineAudioContext = FakeOfflineAudioContext as unknown as typeof OfflineAudioContext;
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
});

afterEach(() => {
  if (originalOfflineAudioContext) globalThis.OfflineAudioContext = originalOfflineAudioContext;
  else delete (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (originalAudioContext) globalThis.AudioContext = originalAudioContext;
  else delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
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

  it('imports a valid ordinary WAV into its numbered slot', async () => {
    const pcm16le = Uint8Array.of(0x00, 0x40, 0x00, 0xc0);
    const archive = zipSync({ '07_Kick.wav': encodePcm16leWav(pcm16le) });

    const result = await importSamplePack(asFile(archive));

    expect(result.syntaktBackup).toBeUndefined();
    expect(result.slots.filter(Boolean)).toHaveLength(1);
    expect(result.slots[6]).toMatchObject({
      name: 'Kick',
      originalFileName: '07_Kick.wav',
      duration: 2 / 48_000,
      lofi: 'off',
    });
    expect(result.slots[6]?.audioBuffer.getChannelData(0)).toEqual(new Float32Array([0.5, -0.5]));
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

  it('normalizes prepared output only when requested', async () => {
    const source = sample('Level', [0.25, -0.5]);

    const [plain] = await prepareSampleExports([source], false);
    const [normalized] = await prepareSampleExports([source], true);

    expect(plain.pcm16le).toEqual(Uint8Array.of(0xff, 0x1f, 0x00, 0xc0));
    expect(normalized.pcm16le).toEqual(Uint8Array.of(0xff, 0x3f, 0x00, 0x80));
  });

  it('truncates ordinary samples to exactly five seconds', async () => {
    const values = new Float32Array(48_000 * 5 + 2);
    values[0] = 0.25;
    values[48_000 * 5 - 1] = -0.5;
    values[48_000 * 5] = 0.75;
    values[48_000 * 5 + 1] = -0.75;
    const overlong = sample('Long', values);

    const [rendered] = await prepareSampleExports([overlong], false);

    expect(rendered.pcm16le).toHaveLength(48_000 * 5 * 2);
    expect(rendered.pcm16le.slice(0, 2)).toEqual(Uint8Array.of(0xff, 0x1f));
    expect(rendered.pcm16le.slice(-2)).toEqual(Uint8Array.of(0x00, 0xc0));
  });

  it.each([
    ['off', 1],
    ['lofi', 2],
    ['xlofi', 4],
    ['sxlofi', 8],
    ['gxlofi', 16],
  ] as const)('renders %s at its fixed speed factor', async (mode, factor) => {
    const values = Array.from({ length: 32 }, (_, index) => index / 64);
    const source = sample('Speed', values);
    source.lofi = mode;

    const [rendered] = await prepareSampleExports([source], false);

    expect(rendered.pcm16le).toHaveLength((32 / factor) * 2);
    expect(readPcm16le(rendered.pcm16le)).toEqual(
      values.filter((_, index) => index % factor === 0).map(floatToPcm16),
    );
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

  it('scales loop points into the LOFI export domain', async () => {
    const values = new Array(16).fill(0);
    values[4] = 0.25;
    values[8] = -0.5;
    const looped = sample('Fast Loop', values);
    looped.lofi = 'xlofi';
    looped.loop = {
      startTime: 4 / 48_000,
      endTime: 12 / 48_000,
      crossfadeDuration: 0,
    };

    const [rendered] = await prepareSampleExports([looped], false);

    expect(rendered.pcm16le).toEqual(Uint8Array.of(0xff, 0x1f, 0x00, 0xc0));
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

  it('skips an entirely empty dual slot and preserves an empty A side when B exists', async () => {
    const empty = sample('Unused', [0]);
    empty.splitEnabled = true;
    empty.aEmpty = true;
    empty.splitSample = null;

    const withB = sample('Ignored A', [0.75, -0.75]);
    withB.splitEnabled = true;
    withB.aEmpty = true;
    withB.splitSample = splitSample('B', [0.25, -0.5]);

    const prepared = await prepareSampleExports([empty, withB], false);

    expect(prepared).toHaveLength(1);
    expect(prepared[0].filename).toBe('02_empty-B_DUAL.wav');
    expect(prepared[0].pcm16le.slice(0, -4).every((byte) => byte === 0)).toBe(true);
    expect(prepared[0].pcm16le.slice(-4)).toEqual(Uint8Array.of(0x00, 0xc0, 0xff, 0x1f));
  });

  it('uses sanitized names and detected notes in fixed filenames', async () => {
    const named = sample('K!ck/One', [0.25]);
    named.detectedNote = 'C3';

    const [rendered] = await prepareSampleExports([named], false);

    expect(rendered.filename).toBe('01_K_ck_One_C3.wav');
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

  it('writes explicit metadata and original bytes when originals are included', async () => {
    const source = sample('Kick', [0.25, -0.5]);
    source.originalFileName = 'source.wav';
    source.originalFile = Uint8Array.of(7, 8, 9);
    source.lofi = 'lofi';
    source.detectedNote = 'C3';

    const archive = await exportSamplePack([source], {
      packName: 'Golden Pack',
      includeOriginals: true,
      normalizeOnExport: false,
    });
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    const metadata = JSON.parse(strFromU8(files[METADATA_FILENAME])) as {
      name: string;
      includeOriginals: boolean;
      slots: Array<Record<string, unknown>>;
    };

    expect(files['originals/source.wav']).toEqual(Uint8Array.of(7, 8, 9));
    expect(metadata).toMatchObject({
      name: 'Golden Pack',
      includeOriginals: true,
      slots: [{
        slot: 1,
        name: 'Kick',
        originalFileName: 'source.wav',
        originalFilePath: 'originals/source.wav',
        lofi: 'lofi',
        detectedNote: 'C3',
      }],
    });
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

function audioBuffer(values: ArrayLike<number>): AudioBuffer {
  const channel = new Float32Array(values);
  return {
    duration: channel.length / 48_000,
    length: channel.length,
    numberOfChannels: 1,
    sampleRate: 48_000,
    getChannelData: () => channel,
  } as unknown as AudioBuffer;
}

function sample(name: string, values: ArrayLike<number>): Sample {
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

function splitSample(name: string, values: ArrayLike<number>): SplitSample {
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

function floatToPcm16(value: number): number {
  return Math.trunc(Math.max(-1, Math.min(1, value)) * (value < 0 ? 0x8000 : 0x7fff));
}

function readPcm16le(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: data.length / 2 }, (_, index) => view.getInt16(index * 2, true));
}

class FakeOfflineAudioContext {
  readonly destination = {};
  private source?: { buffer: AudioBuffer | null; playbackRate: { value: number } };

  constructor(
    _numberOfChannels: number,
    private readonly outputLength: number,
    private readonly sampleRate: number,
  ) {}

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
    const input = this.source.buffer.getChannelData(0);
    const output = new Float32Array(this.outputLength);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = input[Math.min(input.length - 1, Math.floor(index * this.source.playbackRate.value))] ?? 0;
    }
    return {
      duration: output.length / this.sampleRate,
      length: output.length,
      numberOfChannels: 1,
      sampleRate: this.sampleRate,
      getChannelData: () => output,
    } as unknown as AudioBuffer;
  }
}

class FakeAudioContext {
  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    const view = new DataView(data);
    const frames = view.getUint32(40, true) / 2;
    const channel = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      channel[frame] = view.getInt16(44 + frame * 2, true) / 0x8000;
    }
    return {
      duration: frames / 48_000,
      length: frames,
      numberOfChannels: 1,
      sampleRate: 48_000,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;
  }
}
