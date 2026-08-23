import { md5 } from 'js-md5';

export function isMd5(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

export function md5Fingerprint(value: string): string {
  return md5(value).slice(0, 7);
}

// The sampled ranges depend only on the file size. Kept shared so the
// server-side byte-buffer variant below hashes identically to the File one
// (and to Rust's compute_partial_md5, which mirrors the same JS shift
// semantics — `1024 << (2 * i)` masks the shift count to 5 bits and
// overflows to 0 for i >= 5).
const partialMd5Ranges = (fileSize: number): Array<[number, number]> => {
  const step = 1024;
  const size = 1024;

  const ranges: Array<[number, number]> = [];
  for (let i = -1; i <= 10; i++) {
    const start = Math.min(fileSize, step << (2 * i));
    const end = Math.min(start + size, fileSize);
    if (start >= fileSize) break;
    ranges.push([start, end]);
  }
  return ranges;
};

export async function partialMD5(file: File): Promise<string> {
  const chunks = await Promise.all(
    partialMd5Ranges(file.size).map(([start, end]) => file.slice(start, end).arrayBuffer()),
  );
  const hasher = md5.create();
  for (const buf of chunks) {
    hasher.update(new Uint8Array(buf));
  }
  return hasher.hex();
}

/**
 * Same partialMD5 over a raw byte buffer instead of a File — used by the
 * server-side Yandex download runner, where the downloaded EPUB exists only
 * as bytes and the hash must match what a client import would produce.
 */
export async function partialMD5OfBytes(bytes: Uint8Array): Promise<string> {
  const hasher = md5.create();
  for (const [start, end] of partialMd5Ranges(bytes.byteLength)) {
    hasher.update(bytes.subarray(start, end));
  }
  return hasher.hex();
}

export { md5 };
