import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebMidiTransport } from './web-midi-transport.js';

afterEach(() => vi.unstubAllGlobals());

describe('Web MIDI device pairing', () => {
  it('pairs decorated Windows input and output names', async () => {
    const devices = await discover(
      [input('in', 'MIDIIN2 (Elektron Syntakt)', 'Elektron')],
      [output('out', 'MIDIOUT2 (Elektron Syntakt)', 'Elektron')],
    );

    expect(devices.map(({ id }) => id)).toEqual(['["in","out"]']);
  });

  it('consumes duplicate same-named outputs once each', async () => {
    const devices = await discover(
      [input('in-1', 'Elektron Syntakt', 'Elektron'), input('in-2', 'Elektron Syntakt', 'Elektron')],
      [output('out-1', 'Elektron Syntakt', 'Elektron'), output('out-2', 'Elektron Syntakt', 'Elektron')],
    );

    expect(devices.map(({ id }) => id)).toEqual([
      '["in-1","out-1"]',
      '["in-2","out-2"]',
    ]);
  });

  it('does not pair blank names from different manufacturers', async () => {
    await expect(discover(
      [input('in', null, 'Elektron')],
      [output('out', null, 'Other')],
    )).rejects.toThrow("couldn't match an input to an output");
  });

  it('reports an absence only when no ports are present at all', async () => {
    await expect(discover([], [])).rejects.toThrow('No MIDI devices found');
  });

  it('uses a unique non-empty manufacturer when names do not match', async () => {
    const devices = await discover(
      [input('in', null, 'Elektron')],
      [output('out', null, 'Elektron')],
    );

    expect(devices.map(({ id }) => id)).toEqual(['["in","out"]']);
  });

  it('does not guess between same-manufacturer outputs', async () => {
    await expect(discover(
      [input('in', 'Syntakt input', 'Elektron')],
      [
        output('out-1', 'First output', 'Elektron'),
        output('out-2', 'Second output', 'Elektron'),
      ],
    )).rejects.toThrow("couldn't match an input to an output");
  });

  it.todo('rejects same-name ports whose non-empty manufacturers conflict');
});

describe('Web MIDI transport lifecycle', () => {
  it('opens the requested pair and forwards sends and copied incoming messages', async () => {
    const firstInput = input('in-1', 'Other', 'Other');
    const firstOutput = output('out-1', 'Other', 'Other');
    const syntaktInput = input('in-2', 'Elektron Syntakt', 'Elektron');
    const syntaktOutput = output('out-2', 'Elektron Syntakt', 'Elektron');
    const access = stubAccess([firstInput, syntaktInput], [firstOutput, syntaktOutput]);

    const { transport } = await WebMidiTransport.request('["in-2","out-2"]');
    expect(syntaktInput.open).toHaveBeenCalledOnce();
    expect(syntaktOutput.open).toHaveBeenCalledOnce();
    expect(firstInput.open).not.toHaveBeenCalled();
    expect(firstOutput.open).not.toHaveBeenCalled();

    const sent = Uint8Array.of(0xf0, 1, 0xf7);
    transport.send(sent);
    expect(syntaktOutput.send).toHaveBeenCalledWith(sent);

    const received: Uint8Array[] = [];
    transport.onMessage((message) => received.push(message));
    const source = Uint8Array.of(0xf0, 2, 0xf7);
    syntaktInput.onmidimessage?.({ data: source } as MIDIMessageEvent);
    source[1] = 99;
    expect(received).toEqual([Uint8Array.of(0xf0, 2, 0xf7)]);
    expect(access.onstatechange).not.toBeNull();
  });

  it('selects the Syntakt pair by default', async () => {
    const otherInput = input('other-in', 'Other', 'Other');
    const otherOutput = output('other-out', 'Other', 'Other');
    const syntaktInput = input('syntakt-in', 'Elektron Syntakt', 'Elektron');
    const syntaktOutput = output('syntakt-out', 'Elektron Syntakt', 'Elektron');
    stubAccess([otherInput, syntaktInput], [otherOutput, syntaktOutput]);

    await WebMidiTransport.request();

    expect(syntaktInput.open).toHaveBeenCalledOnce();
    expect(syntaktOutput.open).toHaveBeenCalledOnce();
    expect(otherInput.open).not.toHaveBeenCalled();
  });

  it('reports disconnection and removes handlers when closed', async () => {
    const midiInput = input('in', 'Elektron Syntakt', 'Elektron');
    const midiOutput = output('out', 'Elektron Syntakt', 'Elektron');
    const access = stubAccess([midiInput], [midiOutput]);
    const { transport } = await WebMidiTransport.request();
    const disconnected: Error[] = [];
    transport.onDisconnect((error) => disconnected.push(error));

    access.onstatechange?.({ port: { ...midiInput, state: 'disconnected' } } as unknown as MIDIConnectionEvent);
    expect(disconnected.map(({ message }) => message)).toEqual(['Syntakt MIDI port disconnected']);

    await transport.close();
    expect(midiInput.onmidimessage).toBeNull();
    expect(access.onstatechange).toBeNull();
    expect(midiInput.close).toHaveBeenCalledOnce();
    expect(midiOutput.close).toHaveBeenCalledOnce();
  });

  it('fails clearly when SysEx permission is rejected or unavailable', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn().mockRejectedValue(new Error('permission denied')) });
    await expect(WebMidiTransport.request()).rejects.toThrow('permission denied');

    vi.stubGlobal('navigator', {
      requestMIDIAccess: vi.fn().mockResolvedValue({ sysexEnabled: false, inputs: new Map(), outputs: new Map() }),
    });
    await expect(WebMidiTransport.request()).rejects.toThrow('SysEx permission was not granted');

    vi.stubGlobal('window', { isSecureContext: false });
    await expect(WebMidiTransport.request()).rejects.toThrow('secure HTTPS or localhost');
  });
});

async function discover(inputs: MIDIInput[], outputs: MIDIOutput[]) {
  stubAccess(inputs, outputs);
  return WebMidiTransport.discover();
}

function input(id: string, name: string | null, manufacturer: string | null): MIDIInput {
  return {
    id,
    name,
    manufacturer,
    onmidimessage: null,
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as MIDIInput;
}

function output(id: string, name: string | null, manufacturer: string | null): MIDIOutput {
  return {
    id,
    name,
    manufacturer,
    send: vi.fn(),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as MIDIOutput;
}

function stubAccess(inputs: MIDIInput[], outputs: MIDIOutput[]): MIDIAccess {
  const access = {
    sysexEnabled: true,
    inputs: new Map(inputs.map((port) => [port.id, port])),
    outputs: new Map(outputs.map((port) => [port.id, port])),
    onstatechange: null,
  } as unknown as MIDIAccess;
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn().mockResolvedValue(access) });
  return access;
}
