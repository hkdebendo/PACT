// Evidence files on local disk under data/evidence/, addressed by sha256 content hash.
// Sanitisation: size limit, magic-byte sniffing for images (the declared mime is not trusted),
// UTF-8 / no-NUL check for text, and filenames reduced to a safe character set.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { IMAGE_MIMES, MAX_EVIDENCE_BYTES, TEXT_MIMES } from '@pact/llm';

export class EvidenceRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceRejected';
  }
}

const TEXT_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.js': 'text/javascript',
  '.py': 'text/x-python',
  '.html': 'text/html',
};

export function sniffMime(bytes: Buffer, filename: string): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  const ext = extname(filename).toLowerCase();
  if (TEXT_EXT[ext]) {
    if (bytes.includes(0)) return null;
    const text = bytes.toString('utf8');
    if (text.includes('�')) return null; // invalid UTF-8
    return TEXT_EXT[ext];
  }
  return null;
}

export const safeFilename = (name: string) =>
  (name.split(/[\\/]/).pop() ?? 'evidence').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 96) || 'evidence';

export interface StoredEvidence {
  sha256: string;
  mime: string;
  size: number;
  path: string;
  filename: string;
}

export function storeEvidence(dir: string, filename: string, bytes: Buffer): StoredEvidence {
  if (!bytes.length) throw new EvidenceRejected('Evidence file is empty.');
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new EvidenceRejected(`Evidence exceeds ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB.`);
  const clean = safeFilename(filename);
  const mime = sniffMime(bytes, clean);
  if (!mime || ![...IMAGE_MIMES, ...TEXT_MIMES].includes(mime))
    throw new EvidenceRejected('Unsupported evidence file. Accepted: PNG, JPEG, WebP, GIF images and UTF-8 text/code/JSON/CSV files.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sub = resolve(dir, sha256.slice(0, 2));
  mkdirSync(sub, { recursive: true });
  const ext = IMAGE_MIMES.includes(mime) ? `.${mime.split('/')[1].replace('jpeg', 'jpg')}` : extname(clean) || '.txt';
  const path = resolve(sub, `${sha256}${ext}`);
  if (!existsSync(path)) writeFileSync(path, bytes);
  return { sha256, mime, size: bytes.length, path, filename: clean };
}

export const readEvidence = (path: string) => readFileSync(path);
