import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sample } from '../types/index.js';

const persistence = vi.hoisted(() => ({
  saveBank: vi.fn(async () => undefined),
  loadBank: vi.fn<() => Promise<(Sample | null)[] | null>>(async () => null),
  clearAll: vi.fn(async () => undefined),
}));

vi.mock('../services/persistence.js', () => persistence);

import { bankState } from './bank-state.js';

beforeEach(() => {
  vi.useFakeTimers();
  persistence.saveBank.mockClear();
  persistence.loadBank.mockReset();
  persistence.loadBank.mockResolvedValue(null);
  persistence.clearAll.mockClear();
  bankState.loadBank([]);
  bankState.selectSlot(null);
  vi.runOnlyPendingTimers();
  persistence.saveBank.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('bank revision safety contract', () => {
  it('increments for sample and whole-bank replacements but not selection', () => {
    const initial = bankState.revision;

    bankState.selectSlot(4);
    bankState.selectSide('b');
    expect(bankState.revision).toBe(initial);

    bankState.setSample(4, sample('One'));
    expect(bankState.revision).toBe(initial + 1);

    bankState.loadBank([sample('Two')]);
    expect(bankState.revision).toBe(initial + 2);

    bankState.replaceAll([sample('Three')]);
    expect(bankState.revision).toBe(initial + 3);
  });

  it('replaceAll fixes the bank at 64 slots and clears selection', () => {
    bankState.selectSlot(7);
    bankState.selectSide('b');
    const oversized = Array.from({ length: 70 }, (_, index) => sample(String(index)));

    bankState.replaceAll(oversized);

    expect(bankState.getSlots()).toHaveLength(64);
    expect(bankState.getSlot(0)?.name).toBe('0');
    expect(bankState.getSlot(63)?.name).toBe('63');
    expect(bankState.selectedIndex).toBeNull();
    expect(bankState.selectedSide).toBe('a');
  });

  it('increments the revision when IndexedDB restoration replaces the bank', async () => {
    persistence.loadBank.mockResolvedValueOnce([
      sample('Restored'),
      ...new Array<Sample | null>(63).fill(null),
    ]);
    const initial = bankState.revision;

    await expect(bankState.restoreFromDB()).resolves.toBe(true);
    vi.advanceTimersByTime(500);

    expect(bankState.revision).toBe(initial + 1);
    expect(bankState.getSlot(0)?.name).toBe('Restored');
    expect(persistence.saveBank).not.toHaveBeenCalled();
  });
});

function sample(name: string): Sample {
  const channel = new Float32Array([0]);
  return {
    id: name,
    name,
    originalFileName: `${name}.wav`,
    audioBuffer: {
      duration: 1 / 48_000,
      length: 1,
      numberOfChannels: 1,
      sampleRate: 48_000,
      getChannelData: () => channel,
    } as unknown as AudioBuffer,
    waveformData: [0],
    duration: 1 / 48_000,
    isTruncated: false,
    originalFile: new Uint8Array(),
    loop: null,
    lofi: 'off',
    detectedNote: null,
  };
}
