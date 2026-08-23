import { describe, expect, it } from 'vitest';
import { partialMD5, partialMD5OfBytes } from '@/utils/md5';

/**
 * `partialMD5OfBytes` is the server-side twin of `partialMD5`: the Yandex
 * server runner hashes downloaded EPUB bytes without a File object, and the
 * result must be byte-identical to the client import hash (which Tauri
 * computes in Rust with the same range semantics — see
 * src-tauri/src/parser_common.rs). These tests pin the equivalence.
 */
describe('partialMD5OfBytes', () => {
  const makeBytes = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    // Deterministic pseudo-random fill (no Math.random in fixtures).
    let x = 123456789;
    for (let i = 0; i < size; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      bytes[i] = x & 0xff;
    }
    return bytes;
  };

  it.each([
    0, // empty file: no ranges, hash of nothing
    1, // below the 1 KiB chunk
    1023,
    1024, // exactly one chunk
    1025,
    2048, // two chunks
    4096,
    65536, // i = 3 range start
    1024 * 1024, // i = 5: 1024 << 10 stays in i32
    16 * 1024 * 1024, // i = 7: shift overflows i32 (mirrors the Rust wrapping_shl)
    200 * 1024 + 123, // arbitrary size crossing several ranges
  ])('matches the File-based partialMD5 for a %d-byte buffer', async (size) => {
    const bytes = makeBytes(size);
    const fromBytes = await partialMD5OfBytes(bytes);
    const fromFile = await partialMD5(new File([bytes.slice()], 'fixture.epub'));
    expect(fromBytes).toBe(fromFile);
  });

  it('hashes an empty buffer to the well-known empty md5', async () => {
    expect(await partialMD5OfBytes(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('does not mutate the input buffer', async () => {
    const bytes = makeBytes(5000);
    const snapshot = bytes.slice();
    await partialMD5OfBytes(bytes);
    expect(bytes).toEqual(snapshot);
  });
});
