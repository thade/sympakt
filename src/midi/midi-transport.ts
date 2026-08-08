/** Minimal MIDI transport shared by Web MIDI and deterministic protocol tests. */
export interface MidiTransport {
  send(data: Uint8Array): void;
  onMessage(listener: (data: Uint8Array) => void): () => void;
  onDisconnect(listener: (reason: Error) => void): () => void;
  close(): Promise<void>;
}

export class MidiTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MidiTransportError';
  }
}
