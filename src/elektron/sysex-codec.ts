const HEADER = Uint8Array.of(0xf0, 0x00, 0x20, 0x3c, 0x10, 0x00);

export const ELEKTRON_SYSEX_HEADER = HEADER;

export function pack7Bit(payload: Uint8Array): Uint8Array {
  const packed = new Uint8Array(payload.length + Math.ceil(payload.length / 7));
  let source = 0;
  let target = 0;
  while (source < payload.length) {
    let msbs = 0;
    const groupStart = target++;
    for (let bit = 0; bit < 7 && source < payload.length; bit++, source++) {
      if (payload[source] & 0x80) msbs |= 1 << (6 - bit);
      packed[target++] = payload[source] & 0x7f;
    }
    packed[groupStart] = msbs;
  }
  return packed;
}

export function unpack7Bit(packed: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  for (let source = 0; source < packed.length; source += 8) {
    const msbs = packed[source];
    for (let bit = 0; bit < 7 && source + bit + 1 < packed.length; bit++) {
      bytes.push(packed[source + bit + 1] | ((msbs & (1 << (6 - bit))) ? 0x80 : 0));
    }
  }
  return new Uint8Array(bytes);
}

export function encodeElektronSysex(payload: Uint8Array): Uint8Array {
  const packed = pack7Bit(payload);
  const result = new Uint8Array(HEADER.length + packed.length + 1);
  result.set(HEADER);
  result.set(packed, HEADER.length);
  result[result.length - 1] = 0xf7;
  return result;
}

export function decodeElektronSysex(message: Uint8Array): Uint8Array | null {
  if (message.length < HEADER.length + 2 || message[message.length - 1] !== 0xf7) return null;
  for (let i = 0; i < HEADER.length; i++) if (message[i] !== HEADER[i]) return null;
  return unpack7Bit(message.slice(HEADER.length, -1));
}

export function readUint32BE(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

export function writeUint32BE(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}
