import { describe, expect, it } from 'vitest';
import { ElektronSession } from './elektron-session.js';
import { decodeElektronSysex, encodeElektronSysex } from './sysex-codec.js';
import { assertSupportedSyntaktIdentity, assertSyntaktWriteIdentity, SyntaktDevice } from './syntakt-device.js';
import { syntaktCrc32 } from './syntakt-data-sample.js';
import { SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT } from './syntakt-transcripts.js';
import type { MidiTransport } from '../midi/midi-transport.js';

class FakeTransport implements MidiTransport {
  readonly sent: Uint8Array[] = [];
  closed = false;
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<(reason: Error) => void>();

  send(data: Uint8Array): void { this.sent.push(data); }
  onMessage(listener: (data: Uint8Array) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onDisconnect(listener: (reason: Error) => void): () => void { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
  async close(): Promise<void> { this.closed = true; }
  receive(payload: Uint8Array): void { for (const listener of this.messageListeners) listener(encodeElektronSysex(payload)); }
  disconnect(): void { for (const listener of this.disconnectListeners) listener(new Error('Syntakt MIDI port disconnected')); }
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function response(sequence: number, type: number, body: Uint8Array): Uint8Array {
  const payload = new Uint8Array(5 + body.length);
  payload[2] = (sequence >>> 8) & 0xff;
  payload[3] = sequence & 0xff;
  payload[4] = type;
  payload.set(body, 5);
  return payload;
}

function capturedContainer(): Uint8Array {
  const pcmBigEndian = Uint8Array.of(0x12, 0x34, 0xfe, 0xdc);
  const payloadBytes = 64 + pcmBigEndian.length;
  const raw = new Uint8Array(31 + payloadBytes + 12);
  writeUint32BE(raw, 0, 0xac11d303);
  writeUint32BE(raw, 21, 1);
  writeUint32BE(raw, 25, payloadBytes);
  raw[30] = 12;
  writeUint32BE(raw, 31, 0x53414d50);
  writeUint32BE(raw, 39, 2);
  raw.set(new TextEncoder().encode('TEST'), 43);
  raw.set(pcmBigEndian, 95);
  writeUint32BE(raw, 99, syntaktCrc32(raw.slice(31, 99)));
  writeUint32BE(raw, 103, 12);
  writeUint32BE(raw, 107, 0xaaa1daaa);
  return raw;
}

function capturedEmptyContainer(): Uint8Array {
  return Uint8Array.of(
    0xac, 0x11, 0xd3, 0x03, 0x02, 0x00, 0x08, 0x00,
    0x0d, 0x30, 0x30, 0x38, 0x32, 0x00, 0x00, 0x00,
    0x08, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0xff,
    0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
  );
}

function readerOpenResponse(sequence: number): Uint8Array {
  const body = new Uint8Array(10);
  body[0] = 1;
  writeUint32BE(body, 1, 2);
  writeUint32BE(body, 5, 0x2000);
  return response(sequence, 0xd4, body);
}

function readerBlockResponse(sequence: number, blockSequence: number, last: boolean, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(22 + data.length);
  body[0] = 1;
  writeUint32BE(body, 1, 2);
  writeUint32BE(body, 5, blockSequence);
  writeUint32BE(body, 9, last ? 1000 : 0);
  body[13] = last ? 1 : 0;
  writeUint32BE(body, 18, data.length);
  body.set(data, 22);
  return response(sequence, 0xd5, body);
}

function initialReaderProbeResponse(sequence: number): Uint8Array {
  const body = new Uint8Array(22);
  body[0] = 1;
  writeUint32BE(body, 1, 2);
  // Captured OS 1.40 probe token. It is intentionally not a block sequence.
  writeUint32BE(body, 5, 0x4015b676);
  writeUint32BE(body, 9, 0x44658410);
  writeUint32BE(body, 14, 0xffffffff);
  return response(sequence, 0xd5, body);
}

function readerCloseResponse(sequence: number, transferredBytes: number): Uint8Array {
  const body = new Uint8Array(9);
  body[0] = 1;
  writeUint32BE(body, 1, 2);
  writeUint32BE(body, 5, transferredBytes);
  return response(sequence, 0xd6, body);
}

function identityResponse(sequence: number, command: 0x81 | 0x82): Uint8Array {
  const source = command === 0x81 ? SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[1].payload : SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[3].payload;
  const payload = source.slice();
  payload[2] = (sequence >>> 8) & 0xff;
  payload[3] = sequence & 0xff;
  return payload;
}

/** Exact decoded OS 1.40A version response captured from the connected Syntakt. */
function identityResponse140A(sequence: number): Uint8Array {
  return Uint8Array.of(0x31, 0xd9, (sequence >>> 8) & 0xff, sequence & 0xff, 0x82, 0x30, 0x30, 0x38, 0x36, 0, 0x31, 0x2e, 0x34, 0x30, 0x41, 0);
}

/** OS 1.40 uses the same decoded response framing with its four-byte version. */
function identityResponse140(sequence: number): Uint8Array {
  return Uint8Array.of(0x31, 0xd9, (sequence >>> 8) & 0xff, sequence & 0xff, 0x82, 0x30, 0x30, 0x38, 0x32, 0, 0x31, 0x2e, 0x34, 0x30, 0);
}

function slotListResponse(sequence: number): Uint8Array {
  const records: number[] = [];
  for (let slot = 1; slot <= 64; slot += 1) {
    const name = new TextEncoder().encode(`S${slot}`);
    records.push(...name, 0, 0, 2, 0, 0, 0, slot, 0, 1, 47, 40, 0, 0x7e, 1, 0);
  }
  const body = new Uint8Array(13 + records.length);
  body[0] = 1;
  body[8] = 0x41;
  writeUint32BE(body, 9, 64);
  body.set(records, 13);
  return response(sequence, 0xd3, body);
}

function writerOpenResponse(sequence: number, writerId: number): Uint8Array {
  const body = new Uint8Array(5);
  body[0] = 1;
  writeUint32BE(body, 1, writerId);
  return response(sequence, 0xd7, body);
}

function writerBlockResponse(sequence: number, writerId: number, blockSequence: number, total: number): Uint8Array {
  const body = new Uint8Array(13);
  body[0] = 1;
  writeUint32BE(body, 1, writerId);
  writeUint32BE(body, 5, blockSequence);
  writeUint32BE(body, 9, total);
  return response(sequence, 0xd8, body);
}

function writerCloseResponse(sequence: number, writerId: number, total: number): Uint8Array {
  const body = new Uint8Array(9);
  body[0] = 1;
  writeUint32BE(body, 1, writerId);
  writeUint32BE(body, 5, total);
  return response(sequence, 0xd9, body);
}

async function waitForSent(transport: FakeTransport, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && transport.sent.length < count; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(transport.sent).toHaveLength(count);
}

describe('Syntakt OS 1.40 data-sample reader', () => {
  it('replays the captured open/read/close lifecycle and converts the completed container', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();

    await waitForSent(transport, 1);
    transport.receive(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[1].payload);
    await waitForSent(transport, 2);
    transport.receive(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[3].payload);
    await identify;

    const download = device.downloadSlot(1);
    await waitForSent(transport, 3);
    expect(decodeElektronSysex(transport.sent[2])).toEqual(Uint8Array.of(
      0, 2, 0, 0, 0x54, ...new TextEncoder().encode('/samples/1\0'), 0, 0, 0x20, 0, 0,
    ));
    transport.receive(readerOpenResponse(2));

    await waitForSent(transport, 4);
    expect(decodeElektronSysex(transport.sent[3])).toEqual(Uint8Array.of(0, 3, 0, 0, 0x55, 0, 0, 0, 2, 0, 0, 0, 0));
    transport.receive(initialReaderProbeResponse(3));

    const raw = capturedContainer();
    await waitForSent(transport, 5);
    expect(decodeElektronSysex(transport.sent[4])).toEqual(Uint8Array.of(0, 4, 0, 0, 0x55, 0, 0, 0, 2, 0, 0, 0, 1));
    transport.receive(readerBlockResponse(4, 1, true, raw));

    await waitForSent(transport, 6);
    expect(decodeElektronSysex(transport.sent[5])).toEqual(Uint8Array.of(0, 5, 0, 0, 0x56, 0, 0, 0, 2));
    transport.receive(readerCloseResponse(5, raw.length));

    await expect(download).resolves.toMatchObject({
      slot: 1,
      name: 'TEST',
      frames: 2,
      pcm16le: Uint8Array.of(0x34, 0x12, 0xdc, 0xfe),
    });
    await session.close();
  });

  it('replays the captured OS 1.40 empty-slot reader lifecycle', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();

    await waitForSent(transport, 1); transport.receive(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[1].payload);
    await waitForSent(transport, 2); transport.receive(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[3].payload);
    await identify;

    const download = device.downloadSlot(1);
    await waitForSent(transport, 3); transport.receive(readerOpenResponse(2));
    await waitForSent(transport, 4); transport.receive(initialReaderProbeResponse(3));
    await waitForSent(transport, 5); transport.receive(readerBlockResponse(4, 1, true, capturedEmptyContainer()));
    await waitForSent(transport, 6); transport.receive(readerCloseResponse(5, 43));

    await expect(download).resolves.toEqual({ slot: 1, empty: true, footerHash: 0xffffffff });
    await session.close();
  });

  it('fails closed when reader close reports a contradictory byte total', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();
    await waitForSent(transport, 1); transport.receive(identityResponse(0, 0x81));
    await waitForSent(transport, 2); transport.receive(identityResponse(1, 0x82));
    await identify;

    const download = device.downloadSlot(1);
    await waitForSent(transport, 3); transport.receive(readerOpenResponse(2));
    await waitForSent(transport, 4); transport.receive(initialReaderProbeResponse(3));
    const raw = capturedContainer();
    await waitForSent(transport, 5); transport.receive(readerBlockResponse(4, 1, true, raw));
    await waitForSent(transport, 6); transport.receive(readerCloseResponse(5, raw.length - 1));

    await expect(download).rejects.toThrow('did not confirm reader close');
    await session.close();
  });

  it('rejects a reader payload whose embedded slot does not match the request', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();
    await waitForSent(transport, 1); transport.receive(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[1].payload);
    await waitForSent(transport, 2); transport.receive(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[3].payload);
    await identify;

    const download = device.downloadSlot(1);
    await waitForSent(transport, 3); transport.receive(readerOpenResponse(2));
    await waitForSent(transport, 4); transport.receive(initialReaderProbeResponse(3));
    const wrongSlot = capturedContainer();
    writeUint32BE(wrongSlot, 21, 2);
    writeUint32BE(wrongSlot, wrongSlot.length - 12, syntaktCrc32(wrongSlot.slice(31, wrongSlot.length - 12)));
    await waitForSent(transport, 5); transport.receive(readerBlockResponse(4, 1, true, wrongSlot));
    await waitForSent(transport, 6); transport.receive(readerCloseResponse(5, wrongSlot.length));
    await expect(download).rejects.toThrow('requested slot 1');
    await session.close();
  });

