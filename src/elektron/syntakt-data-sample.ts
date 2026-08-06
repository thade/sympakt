import { readUint32BE } from './sysex-codec.js';

const DATA_HEADER_BYTES = 31;
const SLOT_HEADER_BYTES = 64;
const FOOTER_BYTES = 12;
const DATA_MAGIC = 0xac11d303;
const SLOT_MAGIC = 0x53414d50; // SAMP
const FOOTER_MAGIC = 0xaaa1daaa;
const MAX_NAME_BYTES = 16;

// Exact 43-byte reader payload captured after clearing real OS 1.40 slot 1.
// Only bytes 21–24 (the global slot number) vary between cleared positions.
const EMPTY_SLOT_TEMPLATE = Uint8Array.of(
  0xac, 0x11, 0xd3, 0x03, 0x02, 0x00, 0x08, 0x00,
  0x0d, 0x30, 0x30, 0x38, 0x32, 0x00, 0x00, 0x00,
  0x08, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0xff,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
);

export const SYNTAKT_MAX_SAMPLE_FRAMES = 48_000 * 5;

export interface SyntaktDataSample {
  slot: number;
  name: string;
  frames: number;
  pcm16le: Uint8Array;
  footerHash: number;
  empty?: false;
}

/** A confirmed OS 1.40 cleared global sample-library position. */
export interface SyntaktEmptyDataSample {
  slot: number;
  empty: true;
  footerHash: number;
}

export type SyntaktDataSampleRead = SyntaktDataSample | SyntaktEmptyDataSample;

export interface SyntaktDataSampleUpload {
  /** Header, slot metadata, and big-endian PCM. */
  content: Uint8Array;
  /** Must be written as a separate final block on OS 1.40. */
  footer: Uint8Array;
}

/** Parse a captured Syntakt OS 1.40 data-sample container into host PCM. */
export function parseSyntaktDataSample(raw: Uint8Array): SyntaktDataSampleRead {
  if (raw.length < DATA_HEADER_BYTES + FOOTER_BYTES) throw new Error('Syntakt data sample is too short');
  if (readUint32BE(raw, 0) !== DATA_MAGIC) throw new Error('Invalid Syntakt data-sample header');
  if (raw[29] !== 0) throw new Error('Compressed Syntakt data samples are not supported');

  const payloadBytes = readUint32BE(raw, 25);
  const footerBytes = raw[30];
  if (footerBytes !== FOOTER_BYTES || raw.length !== DATA_HEADER_BYTES + payloadBytes + footerBytes) throw new Error('Invalid Syntakt data-sample length');

  const slot = readUint32BE(raw, 21);
  if (!Number.isInteger(slot) || slot < 1 || slot > 64) throw new Error('Invalid Syntakt sample slot number');
  const footerOffset = raw.length - footerBytes;
  const footerHash = readUint32BE(raw, footerOffset);
  const footerSize = readUint32BE(raw, footerOffset + 4);
  const footerMagic = readUint32BE(raw, footerOffset + 8);

  // A real OS 1.40 clear of a data-sample slot produces a 31-byte data header
  // followed directly by this exact 12-byte sentinel. It has no SAMP header
  // and no PCM, so it must be distinguished before normal container parsing.
  if (payloadBytes === 0) {
    if (!isCapturedEmptySlot(raw) || footerHash !== 0xffffffff || footerSize !== 0 || footerMagic !== 0) {
      throw new Error('Invalid empty Syntakt data-sample sentinel');
    }
    return { slot, empty: true, footerHash };
  }

  if (raw.length < DATA_HEADER_BYTES + SLOT_HEADER_BYTES + FOOTER_BYTES) throw new Error('Syntakt data sample is too short');

  const slotHeaderOffset = DATA_HEADER_BYTES;
  if (readUint32BE(raw, slotHeaderOffset) !== SLOT_MAGIC) throw new Error('Invalid Syntakt sample-slot header');
  const frames = readUint32BE(raw, slotHeaderOffset + 8);
  const name = new TextDecoder('windows-1252').decode(raw.slice(slotHeaderOffset + 12, slotHeaderOffset + 28)).replace(/\0.*$/, '');
  const pcmStart = slotHeaderOffset + SLOT_HEADER_BYTES;
  const pcmBigEndian = raw.slice(pcmStart, footerOffset);
  if (pcmBigEndian.length !== frames * 2 || pcmBigEndian.length % 2) throw new Error('Invalid Syntakt sample PCM length');
  const calculatedHash = syntaktCrc32(raw.slice(slotHeaderOffset, footerOffset));
  // Elektroid's captured writer uses the literal 12-byte footer length. The
  // same stored sample, when read back from OS 1.40, reports payloadBytes in
  // this field instead. Both forms have the same CRC and footer magic.
  if ((footerSize !== FOOTER_BYTES && footerSize !== payloadBytes) || footerMagic !== FOOTER_MAGIC || footerHash !== calculatedHash) {
    throw new Error(`Invalid Syntakt data-sample footer (stored=${footerHash.toString(16)}, calculated=${calculatedHash.toString(16)}, size=${footerSize}, magic=${footerMagic.toString(16)})`);
  }

  const pcm16le = new Uint8Array(pcmBigEndian.length);
  for (let offset = 0; offset < pcmBigEndian.length; offset += 2) {
    pcm16le[offset] = pcmBigEndian[offset + 1];
    pcm16le[offset + 1] = pcmBigEndian[offset];
  }
  return { slot, name, frames, pcm16le, footerHash };
}

