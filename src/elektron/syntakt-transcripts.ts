export interface SyntaktTranscriptFrame {
  direction: 'in' | 'out';
  payload: Uint8Array;
}

function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('Invalid transcript hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/**
 * Sanitized decoded payloads captured from a physical Syntakt on OS 1.40.
 * The device-unique UID query has intentionally been omitted.
 */
export const SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT: readonly SyntaktTranscriptFrame[] = [
  { direction: 'out', payload: fromHex('0000000001') },
  { direction: 'in', payload: fromHex('00100000811e1601020304060709505251535455565758595a5b5c5d5e53796e74616b7400') },
  { direction: 'out', payload: fromHex('0001000002') },
  { direction: 'in', payload: fromHex('00110001823030383200312e343000') },
];

/**
 * Sanitized facts from a read-only OS 1.40 download of global sample-library
 * slot 1. Audio and device-unique job/hash values are intentionally omitted.
 */
export const SYNTAKT_OS_1_40_SLOT_1_READER_CAPTURE = {
  slot: 1,
  openCommand: 0x54,
  readCommand: 0x55,
  closeCommand: 0x56,
  initialEmptyRead: true,
  fullBlockBytes: 8_192,
  fullBlockCount: 9,
  finalBlockBytes: 3_923,
  rawDataBytes: 77_651,
  wavPcmBytes: 77_544,
  wavBytes: 77_716,
  dataHeaderBytes: 31,
  slotHeaderBytes: 64,
  footerBytes: 12,
  pcmByteOrder: 'big-endian',
  wavSha256: '328ad6612966769a13941d7de969499a49ce203463f1b2ffbbf82fec7c128de1',
} as const;

/**
 * Facts from an explicitly authorized slot-1 test-tone write, followed by an
 * exact readback and restoration of its fresh backup. No sample audio is kept
 * in the repository.
 */
export const SYNTAKT_OS_1_40_SLOT_1_WRITER_CAPTURE = {
  slot: 1,
  openCommand: 0x57,
  writeCommand: 0x58,
  closeCommand: 0x59,
  blockBytes: 8_192,
  contentBytes: 24_095,
  footerBytes: 12,
  contentBlockBytes: [8_192, 8_192, 7_711],
  totalBytes: 24_107,
  testPcmBytes: 24_000,
  verifiedPcmMatch: true,
  restoredWavSha256: '328ad6612966769a13941d7de969499a49ce203463f1b2ffbbf82fec7c128de1',
} as const;
