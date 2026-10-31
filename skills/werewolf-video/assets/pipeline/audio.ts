import { readFile } from 'node:fs/promises';
export interface Pcm { samples: Int16Array; sampleRate: number }
export async function readPcm(file: string): Promise<Pcm> {
  const b = await readFile(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw Error(`Not a WAV: ${file}`);
  let format = 0, channels = 0, sampleRate = 0, bits = 0, data: Buffer | undefined;
  for (let at = 12; at + 8 <= b.length;) {
    const name = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4), start = at + 8;
    if (name === 'fmt ') { format = b.readUInt16LE(start); channels = b.readUInt16LE(start + 2); sampleRate = b.readUInt32LE(start + 4); bits = b.readUInt16LE(start + 14); }
    if (name === 'data') data = b.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  if (format !== 1 || bits !== 16 || channels !== 1 || !data || data.length % 2) throw Error(`Expected mono PCM16 WAV: ${file}`);
  const samples = new Int16Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { samples, sampleRate };
}
export function wavHeader(sampleCount: number, sampleRate: number) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + sampleCount * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(sampleCount * 2, 40); return h;
}
