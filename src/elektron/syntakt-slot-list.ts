import { readUint32BE } from './sysex-codec.js';

const LIST_HEADER_BYTES = 18;
export const SYNTAKT_SAMPLE_SLOT_COUNT = 64;

export interface SyntaktSampleSlot {
  slot: number;
  name: string;
  storedBytes: number;
  operations: number;
  hasData: boolean;
  hasMetadata: boolean;
}

/**
 * Parse the OS 1.40 `/samples/` list reply captured from a Syntakt.
 *
 * The returned records describe global sample-library slots. In particular,
 * they must not be interpreted as free-slot or project-usage information.
 */
export function parseSyntaktSampleSlotList(response: Uint8Array): SyntaktSampleSlot[] {
  if (response.length < LIST_HEADER_BYTES || response[5] !== 1) throw new Error('Invalid Syntakt sample-slot list response');
  // OS 1.40 response header: seven reserved zero bytes followed by the
  // captured global-data-sample listing marker (0x41), then the record count.
  if (response.slice(6, 13).some((value) => value !== 0) || response[13] !== 0x41) {
    const observed = [...response.slice(0, 24)].map((value) => value.toString(16).padStart(2, '0')).join(' ');
    throw new Error(`Unexpected Syntakt sample-slot list header (${response.length} bytes: ${observed})`);
  }
  const declaredEntries = readUint32BE(response, 14);
  if (declaredEntries > SYNTAKT_SAMPLE_SLOT_COUNT) throw new Error('Syntakt sample-slot list exceeds the known slot count');

  const slots: SyntaktSampleSlot[] = [];
  const decoder = new TextDecoder('windows-1252', { fatal: true });
  let offset = LIST_HEADER_BYTES;
  while (offset < response.length) {
    const nameEnd = response.indexOf(0, offset);
    if (nameEnd < offset || nameEnd - offset > 16) throw new Error('Malformed Syntakt sample-slot name');
    const recordOffset = nameEnd + 1;
    const recordEnd = recordOffset + 14;
    if (recordEnd > response.length) throw new Error('Truncated Syntakt sample-slot record');

    const name = decoder.decode(response.slice(offset, nameEnd));
    const hasChildren = response[recordOffset];
    const type = response[recordOffset + 1];
    const slot = readUint32BE(response, recordOffset + 2);
    const storedBytes = readUint32BE(response, recordOffset + 6);
    const operations = (response[recordOffset + 10] << 8) | response[recordOffset + 11];
    const hasData = response[recordOffset + 12];
    const hasMetadata = response[recordOffset + 13];
    const isCapturedEmptyRecord = name === ''
      && hasChildren === 0
      && type === 2
      && storedBytes === 0
      && operations === 0
      && hasData === 0
      && hasMetadata === 0;
    if ((!name && !isCapturedEmptyRecord) || hasChildren !== 0 || type !== 2 || slot < 1 || slot > SYNTAKT_SAMPLE_SLOT_COUNT || hasData > 1 || hasMetadata > 1) {
      throw new Error('Unexpected Syntakt sample-slot record');
    }
    if (slots.some((entry) => entry.slot === slot)) throw new Error('Duplicate Syntakt sample-slot record');
    slots.push({ slot, name, storedBytes, operations, hasData: hasData === 1, hasMetadata: hasMetadata === 1 });
    offset = recordEnd;
  }
  if (slots.length !== declaredEntries) throw new Error('Syntakt sample-slot list count did not match its records');
  return slots;
}
