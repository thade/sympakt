import { ElektronSession } from './elektron-session.js';
import type { ElektronRequest } from './elektron-session.js';
import { readUint32BE, writeUint32BE } from './sysex-codec.js';
import { buildSyntaktDataSample, parseSyntaktDataSample, syntaktCrc32 } from './syntakt-data-sample.js';
import type { SyntaktDataSampleRead } from './syntakt-data-sample.js';
import { parseSyntaktSampleSlotList, SYNTAKT_SAMPLE_SLOT_COUNT } from './syntakt-slot-list.js';
import type { SyntaktSampleSlot } from './syntakt-slot-list.js';

// Confirmed on hardware running OS 1.40 and 1.40A.
export const SYNTAKT_DEVICE_ID = 0x1e;
/** Firmware versions proven safe for identity, listing, and sample reads. */
export const SYNTAKT_SUPPORTED_OS_VERSIONS = new Set(['1.40', '1.40A']);
/** Firmware versions proven live-safe for destructive sample operations. */
export const SYNTAKT_WRITE_SUPPORTED_OS_VERSIONS = new Set(['1.40', '1.40A']);
const DATA_SAMPLE_BLOCK_BYTES = 0x2000;
const MAX_DATA_SAMPLE_READ_BLOCKS = 128;
const MAX_DATA_SAMPLE_WRITE_BLOCKS = 128;

export interface SyntaktIdentity {
  deviceId: number;
  name: string;
  osVersion: string;
}

export interface SyntaktSlotFingerprint {
  name?: string;
  pcm16le?: Uint8Array;
  pcmSha256?: string;
  /** Only valid for the captured empty global-library sentinel. */
  empty?: boolean;
}

/** Exact device/firmware matrix captured and validated against hardware. */
export function assertSupportedSyntaktIdentity(identity: SyntaktIdentity): void {
  if (
    identity.deviceId !== SYNTAKT_DEVICE_ID
    || identity.name !== 'Syntakt'
    || !SYNTAKT_SUPPORTED_OS_VERSIONS.has(identity.osVersion)
  ) {
    throw new Error(`Syntakt OS ${identity.osVersion || 'unknown'} is not in the supported transfer matrix`);
  }
}

export function assertSyntaktWriteOsVersion(osVersion: string): void {
  if (!SYNTAKT_WRITE_SUPPORTED_OS_VERSIONS.has(osVersion)) {
    throw new Error(`Syntakt OS ${osVersion || 'unknown'} is read-only until direct-write conformance is complete`);
  }
}

export function assertSyntaktWriteIdentity(identity: SyntaktIdentity): void {
  assertSupportedSyntaktIdentity(identity);
  assertSyntaktWriteOsVersion(identity.osVersion);
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
}

export class SyntaktWriteStateUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SyntaktWriteStateUnknownError';
  }
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function commandAccepted(response: Uint8Array): boolean {
  return response.length > 5 && response[5] === 1;
}

