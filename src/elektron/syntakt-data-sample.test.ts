import { describe, expect, it } from 'vitest';
import { buildSyntaktDataSample, parseSyntaktDataSample, syntaktCrc32 } from './syntakt-data-sample.js';
import { readUint32BE } from './sysex-codec.js';

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function capturedShapeFixture(): Uint8Array {
  const dataHeaderBytes = 31;
  const slotHeaderBytes = 64;
  const footerBytes = 12;
  const pcmBigEndian = Uint8Array.of(0x12, 0x34, 0xfe, 0xdc);
  const payloadBytes = slotHeaderBytes + pcmBigEndian.length;
  const raw = new Uint8Array(dataHeaderBytes + payloadBytes + footerBytes);
  writeUint32BE(raw, 0, 0xac11d303);
  raw[29] = 0;
  raw[30] = footerBytes;
  writeUint32BE(raw, 21, 7);
  writeUint32BE(raw, 25, payloadBytes);
  writeUint32BE(raw, dataHeaderBytes, 0x53414d50);
  writeUint32BE(raw, dataHeaderBytes + 8, 2);
  raw.set(Uint8Array.of(...new TextEncoder().encode('TEST')), dataHeaderBytes + 12);
  raw.set(pcmBigEndian, dataHeaderBytes + slotHeaderBytes);
  const footerOffset = raw.length - footerBytes;
  writeUint32BE(raw, footerOffset, syntaktCrc32(raw.slice(dataHeaderBytes, footerOffset)));
  writeUint32BE(raw, footerOffset + 4, footerBytes);
  writeUint32BE(raw, footerOffset + 8, 0xaaa1daaa);
  return raw;
}

function capturedEmptySlotFixture(): Uint8Array {
  // Slot 1 was cleared, then read from a real OS 1.40 Syntakt.
  // It is the 43-byte payload returned in the final reader block.
  return Uint8Array.of(
    0xac, 0x11, 0xd3, 0x03, 0x02, 0x00, 0x08, 0x00,
    0x0d, 0x30, 0x30, 0x38, 0x32, 0x00, 0x00, 0x00,
    0x08, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0xff,
    0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
  );
}

describe('Syntakt data-sample parser', () => {
  it('parses the captured OS 1.40 container shape and converts PCM to little-endian', () => {
    const raw = capturedShapeFixture();
    expect(parseSyntaktDataSample(raw)).toEqual({
      slot: 7,
      name: 'TEST',
      frames: 2,
      pcm16le: Uint8Array.of(0x34, 0x12, 0xdc, 0xfe),
      footerHash: syntaktCrc32(raw.slice(31, raw.length - 12)),
    });
  });

  it('rejects malformed container boundaries', () => {
    const raw = capturedShapeFixture();
    raw[30] = 11;
    expect(() => parseSyntaktDataSample(raw)).toThrow('length');
  });

  it('rejects an otherwise valid container with a changed payload', () => {
    const raw = capturedShapeFixture();
    raw[95] ^= 1;
    expect(() => parseSyntaktDataSample(raw)).toThrow('footer');
  });

  it('accepts the payload-length footer field returned by OS 1.40 reads', () => {
    const raw = capturedShapeFixture();
    writeUint32BE(raw, raw.length - 8, readUint32BE(raw, 25));
    expect(parseSyntaktDataSample(raw)).toMatchObject({ slot: 7, name: 'TEST', frames: 2 });
  });

  it('recognizes the exact captured OS 1.40 empty-slot sentinel', () => {
    expect(parseSyntaktDataSample(capturedEmptySlotFixture())).toEqual({
      slot: 1,
      empty: true,
      footerHash: 0xffffffff,
    });
  });

  it('rejects a zero-payload container that is not the captured empty sentinel', () => {
    const raw = capturedEmptySlotFixture();
    raw[42] = 1;
    expect(() => parseSyntaktDataSample(raw)).toThrow('empty');
  });

  it('rejects mutations in every fixed byte of the captured empty sentinel', () => {
    const template = capturedEmptySlotFixture();
    for (let offset = 0; offset < template.length; offset += 1) {
      if (offset >= 21 && offset <= 24) continue;
      const mutated = template.slice();
      mutated[offset] ^= 1;
      expect(() => parseSyntaktDataSample(mutated), `offset ${offset}`).toThrow();
    }
  });

  it('builds the captured OS 1.40 writer parts with a separate footer', () => {
    const upload = buildSyntaktDataSample(1, 'TEST', Uint8Array.of(0x34, 0x12, 0xdc, 0xfe));
    expect(upload.content).toHaveLength(31 + 64 + 4);
    expect(upload.content.slice(95)).toEqual(Uint8Array.of(0x12, 0x34, 0xfe, 0xdc));
    expect(upload.footer.slice(4)).toEqual(Uint8Array.of(0, 0, 0, 12, 0xaa, 0xa1, 0xda, 0xaa));
    expect(parseSyntaktDataSample(new Uint8Array([...upload.content, ...upload.footer]))).toMatchObject({ slot: 1, name: 'TEST', frames: 2 });
  });

  it('round-trips device names stored beyond ASCII', () => {
    const upload = buildSyntaktDataSample(1, 'Böö', Uint8Array.of(0, 0));
    const parsed = parseSyntaktDataSample(new Uint8Array([...upload.content, ...upload.footer]));

    expect(parsed).toMatchObject({ slot: 1, name: 'Böö' });
  });

  it('rejects NUL because the device reader treats it as a name terminator', () => {
    expect(() => buildSyntaktDataSample(1, 'A\0B', Uint8Array.of(0, 0))).toThrow('storable windows-1252');
  });

  it('uses the captured Elektron CRC initial state', () => {
    expect(syntaktCrc32(new TextEncoder().encode('123456789'))).toBe(0xd202d277);
  });
});
