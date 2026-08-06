import { describe, expect, it } from 'vitest';
import { decodeElektronSysex, ELEKTRON_SYSEX_HEADER, encodeElektronSysex, pack7Bit, unpack7Bit } from './sysex-codec.js';
import { SyntaktDevice } from './syntakt-device.js';
import { ElektronSession } from './elektron-session.js';
import { MidiTransportError } from '../midi/midi-transport.js';
import type { MidiTransport } from '../midi/midi-transport.js';
import { SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT, SYNTAKT_OS_1_40_SLOT_1_READER_CAPTURE, SYNTAKT_OS_1_40_SLOT_1_WRITER_CAPTURE } from './syntakt-transcripts.js';

class FakeTransport implements MidiTransport {
  sent: Uint8Array[] = [];
  closed = false;
  private messageListeners = new Set<(data: Uint8Array) => void>();
  private disconnectListeners = new Set<(reason: Error) => void>();
  send(data: Uint8Array): void { this.sent.push(data); }
  onMessage(listener: (data: Uint8Array) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onDisconnect(listener: (reason: Error) => void): () => void { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
  async close(): Promise<void> { this.closed = true; }
  receive(data: Uint8Array): void { for (const listener of this.messageListeners) listener(data); }
  disconnect(): void { for (const listener of this.disconnectListeners) listener(new MidiTransportError('unplugged')); }
}

describe('Elektron SysEx codec', () => {
  it('round-trips seven-bit packing across group boundaries', () => {
    const source = Uint8Array.of(0x00, 0x80, 0xff, 0x7f, 0x81, 0x40, 0xfe, 0x12, 0x93);
    expect(unpack7Bit(pack7Bit(source))).toEqual(source);
  });

  it('frames and validates Elektron SysEx messages', () => {
    const payload = Uint8Array.of(0x00, 0x01, 0x00, 0x00, 0x01, 0x80);
    const encoded = encodeElektronSysex(payload);
    expect(encoded[0]).toBe(0xf0);
    expect(encoded.at(-1)).toBe(0xf7);
    expect(decodeElektronSysex(encoded)).toEqual(payload);
    expect(decodeElektronSysex(Uint8Array.of(0xf0, 0x7f, 0xf7))).toBeNull();
  });

  it('matches the echoed reply sequence at bytes 2–3', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const response = session.request(0x01);
    await Promise.resolve();
    transport.receive(encodeElektronSysex(Uint8Array.of(0, 0, 0, 0, 0x81, 13)));
    await expect(response).resolves.toEqual(Uint8Array.of(0, 0, 0, 0, 0x81, 13));
    await session.close();
  });

  it('fails queued requests after a disconnect', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const first = session.request(0x01);
    const queued = session.request(0x02);
    await Promise.resolve();
    transport.disconnect();
    await expect(first).rejects.toThrow('unplugged');
    await expect(queued).rejects.toThrow('unplugged');
    expect(transport.sent).toHaveLength(1);
    await session.close();
  });

  it('makes a mismatched Elektron reply terminal instead of waiting for a timeout', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const first = session.request(0x01);
    const queued = session.request(0x02);
    await Promise.resolve();
    transport.receive(encodeElektronSysex(Uint8Array.of(0, 0, 0, 1, 0x81, 0x1e)));
    await expect(first).rejects.toThrow('did not match');
    await expect(queued).rejects.toThrow('did not match');
    expect(transport.sent).toHaveLength(1);
    expect(transport.closed).toBe(true);
  });