function append(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function dataSamplePath(slot: number): Uint8Array {
  return new TextEncoder().encode(`/samples/${slot}\0`);
}

function dataSampleDirectoryPath(): Uint8Array {
  return new TextEncoder().encode('/samples/\0');
}

/**
 * Syntakt OS 1.40 and 1.40A data-sample client.
 *
 * The device exposes a slot-based global data-sample store, not a general
 * filesystem. `uploadSlot()` is deliberately narrow: it accepts only a
 * freshly inspected slot plus a matching backup-content proof.
 */
export class SyntaktDevice {
  private identity: SyntaktIdentity | null = null;

  constructor(private readonly session: ElektronSession) {}

  async identify(signal?: AbortSignal): Promise<SyntaktIdentity> {
    return this.identifyWith(this.session.request.bind(this.session), signal);
  }

  /** Download one global sample-library slot using the captured OS 1.40 reader flow. */
  async downloadSlot(slot: number, signal?: AbortSignal): Promise<SyntaktDataSampleRead> {
    this.requireIdentity();
    return this.downloadSlotWith(this.session.request.bind(this.session), slot, signal);
  }

  private async downloadSlotWith(
    request: ElektronRequest,
    slot: number,
    signal?: AbortSignal,
  ): Promise<SyntaktDataSampleRead> {
    if (!Number.isInteger(slot) || slot < 1 || slot > 64) throw new Error('Syntakt sample slots must be between 1 and 64');

    const open = await request(
      0x54,
      append(dataSamplePath(slot), writeUint32BE(DATA_SAMPLE_BLOCK_BYTES), Uint8Array.of(0)),
      { signal },
    );
    if (!commandAccepted(open) || open.length < 15) throw new Error(`Syntakt refused reader for sample slot ${slot}`);
    const readerId = readUint32BE(open, 6);
    const blockBytes = readUint32BE(open, 10);
    if (!readerId || blockBytes !== DATA_SAMPLE_BLOCK_BYTES || open[14] !== 0) {
      throw new Error('Unexpected Syntakt reader configuration');
    }

    const chunks: Uint8Array[] = [];
    let blockSequence = 0;
    let complete = false;
    for (let requestCount = 0; requestCount < MAX_DATA_SAMPLE_READ_BLOCKS; requestCount++) {
      const response = await request(0x55, append(writeUint32BE(readerId), writeUint32BE(blockSequence)), { signal });
      if (!commandAccepted(response) || response.length < 27) throw new Error('Syntakt rejected sample read');
      if (readUint32BE(response, 6) !== readerId) throw new Error('Syntakt reader response did not match its request');
      if (response[18] !== 0 && response[18] !== 1) throw new Error('Unknown Syntakt sample-read completion flag');
      const last = response[18] === 1;
      const dataBytes = readUint32BE(response, 23);
      if (dataBytes > blockBytes || response.length !== 27 + dataBytes) throw new Error('Malformed Syntakt sample-read block');
      // OS 1.40 returns one required empty reader-probe reply to block zero.
      // Its bytes 10–22 are a probe token, not the normal block fields.
      const initialProbe = blockSequence === 0 && dataBytes === 0;
      if (initialProbe && last) throw new Error('Syntakt reader ended before returning sample data');
      if (!initialProbe && readUint32BE(response, 10) !== blockSequence) {
        throw new Error('Syntakt reader response did not match its request');
      }
      if (!dataBytes && !initialProbe) throw new Error('Unexpected empty Syntakt sample-read block');
      if (dataBytes) chunks.push(response.slice(27));
      blockSequence++;
      if (last) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error('Syntakt sample reader exceeded its safe block limit');

    const close = await request(0x56, writeUint32BE(readerId), { signal });
    const data = append(...chunks);
    if (
      !commandAccepted(close)
      || close.length !== 14
      || readUint32BE(close, 6) !== readerId
      || readUint32BE(close, 10) !== data.length
    ) {
      throw new Error('Syntakt did not confirm reader close');
    }
    const parsed = parseSyntaktDataSample(data);
    if (parsed.slot !== slot) throw new Error(`Syntakt reader returned slot ${parsed.slot} for requested slot ${slot}`);
    return parsed;
  }

  /** List all global sample-library slots. This is not a free-slot or usage query. */
  async listSampleSlots(signal?: AbortSignal): Promise<SyntaktSampleSlot[]> {
    this.requireIdentity();
    return this.listSampleSlotsWith(this.session.request.bind(this.session), signal);
  }

  private async listSampleSlotsWith(
    request: ElektronRequest,
    signal?: AbortSignal,
  ): Promise<SyntaktSampleSlot[]> {
    // Captured OS 1.40 list arguments are start index 0, end index 0, and
    // the separate one-byte `all` flag set to 1. Sending end index 1 instead
    // yields a valid but empty response on the device.
    const response = await request(
      0x53,
      append(dataSampleDirectoryPath(), writeUint32BE(0), writeUint32BE(0), Uint8Array.of(1)),
      { signal },
    );
    const slots = parseSyntaktSampleSlotList(response);
    if (slots.length !== SYNTAKT_SAMPLE_SLOT_COUNT) throw new Error('Syntakt did not return all 64 sample-library slots');
    return slots;
  }

  /**
   * Write one explicitly selected global sample-library slot.
   *
   * A matching fresh inventory record is required. Any error after the writer
   * command may have reached the device, so the MIDI session is closed and the
   * caller must inspect before attempting another command.
   */
  async uploadSlot(
    slot: number,
    name: string,
    pcm16le: Uint8Array,
    expectedSlot: SyntaktSampleSlot,
    expectedContent: SyntaktSlotFingerprint,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const upload = buildSyntaktDataSample(slot, name, pcm16le);
    if (!expectedContent.empty && !expectedContent.pcm16le && !expectedContent.pcmSha256) {
      throw new Error('Syntakt write precondition is missing PCM evidence');
    }
    if (expectedContent.pcmSha256 && !/^[a-f0-9]{64}$/.test(expectedContent.pcmSha256)) {
      throw new Error('Invalid Syntakt write precondition hash');
    }
    const expected = {
      name: expectedContent.name,
      pcm16le: expectedContent.pcm16le
        ? new Uint8Array(expectedContent.pcm16le)
        : undefined,
      pcmSha256: expectedContent.pcmSha256,
      empty: expectedContent.empty === true,
    };
    let writeAttempted = false;
    try {
      await this.session.exclusive(async (request) => {
        const identity = await this.identifyWith(request, signal);
        assertSyntaktWriteIdentity(identity);
        const currentSlot = (await this.listSampleSlotsWith(request, signal))
          .find((entry) => entry.slot === slot);
        if (!currentSlot || !sameSlotRecord(currentSlot, expectedSlot)) {
          throw new Error(
            'That slot changed on the device, so nothing was written. Refresh slots and try again.',
          );
        }
        const current = await this.downloadSlotWith(request, slot, signal);
        if (
          (expected.empty && !current.empty)
          || (!expected.empty && (
            current.empty
            || !expected.name
            || current.name !== expected.name
            || !(await contentMatches(current.pcm16le, expected))
          ))
        ) {
          throw new Error(`Slot ${slot} changed after the backup, so nothing was written. Refresh slots and try again.`);
        }

        const totalBytes = upload.content.length + upload.footer.length;
        writeAttempted = true;
        const open = await request(0x57, append(writeUint32BE(totalBytes), dataSamplePath(slot)), { signal });
        if (!commandAccepted(open) || open.length < 10) throw new Error(`Syntakt refused writer for sample slot ${slot}`);
        const writerId = readUint32BE(open, 6);
        if (!writerId) throw new Error('Unexpected Syntakt writer configuration');

        let sequence = 0;
        let sentBytes = 0;
        for (const part of [upload.content, upload.footer]) {
          for (let offset = 0; offset < part.length; offset += DATA_SAMPLE_BLOCK_BYTES) {
            if (sequence >= MAX_DATA_SAMPLE_WRITE_BLOCKS) {
              throw new Error('Syntakt sample writer exceeded its safe block limit');
            }
            const block = part.slice(offset, Math.min(offset + DATA_SAMPLE_BLOCK_BYTES, part.length));
            const response = await request(
              0x58,
              append(
                writeUint32BE(writerId),
                writeUint32BE(sequence),
                writeUint32BE(syntaktCrc32(block)),
                writeUint32BE(block.length),
                block,
              ),
              { signal },
            );
            if (!commandAccepted(response) || response.length < 18) throw new Error('Syntakt rejected sample write block');
            if (
              readUint32BE(response, 6) !== writerId
              || readUint32BE(response, 10) !== sequence
            ) {
              throw new Error('Syntakt writer response did not match its request');
            }
            sentBytes += block.length;
            if (readUint32BE(response, 14) !== sentBytes) {
              throw new Error('Syntakt writer did not confirm the expected byte total');
            }
            onProgress({ sentBytes, totalBytes });
            sequence++;
          }
        }

        const close = await request(0x59, append(writeUint32BE(writerId), writeUint32BE(totalBytes)), { signal });
        if (
          !commandAccepted(close)
          || close.length < 14
          || readUint32BE(close, 6) !== writerId
          || readUint32BE(close, 10) !== totalBytes
        ) {
          throw new Error('Syntakt did not confirm writer close');
        }
      });
    } catch (error) {
      if (!writeAttempted) throw error;
      await this.session.close().catch(() => undefined);
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new SyntaktWriteStateUnknownError(
        `The write may not have finished (${detail}). `
        + 'Sympakt disconnected — check that slot on the Syntakt before continuing.',
        { cause: error },
      );
    }
  }

  /**
   * Clear one exact global-library slot using the OS 1.40 captured delete
   * command. The target is re-identified, re-listed, checked by content, and
   * read back as the exact empty sentinel before this call returns.
   */
  async clearSlot(
    slot: number,
    expectedSlot: SyntaktSampleSlot,
    expectedContent: SyntaktSlotFingerprint,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!expectedContent.empty && !expectedContent.pcm16le && !expectedContent.pcmSha256) {
      throw new Error('Syntakt clear precondition is missing PCM evidence');
    }
    let clearAttempted = false;
    try {
      await this.session.exclusive(async (request) => {
        const identity = await this.identifyWith(request, signal);
        assertSyntaktWriteIdentity(identity);
        const currentSlot = (await this.listSampleSlotsWith(request, signal))
          .find((entry) => entry.slot === slot);
        if (!currentSlot || !sameSlotRecord(currentSlot, expectedSlot)) {
          throw new Error(
            'That slot changed on the device, so nothing was cleared. Refresh slots and try again.',
          );
        }
        const current = await this.downloadSlotWith(request, slot, signal);
        const matches = expectedContent.empty === true
          ? current.empty
          : !current.empty
            && !!expectedContent.name
            && current.name === expectedContent.name
            && await contentMatches(current.pcm16le, expectedContent);
        if (!matches) throw new Error(`Syntakt slot ${slot} changed before clear; clear was not opened`);
        clearAttempted = true;
        const response = await request(0x5c, dataSamplePath(slot), { signal });
        if (response.length !== 6 || !commandAccepted(response)) throw new Error(`Syntakt refused clear for sample slot ${slot}`);
        const readback = await this.downloadSlotWith(request, slot, signal);
        if (!readback.empty) throw new Error(`Syntakt slot ${slot} did not read back as empty after clear`);
      });
    } catch (error) {
      if (!clearAttempted) throw error;
      await this.session.close().catch(() => undefined);
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new SyntaktWriteStateUnknownError(
        `The clear may not have finished (${detail}). `
        + 'Sympakt disconnected — check that slot on the Syntakt before continuing.',
        { cause: error },
      );
    }
  }

  private requireIdentity(): void {
    if (!this.identity) throw new Error('Identify the Syntakt before accessing storage');
  }

  private async identifyWith(request: ElektronRequest, signal?: AbortSignal): Promise<SyntaktIdentity> {
    const ping = await request(0x01, undefined, { signal });
    const version = await request(0x02, undefined, { signal });
    const identity = parseSyntaktIdentity(ping, version);
    assertSupportedSyntaktIdentity(identity);
    this.identity = identity;
    return identity;
  }
}

function parseSyntaktIdentity(ping: Uint8Array, version: Uint8Array): SyntaktIdentity {
  const capturedName = new TextEncoder().encode('Syntakt\0');
  const requiredCommands = [0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5c];
  const descriptorLength = ping[6];
  const nameOffset = 7 + descriptorLength;
  if (ping.length !== 37 || ping[4] !== 0x81 || descriptorLength === 0 || nameOffset + capturedName.length !== ping.length
    || !bytesEqual(ping.slice(nameOffset), capturedName)
    || requiredCommands.some((command) => !ping.slice(7, nameOffset).includes(command))) {
    throw new Error('Unexpected Syntakt identity response');
  }
  const legacyLayout = version.length === 15
    && text(version.slice(5, 9)) === '0082'
    && version[9] === 0
    && text(version.slice(10, 14)) === '1.40'
    && version[14] === 0;
  // Exact OS 1.40A layout captured from the connected Syntakt.
  const layout140A = version.length === 16
    && text(version.slice(5, 9)) === '0086'
    && version[9] === 0
    && text(version.slice(10, 15)) === '1.40A'
    && version[15] === 0;
  if (version[4] !== 0x82 || (!legacyLayout && !layout140A)) {
    console.error(
      'Unexpected Syntakt version response',
      `${version.length} bytes:`,
      [...version].map((value) => value.toString(16).padStart(2, '0')).join(' '),
    );
    throw new Error("Couldn't read the Syntakt OS version.");
  }
  return { deviceId: ping[5], name: 'Syntakt', osVersion: legacyLayout ? '1.40' : '1.40A' };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder('windows-1252').decode(bytes).replace(/\0.*$/, '');
}

async function contentMatches(
  pcm16le: Uint8Array,
  expected: { pcm16le?: Uint8Array; pcmSha256?: string },
): Promise<boolean> {
  if (expected.pcm16le && !bytesEqual(pcm16le, expected.pcm16le)) return false;
  if (!expected.pcmSha256) return true;
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure SHA-256 support is required for Syntakt write preconditions');
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(pcm16le)));
  const actual = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return actual === expected.pcmSha256;
}

function sameSlotRecord(left: SyntaktSampleSlot, right: SyntaktSampleSlot): boolean {
  return left.slot === right.slot
    && left.name === right.name
    && left.storedBytes === right.storedBytes
    && left.operations === right.operations
    && left.hasData === right.hasData
    && left.hasMetadata === right.hasMetadata;
}
