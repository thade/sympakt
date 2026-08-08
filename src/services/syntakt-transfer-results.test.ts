import { describe, expect, it } from 'vitest';
import { classifySyntaktTransferResults } from './syntakt-transfer-results.js';

describe('Syntakt transfer result classification', () => {
  it('treats verified and optional-unverified completed writes as success', () => {
    expect(classifySyntaktTransferResults([{ sourceSlot: 1, targetSlot: 1, filename: 'a.wav', state: 'verified' }])).toEqual({ successful: true, verified: true });
    expect(classifySyntaktTransferResults([{ sourceSlot: 1, targetSlot: 1, filename: 'a.wav', state: 'written' }])).toEqual({ successful: true, verified: false });
    expect(classifySyntaktTransferResults([{ sourceSlot: 1, targetSlot: 1, filename: 'a.wav', state: 'verified' }, { sourceSlot: 2, targetSlot: 2, filename: 'b.wav', state: 'written' }])).toEqual({ successful: true, verified: false });
  });

  it('does not classify partial or failed output as success', () => {
    for (const state of ['pending', 'backed_up', 'write_started', 'unknown'] as const) {
      expect(classifySyntaktTransferResults([{ sourceSlot: 1, targetSlot: 1, filename: 'a.wav', state }]).successful).toBe(false);
    }
  });
});
