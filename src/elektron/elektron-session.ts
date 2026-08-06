import type { MidiTransport } from '../midi/midi-transport.js';
import { MidiTransportError } from '../midi/midi-transport.js';
import { decodeElektronSysex, ELEKTRON_SYSEX_HEADER, encodeElektronSysex } from './sysex-codec.js';

const DEFAULT_TIMEOUT_MS = 5_000;

export type ElektronRequest = (command: number, body?: Uint8Array<ArrayBufferLike>, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Uint8Array>;

/** A serialized request broker. Responses must echo the request sequence and type. */
export class ElektronSession {
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending: { sequence: number; type: number; resolve: (data: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private terminalError: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly terminalListeners = new Set<(error: Error) => void>();
  private readonly removeMessage: () => void;
  private readonly removeDisconnect: () => void;

  constructor(private readonly transport: MidiTransport) {
    this.removeMessage = transport.onMessage((message) => this.onMessage(message));
    this.removeDisconnect = transport.onDisconnect((error) => this.fail(error));
  }

  request(command: number, body: Uint8Array<ArrayBufferLike> = new Uint8Array(), options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const run = async (): Promise<Uint8Array> => this.execute(command, body, options);
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Run a protocol-critical group without allowing another caller's request
   * between its member commands. The supplied requester is valid only while
   * this callback runs; callers must not retain it.
   */
  exclusive<T>(operation: (request: ElektronRequest) => Promise<T>): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const run = async (): Promise<T> => {
      if (this.terminalError) throw this.terminalError;
      const request: ElektronRequest = (command, body = new Uint8Array(), options = {}) => this.execute(command, body, options);
      return operation(request);
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.fail(new MidiTransportError('MIDI session closed'));
    await this.closeTransport();
  }

  /** Observe a terminal timeout, abort, disconnect, or explicit close. */
  onTerminal(listener: (error: Error) => void): () => void {
    if (this.terminalError) listener(this.terminalError);
    else this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  private async closeTransport(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.transport.close().catch(() => undefined);
    await this.closePromise;
  }

  private terminate(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectPending(error);
    this.removeMessage();
    this.removeDisconnect();
    for (const listener of this.terminalListeners) listener(error);
    this.terminalListeners.clear();
    void this.closeTransport();
  }

  private execute(command: number, body: Uint8Array<ArrayBufferLike>, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<Uint8Array> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (options.signal?.aborted) return Promise.reject(new DOMException('Transfer cancelled', 'AbortError'));
    const sequence = this.sequence++ & 0xffff;
    const payload = new Uint8Array(5 + body.length);
    payload[0] = (sequence >>> 8) & 0xff;
    payload[1] = sequence & 0xff;
    payload[4] = command;
    payload.set(body, 5);
    return new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new MidiTransportError(`Syntakt did not answer command 0x${command.toString(16)}`)), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      // At this point the command is about to be sent. An abort after send is
      // protocol-ambiguous, so permanently close rather than queue another one.
      const abort = () => this.fail(new DOMException('Transfer cancelled', 'AbortError'));
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pending = { sequence, type: command | 0x80, resolve: (value) => { options.signal?.removeEventListener('abort', abort); resolve(value); }, reject: (error) => { options.signal?.removeEventListener('abort', abort); reject(error); }, timer: timeout };
      try {
        this.transport.send(encodeElektronSysex(payload));
      } catch (error) {
        this.fail(error instanceof Error ? error : new MidiTransportError('Failed to send MIDI message'));
      }
    });
  }

  private onMessage(message: Uint8Array): void {
    const payload = decodeElektronSysex(message);
    if (!this.pending) return;
    if (!payload || payload.length < 5) {
      if (hasElektronHeader(message)) this.fail(new MidiTransportError('Malformed Syntakt response'));
      return;
    }
    // Elektron replies reserve bytes 0–1 and echo the request sequence at 2–3.
    const sequence = (payload[2] << 8) | payload[3];
    if (sequence !== this.pending.sequence || payload[4] !== this.pending.type) {
      this.fail(new MidiTransportError('Syntakt response did not match the active request'));
      return;
    }
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private fail(error: Error): void {
    this.terminate(error);
  }
}

function hasElektronHeader(message: Uint8Array): boolean {
  return message.length >= ELEKTRON_SYSEX_HEADER.length
    && ELEKTRON_SYSEX_HEADER.every((value, index) => message[index] === value);
}
