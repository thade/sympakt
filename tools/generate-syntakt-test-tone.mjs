#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const outputPath = process.argv[2];
if (!outputPath || process.argv.length !== 3) {
  console.error('Usage: generate-syntakt-test-tone.mjs OUTPUT.wav');
  process.exit(64);
}

const sampleRate = 48_000;
const frames = Math.round(sampleRate * 0.25);
const pcm = new Int16Array(frames);
for (let index = 0; index < frames; index += 1) {
  const envelope = Math.min(1, index / 200, (frames - index) / 400);
  pcm[index] = Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.2 * envelope * 0x7fff);
}

const wav = new ArrayBuffer(44 + pcm.byteLength);
const view = new DataView(wav);
const write = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
write(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); write(8, 'WAVE');
write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
write(36, 'data'); view.setUint32(40, pcm.byteLength, true);
new Uint8Array(wav, 44).set(new Uint8Array(pcm.buffer));
writeFileSync(outputPath, new Uint8Array(wav), { flag: 'wx' });