  it('makes a malformed Elektron-framed reply terminal instead of waiting for a timeout', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const request = session.request(0x01);
    await Promise.resolve();
    transport.receive(Uint8Array.of(...ELEKTRON_SYSEX_HEADER, 0xf7));
    await expect(request).rejects.toThrow('Malformed Syntakt response');
    expect(transport.closed).toBe(true);
  });

  it('makes a timeout terminal, rejects queued requests, and closes the transport', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const first = session.request(0x01, undefined, { timeoutMs: 1 });
    const queued = session.request(0x02);
    await expect(first).rejects.toThrow('did not answer');
    await expect(queued).rejects.toThrow('did not answer');
    expect(transport.sent).toHaveLength(1);
    expect(transport.closed).toBe(true);
  });

  it('makes an after-send abort terminal but leaves a pre-send abort harmless', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const controller = new AbortController();
    const first = session.request(0x01, undefined, { signal: controller.signal });
    const queued = session.request(0x02);
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.sent).toHaveLength(1);
    expect(transport.closed).toBe(true);

    const safeTransport = new FakeTransport();
    const safeSession = new ElektronSession(safeTransport);
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(safeSession.request(0x01, undefined, { signal: preAborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(safeTransport.sent).toHaveLength(0);
    expect(safeTransport.closed).toBe(false);
    await safeSession.close();
  });

  it('does not interleave queued requests inside an exclusive protocol operation', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const exclusive = session.exclusive(async (request) => {
      const first = request(0x01);
      await Promise.resolve();
      transport.receive(encodeElektronSysex(Uint8Array.of(0, 0, 0, 0, 0x81, 1)));
      await first;
      const second = request(0x02);
      await Promise.resolve();
      transport.receive(encodeElektronSysex(Uint8Array.of(0, 0, 0, 1, 0x82, 2)));
      await second;
    });
    const queued = session.request(0x03);
    await exclusive;
    expect(decodeElektronSysex(transport.sent[0])?.[4]).toBe(0x01);
    expect(decodeElektronSysex(transport.sent[1])?.[4]).toBe(0x02);
    await Promise.resolve();
    expect(decodeElektronSysex(transport.sent[2])?.[4]).toBe(0x03);
    transport.receive(encodeElektronSysex(Uint8Array.of(0, 0, 0, 2, 0x83, 3)));
    await queued;
    await session.close();
  });

  it('replays the sanitized OS 1.40 Syntakt identity transcript', async () => {
    const transport = new FakeTransport();
    const session = new ElektronSession(transport);
    const device = new SyntaktDevice(session);
    const identity = device.identify();

    for (let index = 0; index < SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT.length; index += 2) {
      for (let attempt = 0; attempt < 10 && transport.sent.length <= index / 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const request = SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[index];
      const response = SYNTAKT_OS_1_40_IDENTIFY_TRANSCRIPT[index + 1];
      expect(decodeElektronSysex(transport.sent[index / 2])).toEqual(request.payload);
      transport.receive(encodeElektronSysex(response.payload));
    }

    await expect(identity).resolves.toEqual({ deviceId: 0x1e, name: 'Syntakt', osVersion: '1.40' });
    await session.close();
  });

  it('retains the captured OS 1.40 reader block boundaries for slot 1', () => {
    const capture = SYNTAKT_OS_1_40_SLOT_1_READER_CAPTURE;
    expect(capture.openCommand).toBe(0x54);
    expect(capture.readCommand).toBe(0x55);
    expect(capture.closeCommand).toBe(0x56);
    expect(capture.initialEmptyRead).toBe(true);
    expect(capture.fullBlockCount * capture.fullBlockBytes + capture.finalBlockBytes).toBe(capture.rawDataBytes);
    expect(capture.rawDataBytes - capture.wavPcmBytes).toBe(107);
    expect(capture.wavBytes).toBeGreaterThan(capture.wavPcmBytes);
  });

  it('retains the authorized OS 1.40 writer boundaries and restoration proof', () => {
    const capture = SYNTAKT_OS_1_40_SLOT_1_WRITER_CAPTURE;
    expect(capture.openCommand).toBe(0x57);
    expect(capture.writeCommand).toBe(0x58);
    expect(capture.closeCommand).toBe(0x59);
    expect(capture.contentBlockBytes.reduce((total, size) => total + size, 0)).toBe(capture.contentBytes);
    expect(capture.contentBytes + capture.footerBytes).toBe(capture.totalBytes);
    expect(capture.verifiedPcmMatch).toBe(true);
  });
});