function isCapturedEmptySlot(raw: Uint8Array): boolean {
  if (raw.length !== EMPTY_SLOT_TEMPLATE.length) return false;
  for (let offset = 0; offset < raw.length; offset += 1) {
    if (offset >= 21 && offset <= 24) continue;
    if (raw[offset] !== EMPTY_SLOT_TEMPLATE[offset]) return false;
  }
  return true;
}

/**
 * CRC-32 with Elektron's captured initial state. The expected value for
 * `123456789` is 0xd202d277, which distinguishes it from the usual CRC-32
 * initial state used by ZIP files.
 */
export function syntaktCrc32(data: Uint8Array): number {
  let crc = 0;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build the two captured OS 1.40 writer parts from canonical 16-bit LE PCM. */
export function buildSyntaktDataSample(slot: number, name: string, pcm16le: Uint8Array): SyntaktDataSampleUpload {
  if (!Number.isInteger(slot) || slot < 1 || slot > 64) throw new Error('Syntakt sample slots must be between 1 and 64');
  if (!pcm16le.length || pcm16le.length % 2) throw new Error('Syntakt sample PCM must be non-empty 16-bit mono data');
  const frames = pcm16le.length / 2;
  if (frames > SYNTAKT_MAX_SAMPLE_FRAMES) throw new Error('Syntakt samples cannot exceed five seconds');
  const nameBytes = new TextEncoder().encode(name);
  if (!name || nameBytes.length > MAX_NAME_BYTES || [...nameBytes].some((value) => value > 0x7f)) throw new Error('Syntakt sample names must be 1–16 ASCII bytes');

  const payloadBytes = SLOT_HEADER_BYTES + pcm16le.length;
  const content = new Uint8Array(DATA_HEADER_BYTES + payloadBytes);
  const view = new DataView(content.buffer);
  view.setUint32(0, DATA_MAGIC, false);
  content[4] = 2;
  view.setUint16(5, 8, false);
  view.setUint16(7, 13, false);
  view.setUint32(9, 0x30303832, false);
  view.setUint32(13, 8, false);
  view.setInt32(17, -1, false);
  view.setInt32(21, slot, false);
  view.setUint32(25, payloadBytes, false);
  content[29] = 0;
  content[30] = FOOTER_BYTES;
  view.setUint32(DATA_HEADER_BYTES, SLOT_MAGIC, false);
  view.setUint32(DATA_HEADER_BYTES + 8, frames, false);
  content.set(nameBytes, DATA_HEADER_BYTES + 12);
  for (let offset = 0; offset < pcm16le.length; offset += 2) {
    content[DATA_HEADER_BYTES + SLOT_HEADER_BYTES + offset] = pcm16le[offset + 1];
    content[DATA_HEADER_BYTES + SLOT_HEADER_BYTES + offset + 1] = pcm16le[offset];
  }

  const footer = new Uint8Array(FOOTER_BYTES);
  const footerView = new DataView(footer.buffer);
  footerView.setUint32(0, syntaktCrc32(content.slice(DATA_HEADER_BYTES)), false);
  footerView.setUint32(4, FOOTER_BYTES, false);
  footerView.setUint32(8, FOOTER_MAGIC, false);
  return { content, footer };
}
