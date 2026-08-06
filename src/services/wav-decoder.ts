/**
 * Basic WAV header parser. Returns sample rate, bit depth, channels, and PCM data offset.
 * Used for informational purposes; actual decoding uses Web Audio API.
 */
export interface WavInfo {
  audioFormat: number;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  dataOffset: number;
  dataSize: number;
}

export function parseWavHeader(buffer: ArrayBufferLike): WavInfo | null {
  if (buffer.byteLength < 12) return null;
  const view = new DataView(buffer);

  // Check RIFF header
  if (readString(view, 0, 4) !== 'RIFF') return null;
  if (readString(view, 8, 4) !== 'WAVE') return null;

  let offset = 12;
  let fmtFound = false;
  let sampleRate = 0;
  let bitDepth = 0;
  let channels = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readString(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > buffer.byteLength) return null;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) return null;
      const audioFormat = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitDepth = view.getUint16(chunkDataOffset + 14, true);
      if (audioFormat !== 1) return null;
      fmtFound = true;
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
    // Chunks are padded to even byte boundaries
    if (chunkSize % 2 !== 0) offset++;
  }

  if (!fmtFound || dataOffset === 0) return null;

  return { audioFormat: 1, sampleRate, bitDepth, channels, dataOffset, dataSize };
}

/** Extract exact 16-bit / 48 kHz / mono PCM from a Sympakt backup WAV. */
export function extractPcm16leWav(buffer: ArrayBufferLike): Uint8Array {
  const info = parseWavHeader(buffer);
  if (!info || info.audioFormat !== 1 || info.sampleRate !== 48_000 || info.channels !== 1 || info.bitDepth !== 16 || !info.dataSize || info.dataSize % 2) {
    throw new Error('Backup WAV must be 16-bit, 48 kHz, mono PCM');
  }
  return new Uint8Array(buffer.slice(info.dataOffset, info.dataOffset + info.dataSize));
}

function readString(view: DataView, offset: number, length: number): string {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}
