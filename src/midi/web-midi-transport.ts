import type { MidiTransport } from './midi-transport.js';
import { MidiTransportError } from './midi-transport.js';

export interface WebMidiDevice {
  id: string;
  input: MIDIInput;
  output: MIDIOutput;
  inputName: string;
  outputName: string;
}

/** Web MIDI adapter. Device identity is always confirmed by ElektronSession afterwards. */
export class WebMidiTransport implements MidiTransport {
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<(reason: Error) => void>();
  private closed = false;
  private disposed = false;

  private constructor(
    private readonly access: MIDIAccess,
    private readonly input: MIDIInput,
    private readonly output: MIDIOutput,
  ) {
    input.onmidimessage = (event) => {
      if (!event.data) return;
      const copy = new Uint8Array(event.data.length);
      copy.set(event.data);
      for (const listener of this.messageListeners) listener(copy);
    };
    access.onstatechange = (event) => {
      const port = event.port;
      if (!port) return;
      if (port.id === input.id || port.id === output.id) {
        if (port.state === 'disconnected') this.notifyDisconnect('Syntakt MIDI port disconnected');
      }
    };
  }

  static supported(): boolean {
    return window.isSecureContext && typeof navigator.requestMIDIAccess === 'function';
  }

  static async discover(): Promise<WebMidiDevice[]> {
    if (!WebMidiTransport.supported()) {
      throw new MidiTransportError('Web MIDI with SysEx needs a secure HTTPS or localhost page');
    }
    let access: MIDIAccess;
    try {
      access = await navigator.requestMIDIAccess({ sysex: true });
    } catch (error) {
      throw new MidiTransportError(error instanceof Error ? error.message : 'SysEx permission was not granted');
    }
    if (!access.sysexEnabled) throw new MidiTransportError('SysEx permission was not granted');

    return this.pairedDevices(access);
  }

  static async request(deviceId?: string): Promise<{ transport: WebMidiTransport; devices: WebMidiDevice[] }> {
    if (!WebMidiTransport.supported()) {
      throw new MidiTransportError('Web MIDI with SysEx needs a secure HTTPS or localhost page');
    }
    let access: MIDIAccess;
    try {
      access = await navigator.requestMIDIAccess({ sysex: true });
    } catch (error) {
      throw new MidiTransportError(error instanceof Error ? error.message : 'SysEx permission was not granted');
    }
    if (!access.sysexEnabled) throw new MidiTransportError('SysEx permission was not granted');
    const devices = this.pairedDevices(access);
    const selected = deviceId ? devices.find((device) => device.id === deviceId) : this.defaultDevice(devices);
    if (!selected) throw new MidiTransportError('The selected MIDI device is no longer available');
    await selected.input.open();
    await selected.output.open();
    return { transport: new WebMidiTransport(access, selected.input, selected.output), devices };
  }

  private static pairedDevices(access: MIDIAccess): WebMidiDevice[] {
    const inputs = [...access.inputs.values()];
    // Each output can only belong to one pair, so two same-named port pairs
    // bind in enumeration order instead of both claiming the first output.
    const outputs = new Set([...access.outputs.values()]);
    const devices: WebMidiDevice[] = [];
    for (const input of inputs) {
      const output = [...outputs].find((candidate) => pairableName(candidate.name) === pairableName(input.name))
        ?? [...outputs].find((candidate) => !!candidate.manufacturer && candidate.manufacturer === input.manufacturer);
      if (output) {
        outputs.delete(output);
        // This is passed through a <select>; JSON keeps the opaque Web MIDI
        // port IDs reversible without embedding a null character in HTML.
        devices.push({
          id: JSON.stringify([input.id, output.id]),
          input,
          output,
          inputName: input.name ?? 'MIDI input',
          outputName: output.name ?? 'MIDI output',
        });
      }
    }
    if (!devices.length) throw new MidiTransportError('No MIDI devices found. Connect the Syntakt over USB and switch it on.');
    return devices.sort((left, right) => syntaktRank(left) - syntaktRank(right));
  }

  private static defaultDevice(devices: WebMidiDevice[]): WebMidiDevice {
    const syntaktDevices = devices.filter((device) => /syntakt/i.test(`${device.inputName} ${device.outputName}`));
    if (!syntaktDevices.length && devices.length !== 1) {
      throw new MidiTransportError('More than one MIDI device is connected; leave only the Syntakt connected before continuing');
    }
    return syntaktDevices[0] ?? devices[0];
  }

  send(data: Uint8Array): void {
    if (this.closed) throw new MidiTransportError('MIDI transport is closed');
    this.output.send(data);
  }

  onMessage(listener: (data: Uint8Array) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onDisconnect(listener: (reason: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.input.onmidimessage = null;
    this.access.onstatechange = null;
    await Promise.all([this.input.close(), this.output.close()]);
  }

  private notifyDisconnect(message: string): void {
    this.closed = true;
    const error = new MidiTransportError(message);
    for (const listener of this.disconnectListeners) listener(error);
  }
}

/**
 * Windows decorates a device's ports as `MIDIIN2 (Name)` / `MIDIOUT2 (Name)`,
 * so input and output names of the same device never match verbatim there.
 */
function pairableName(name: string | null): string {
  const trimmed = (name ?? '').trim();
  const decorated = /^midi(?:in|out)\d*\s+\((.+)\)$/i.exec(trimmed);
  return (decorated?.[1] ?? trimmed).trim().toLowerCase();
}

function syntaktRank(device: WebMidiDevice): number {
  const exact = (name: string): boolean => name.trim().toLowerCase() === 'elektron syntakt';
  if (exact(device.inputName) && exact(device.outputName)) return 0;
  if (/\bsyntakt\b/i.test(`${device.inputName} ${device.outputName}`)) return 1;
  return 2;
}