  it('accepts only the exact tested firmware versions', () => {
    expect(() => assertSupportedSyntaktIdentity({ deviceId: 0x1e, name: 'Syntakt', osVersion: '1.40' })).not.toThrow();
    expect(() => assertSupportedSyntaktIdentity({ deviceId: 0x1e, name: 'Syntakt', osVersion: '1.40A' })).not.toThrow();
    expect(() => assertSyntaktWriteIdentity({ deviceId: 0x1e, name: 'Syntakt', osVersion: '1.40' })).not.toThrow();
    expect(() => assertSyntaktWriteIdentity({ deviceId: 0x1e, name: 'Syntakt', osVersion: '1.40A' })).not.toThrow();
    for (const osVersion of ['1.400', '1.41', '']) {
      expect(() => assertSupportedSyntaktIdentity({ deviceId: 0x1e, name: 'Syntakt', osVersion })).toThrow('supported transfer matrix');
    }
    expect(() => assertSupportedSyntaktIdentity({ deviceId: 0x1e, name: 'Digitakt', osVersion: '1.40' })).toThrow('supported transfer matrix');
  });

  it('identifies the captured 1.40A version response', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();
    await waitForSent(transport, 1); transport.receive(identityResponse(0, 0x81));
    await waitForSent(transport, 2); transport.receive(identityResponse140A(1));
    await expect(identify).resolves.toMatchObject({ name: 'Syntakt', osVersion: '1.40A' });
    await session.close();
  });

  it('identifies the OS 1.40 response framing', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();
    await waitForSent(transport, 1); transport.receive(identityResponse(0, 0x81));
    await waitForSent(transport, 2); transport.receive(identityResponse140(1));
    await expect(identify).resolves.toMatchObject({ name: 'Syntakt', osVersion: '1.40' });
    await session.close();
  });

  it('rejects a malformed identity descriptor before any reader or writer command', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();
    await waitForSent(transport, 1);
    const malformedPing = identityResponse(0, 0x81);
    malformedPing[6] = 0x15;
    transport.receive(malformedPing);
    await waitForSent(transport, 2);
    transport.receive(identityResponse(1, 0x82));
    await expect(identify).rejects.toThrow('identity response');
    expect(transport.sent).toHaveLength(2);
    await session.close();
  });

  it('requires the captured sample-library command capabilities but not their descriptor order', async () => {
    for (const missing of [0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5c]) {
      const transport = new FakeTransport();
      const session = new ElektronSession(transport);
      const device = new SyntaktDevice(session);
      const identify = device.identify();
      await waitForSent(transport, 1);
      const ping = identityResponse(0, 0x81);
      const index = ping.indexOf(missing, 7);
      ping[index] = 0x7f;
      transport.receive(ping);
      await waitForSent(transport, 2); transport.receive(identityResponse(1, 0x82));
      await expect(identify).rejects.toThrow('identity response');
      await session.close();
    }

    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identify = device.identify();
    await waitForSent(transport, 1);
    const ping = identityResponse(0, 0x81);
    const descriptor = ping.slice(7, 29).reverse();
    ping.set(descriptor, 7);
    transport.receive(ping);
    await waitForSent(transport, 2); transport.receive(identityResponse(1, 0x82));
    await expect(identify).resolves.toMatchObject({ name: 'Syntakt', osVersion: '1.40' });
    await session.close();
  });

  it('emits no writer-open command when the final content hash proof fails', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const expectedSlot = { slot: 1, name: 'S1', storedBytes: 77_608, operations: 0x007e, hasData: true, hasMetadata: false };
    const upload = device.uploadSlot(1, 'NEW', Uint8Array.of(0x34, 0x12), expectedSlot, { name: 'TEST', pcmSha256: '0'.repeat(64) }, () => undefined);
    await waitForSent(transport, 1); transport.receive(identityResponse(0, 0x81));
    await waitForSent(transport, 2); transport.receive(identityResponse(1, 0x82));
    await waitForSent(transport, 3); transport.receive(slotListResponse(2));
    const raw = capturedContainer();
    await waitForSent(transport, 4); transport.receive(readerOpenResponse(3));
    await waitForSent(transport, 5); transport.receive(initialReaderProbeResponse(4));
    await waitForSent(transport, 6); transport.receive(readerBlockResponse(5, 1, true, raw));
    await waitForSent(transport, 7); transport.receive(readerCloseResponse(6, raw.length));
    await expect(upload).rejects.toThrow('nothing was written');
    expect(transport.sent.map((message) => decodeElektronSysex(message)?.[4])).not.toContain(0x57);
    await session.close();
  });

  it('performs an exclusive final reader check immediately before the writer lifecycle', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const expectedSlot = { slot: 1, name: 'S1', storedBytes: 77_608, operations: 0x007e, hasData: true, hasMetadata: false };
    const progress: number[] = [];
    const upload = device.uploadSlot(1, 'TEST', Uint8Array.of(0x34, 0x12, 0xdc, 0xfe), expectedSlot, { name: 'TEST', pcm16le: Uint8Array.of(0x34, 0x12, 0xdc, 0xfe) }, ({ sentBytes }) => progress.push(sentBytes));

    await waitForSent(transport, 1);
    expect(decodeElektronSysex(transport.sent[0])).toEqual(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[0].payload);
    transport.receive(identityResponse(0, 0x81));
    await waitForSent(transport, 2);
    expect(decodeElektronSysex(transport.sent[1])).toEqual(SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[2].payload);
    transport.receive(identityResponse(1, 0x82));

    await waitForSent(transport, 3);
    expect(decodeElektronSysex(transport.sent[2])).toEqual(Uint8Array.of(0, 2, 0, 0, 0x53, ...new TextEncoder().encode('/samples/\0'), 0, 0, 0, 0, 0, 0, 0, 0, 1));
    transport.receive(slotListResponse(2));

    const raw = capturedContainer();
    await waitForSent(transport, 4); transport.receive(readerOpenResponse(3));
    await waitForSent(transport, 5); transport.receive(initialReaderProbeResponse(4));
    await waitForSent(transport, 6); transport.receive(readerBlockResponse(5, 1, true, raw));
    await waitForSent(transport, 7); transport.receive(readerCloseResponse(6, raw.length));
    // The reader close is immediately followed by writer open; no queued read
    // can interleave inside the exclusive device operation.
    await waitForSent(transport, 8);
    expect(decodeElektronSysex(transport.sent[7])).toEqual(Uint8Array.of(0, 7, 0, 0, 0x57, 0, 0, 0, 111, ...new TextEncoder().encode('/samples/1\0')));
    transport.receive(writerOpenResponse(7, 2));

    await waitForSent(transport, 9);
    const contentWrite = decodeElektronSysex(transport.sent[8]);
    // Bytes 13–16 are the golden Elektron-variant CRC-32 of the 99-byte
    // content block; a wiring or CRC-variant regression must fail here.
    expect(contentWrite?.slice(0, 21)).toEqual(Uint8Array.of(0, 8, 0, 0, 0x58, 0, 0, 0, 2, 0, 0, 0, 0, 0xf5, 0xf2, 0x11, 0xad, 0, 0, 0, 99));
    expect(contentWrite?.slice(21, 25)).toEqual(Uint8Array.of(0xac, 0x11, 0xd3, 0x03));
    transport.receive(writerBlockResponse(8, 2, 0, 99));

    await waitForSent(transport, 10);
    const footerWrite = decodeElektronSysex(transport.sent[9]);
    expect(footerWrite?.slice(0, 21)).toEqual(Uint8Array.of(0, 9, 0, 0, 0x58, 0, 0, 0, 2, 0, 0, 0, 1, 0xf3, 0x24, 0x54, 0xff, 0, 0, 0, 12));
    expect(footerWrite?.slice(21)).toEqual(Uint8Array.of(0x95, 0x49, 0x1f, 0x0d, 0, 0, 0, 12, 0xaa, 0xa1, 0xda, 0xaa));
    transport.receive(writerBlockResponse(9, 2, 1, 111));

    await waitForSent(transport, 11);
    expect(decodeElektronSysex(transport.sent[10])).toEqual(Uint8Array.of(0, 10, 0, 0, 0x59, 0, 0, 0, 2, 0, 0, 0, 111));
    transport.receive(writerCloseResponse(10, 2, 111));
    await expect(upload).resolves.toBeUndefined();
    expect(progress).toEqual([99, 111]);
  });

  it('uses the captured clear command only after matching the exact target, then reads the empty sentinel', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const expectedSlot = { slot: 1, name: 'S1', storedBytes: 77_608, operations: 0x007e, hasData: true, hasMetadata: false };
    const clear = device.clearSlot(1, expectedSlot, { name: 'TEST', pcm16le: Uint8Array.of(0x34, 0x12, 0xdc, 0xfe) });
    await waitForSent(transport, 1); transport.receive(identityResponse(0, 0x81));
    await waitForSent(transport, 2); transport.receive(identityResponse(1, 0x82));
    await waitForSent(transport, 3); transport.receive(slotListResponse(2));
    const raw = capturedContainer();
    await waitForSent(transport, 4); transport.receive(readerOpenResponse(3));
    await waitForSent(transport, 5); transport.receive(initialReaderProbeResponse(4));
    await waitForSent(transport, 6); transport.receive(readerBlockResponse(5, 1, true, raw));
    await waitForSent(transport, 7); transport.receive(readerCloseResponse(6, raw.length));
    await waitForSent(transport, 8);
    expect(decodeElektronSysex(transport.sent[7])).toEqual(Uint8Array.of(0, 7, 0, 0, 0x5c, ...new TextEncoder().encode('/samples/1\0')));
    transport.receive(response(7, 0xdc, Uint8Array.of(1)));
    await waitForSent(transport, 9); transport.receive(readerOpenResponse(8));
    await waitForSent(transport, 10); transport.receive(initialReaderProbeResponse(9));
    await waitForSent(transport, 11); transport.receive(readerBlockResponse(10, 1, true, capturedEmptyContainer()));
    await waitForSent(transport, 12); transport.receive(readerCloseResponse(11, 43));
    await expect(clear).resolves.toBeUndefined();
  });

  it('fails closed when clear acknowledgement has unexpected trailing data', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const expectedSlot = { slot: 1, name: 'S1', storedBytes: 77_608, operations: 0x007e, hasData: true, hasMetadata: false };
    const clear = device.clearSlot(1, expectedSlot, { name: 'TEST', pcm16le: Uint8Array.of(0x34, 0x12, 0xdc, 0xfe) });
    await waitForSent(transport, 1); transport.receive(identityResponse(0, 0x81));
    await waitForSent(transport, 2); transport.receive(identityResponse(1, 0x82));
    await waitForSent(transport, 3); transport.receive(slotListResponse(2));
    const raw = capturedContainer();
    await waitForSent(transport, 4); transport.receive(readerOpenResponse(3));
    await waitForSent(transport, 5); transport.receive(initialReaderProbeResponse(4));
    await waitForSent(transport, 6); transport.receive(readerBlockResponse(5, 1, true, raw));
    await waitForSent(transport, 7); transport.receive(readerCloseResponse(6, raw.length));
    await waitForSent(transport, 8); transport.receive(response(7, 0xdc, Uint8Array.of(1, 0)));
    await expect(clear).rejects.toThrow('The clear may not have finished');
  });

});
