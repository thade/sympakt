import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSampleFromSyntaktSlot, downloadSyntaktBank } from './syntakt-import.js';
import type { SyntaktConnection } from './syntakt-transfer.js';
import type { SyntaktSampleSlot } from '../elektron/syntakt-slot-list.js';

class TestAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels;
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.duration = options.length / options.sampleRate;
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
  }

  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
}

function sinePcm16le(frequency: number, frames = 48_000): Uint8Array {
  const pcm = new Uint8Array(frames * 2);
  const view = new DataView(pcm.buffer);
  for (let frame = 0; frame < frames; frame += 1) view.setInt16(frame * 2, Math.round(Math.sin(2 * Math.PI * frequency * frame / 48_000) * 0x6000), true);
  return pcm;
}

afterEach(() => vi.unstubAllGlobals());

function inventory(): SyntaktSampleSlot[] {
  return Array.from({ length: 64 }, (_, index) => ({
    slot: index + 1,
    name: index === 1 ? '' : `S${index + 1}`,
    storedBytes: index === 1 ? 0 : 2,
    operations: 0,
    hasData: index !== 1,
    hasMetadata: false,
  }));
}

describe('Syntakt bank import', () => {
  it('uses the required pitch-detection setting when converting imported PCM', () => {
    vi.stubGlobal('AudioBuffer', TestAudioBuffer);
    const imported = { slot: 1, name: 'Tone', pcm16le: sinePcm16le(440) };
    const disabled = createSampleFromSyntaktSlot(imported, false);
    expect(disabled.detectedNote).toBeNull();
    expect(disabled.pitchDebug).toBeUndefined();

    const enabled = createSampleFromSyntaktSlot(imported, true);
    expect(enabled.detectedNote).not.toBeNull();
    expect(enabled.pitchDebug?.detectedNote).toBe(enabled.detectedNote);
  });

  it('reads every one of the 64 positions in order without trusting metadata flags', async () => {
    const downloaded: number[] = [];
    const connection = {
      device: {
        downloadSlot: async (slot: number) => {
          downloaded.push(slot);
          return { slot, name: `S${slot}`, frames: 1, pcm16le: Uint8Array.of(slot, 0), footerHash: 0 };
        },
      },
      session: { close: vi.fn(async () => undefined) },
    } as unknown as SyntaktConnection;
    const progress: number[] = [];

    const result = await downloadSyntaktBank(connection, inventory(), {
      onProgress: (state) => progress.push(state.completedSlots),
    });

    expect(downloaded).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
    expect(result).toHaveLength(64);
    expect(result[1]).toMatchObject({ slot: 2, name: 'S2' });
    expect(result[0]).toMatchObject({ slot: 1, name: 'S1' });
    expect(progress).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
    expect(connection.session.close).not.toHaveBeenCalled();
  });

  it('closes the read session if cancelled before a later slot', async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    const connection = {
      device: {
        downloadSlot: async (slot: number) => {
          if (slot === 1) controller.abort();
          return { slot, name: `S${slot}`, frames: 1, pcm16le: Uint8Array.of(slot, 0), footerHash: 0 };
        },
      },
      session: { close },
    } as unknown as SyntaktConnection;

    await expect(downloadSyntaktBank(connection, inventory(), { signal: controller.signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('imports only the captured empty-slot sentinel as an empty local slot', async () => {
    const downloaded: number[] = [];
    const connection = {
      device: {
        downloadSlot: async (slot: number) => {
          downloaded.push(slot);
          if (slot === 2) return { slot, empty: true as const, footerHash: 0xffffffff };
          return { slot, name: `S${slot}`, frames: 1, pcm16le: Uint8Array.of(slot, 0), footerHash: 0 };
        },
      },
      session: { close: vi.fn(async () => undefined) },
    } as unknown as SyntaktConnection;

    const progress: number[] = [];
    const result = await downloadSyntaktBank(connection, inventory(), {
      onProgress: (state) => progress.push(state.completedSlots),
    });

    expect(downloaded).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
    expect(result[1]).toBeNull();
    expect(progress).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
    expect(connection.session.close).not.toHaveBeenCalled();
  });

  it('fails closed rather than treating an unreadable position as empty', async () => {
    const close = vi.fn(async () => undefined);
    const connection = {
      device: {
        downloadSlot: async (slot: number) => {
          if (slot === 2) throw new Error('Syntakt refused reader for sample slot 2');
          return { slot, name: `S${slot}`, frames: 1, pcm16le: Uint8Array.of(slot, 0), footerHash: 0 };
        },
      },
      session: { close },
    } as unknown as SyntaktConnection;

    await expect(downloadSyntaktBank(connection, inventory(), { onProgress: () => undefined }))
      .rejects.toThrow('refused reader');
    expect(close).toHaveBeenCalledOnce();
  });
});
