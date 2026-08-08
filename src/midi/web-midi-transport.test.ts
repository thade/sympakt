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
});

async function discover(inputs: MIDIInput[], outputs: MIDIOutput[]) {
  const access = {
    sysexEnabled: true,
    inputs: new Map(inputs.map((port) => [port.id, port])),
    outputs: new Map(outputs.map((port) => [port.id, port])),
  } as unknown as MIDIAccess;
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn().mockResolvedValue(access) });
  return WebMidiTransport.discover();
}

function input(id: string, name: string | null, manufacturer: string | null): MIDIInput {
  return { id, name, manufacturer } as MIDIInput;
}

function output(id: string, name: string | null, manufacturer: string | null): MIDIOutput {
  return { id, name, manufacturer } as MIDIOutput;
}
