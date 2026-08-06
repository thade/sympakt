import { describe, expect, it } from 'vitest';
import { parseSyntaktSampleSlotList } from './syntakt-slot-list.js';

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function listFixture(): Uint8Array {
  const name = new TextEncoder().encode('TEST');
  const response = new Uint8Array(18 + name.length + 1 + 14);
  response[5] = 1;
  response[13] = 0x41;
  writeUint32BE(response, 14, 1);
  response.set(name, 18);
  const record = 18 + name.length + 1;
  response[record + 1] = 2;
  writeUint32BE(response, record + 2, 7);
  writeUint32BE(response, record + 6, 4096);
  response[record + 10] = 0;
  response[record + 11] = 0x7e;
  response[record + 12] = 1;
  return response;
}

/** Exact blank record shape captured from cleared hardware slot 1. */
function capturedEmptySlotFixture(): Uint8Array {
  const response = new Uint8Array(18 + 15);
  response[5] = 1;
  response[13] = 0x41;
  writeUint32BE(response, 14, 1);
  // name NUL, hasChildren=0, type=2, slot=1, zero size/ops/data/metadata.
  response.set(Uint8Array.of(0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0), 18);
  return response;
}

describe('Syntakt OS 1.40 slot listing', () => {
  it('parses validated global-library slot metadata without inferring capacity', () => {
    expect(parseSyntaktSampleSlotList(listFixture())).toEqual([{
      slot: 7,
      name: 'TEST',
      storedBytes: 4096,
      operations: 0x007e,
      hasData: true,
      hasMetadata: false,
    }]);
  });

  it('rejects malformed record types and count mismatches', () => {
    const malformed = listFixture();
    malformed[23] = 1;
    expect(() => parseSyntaktSampleSlotList(malformed)).toThrow('Unexpected');
    const mismatch = listFixture();
    writeUint32BE(mismatch, 14, 2);
    expect(() => parseSyntaktSampleSlotList(mismatch)).toThrow('count');
    const unknownHeader = listFixture();
    unknownHeader[6] = 1;
    expect(() => parseSyntaktSampleSlotList(unknownHeader)).toThrow('header');
  });

  it('accepts only the captured zero-byte blank global-library record', () => {
    expect(parseSyntaktSampleSlotList(capturedEmptySlotFixture())).toEqual([{
      slot: 1, name: '', storedBytes: 0, operations: 0, hasData: false, hasMetadata: false,
    }]);
    const malformed = capturedEmptySlotFixture();
    malformed[29] = 1; // operations low byte
    expect(() => parseSyntaktSampleSlotList(malformed)).toThrow('Unexpected');
  });
});
