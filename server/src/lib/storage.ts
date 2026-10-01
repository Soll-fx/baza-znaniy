/**
 * Файловое хранилище: контент-адресная раскладка + sha256.
 * Одинаковые картинки не дублируются, валидатор может сверить контрольную сумму.
 */
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

export const ASSETS_DIR = path.join(config.storageDir, 'assets');

export function mimeFor(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function kindFor(mime: string): 'image' | 'document' | 'spreadsheet' | 'archive' | 'other' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') return 'spreadsheet';
  if (mime.includes('zip') || mime.includes('compressed') || mime === 'application/x-rar-compressed' || mime === 'application/rar') return 'archive';
  if (mime.startsWith('text/') || mime.includes('word') || mime === 'application/pdf') return 'document';
  return 'other';
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** assets/<2 символа>/<2 символа>/<sha256>.<ext> */
export function storageKeyFor(checksum: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  return `assets/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}${ext}`;
}

/** Абсолютный путь с защитой от выхода за пределы storage (path traversal). */
export function resolveOnDisk(storageKey: string): string {
  const abs = path.resolve(config.storageDir, storageKey);
  const root = path.resolve(config.storageDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Недопустимый storage_key: ${storageKey}`);
  }
  return abs;
}

export interface StoredFile {
  storageKey: string;
  checksum: string;
  bytes: number;
  mime: string;
  kind: ReturnType<typeof kindFor>;
}

/** Сохраняет файл, если его ещё нет. Идемпотентно. */
export async function saveBuffer(buf: Buffer, filename: string): Promise<StoredFile> {
  const checksum = sha256(buf);
  const storageKey = storageKeyFor(checksum, filename);
  const abs = resolveOnDisk(storageKey);

  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.access(abs);
  } catch {
    await fs.writeFile(abs, buf);
  }

  const mime = mimeFor(filename);
  return { storageKey, checksum, bytes: buf.byteLength, mime, kind: kindFor(mime) };
}

export async function fileExists(storageKey: string): Promise<boolean> {
  try {
    await fs.access(resolveOnDisk(storageKey));
    return true;
  } catch {
    return false;
  }
}

export async function readStored(storageKey: string): Promise<Buffer> {
  return fs.readFile(resolveOnDisk(storageKey));
}

/**
 * Поток файла с диска для отдачи клиенту. Файлы в базе — это .doc и картинки,
 * поэтому читать их целиком в память нельзя: один запрос на крупный документ
 * съедал бы весь доступный heap, а на бесплатном хостинге он ограничен.
 */
export function streamStored(storageKey: string): ReadStream {
  return createReadStream(resolveOnDisk(storageKey));
}

/** Сверяет размер и sha256 файла на диске с записью в БД. */
export async function verifyIntegrity(
  storageKey: string,
  expected: { checksum: string; bytes: number },
): Promise<{ ok: boolean; reason?: string; actualChecksum?: string }> {
  let abs: string;
  try {
    abs = resolveOnDisk(storageKey);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return { ok: false, reason: 'файл отсутствует на диске' };
  }

  const actual = sha256(buf);
  if (actual !== expected.checksum) {
    return { ok: false, reason: 'несовпадение sha256', actualChecksum: actual };
  }
  if (buf.byteLength !== Number(expected.bytes)) {
    return { ok: false, reason: `размер ${buf.byteLength} != ${expected.bytes}` };
  }
  return { ok: true, actualChecksum: actual };
}

/** Размеры изображения (best-effort, без внешних нативных зависимостей). */
export async function imageSize(buf: Buffer): Promise<{ width: number; height: number } | null> {
  if (buf.length < 24) return null;
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: идём по сегментам до SOFn
  if (buf.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1]!;
      const len = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + len;
    }
  }
  return null;
}

export async function ensureStorage(): Promise<void> {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
}

export function fileUrlToPathSpec(fileUrl: string): string {
  return fileURLToPath(fileUrl);
}
