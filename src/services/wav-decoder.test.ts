import { describe, expect, it } from 'vitest';
import { extractPcm16leWav, parseWavHeader } from './wav-decoder.js';
import { encodePcm16leWav } from './wav-encoder.js';

describe('Sympakt backup WAV decoding', () => {
  it('extracts exact 16-bit mono PCM from the backup WAV container', () => {
    const pcm = Uint8Array.of(0x34, 0x12, 0xdc, 0xfe);
    const wav = encodePcm16leWav(pcm);
    expect(extractPcm16leWav(wav.buffer)).toEqual(pcm);
  });

  it('rejects truncated or unsupported backup containers', () => {
    expect(parseWavHeader(new ArrayBuffer(8))).toBeNull();
    expect(() => extractPcm16leWav(new ArrayBuffer(8))).toThrow('Backup WAV');
    const stereo = encodePcm16leWav(Uint8Array.of(0, 0));
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => extractPcm16leWav(stereo.buffer)).toThrow('Backup WAV');
  });
});
