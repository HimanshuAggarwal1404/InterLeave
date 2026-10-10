// Helpers for byte-level tests. Not a test file itself.

// bytes builds a Buffer from parts. A string part is taken one character per
// byte ('latin1'), like a Go string literal: "SELECT 1\x00" is 9 bytes.
export function bytes(...parts: Array<string | number[] | Buffer>): Buffer {
  return Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Array.isArray(p) ? Buffer.from(p) : p)),
  );
}

// chunksOf yields data in pieces of at most size bytes, the way a socket may
// deliver it. size 1 is the worst case: every byte arrives on its own.
export async function* chunksOf(data: Buffer, size = data.length): AsyncGenerator<Buffer> {
  const step = Math.max(size, 1);
  for (let i = 0; i < data.length; i += step) {
    yield data.subarray(i, i + step);
  }
}

// hex formats bytes like Go's % x verb ("51 00 00 00 0d"), for readable failures.
export function hex(b: Buffer): string {
  return b.toString('hex').replace(/(..)(?!$)/g, '$1 ');
}
