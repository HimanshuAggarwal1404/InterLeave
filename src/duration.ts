// Durations written the way Go's flag package does ("3s", "500ms", "1m30s"),
// used by the bench and the interleave command's flags. Values are in ms.

const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };

// parseDuration reads a duration the way Go's flag package does ("3s",
// "100ms", "1m30s", "2.5s") and returns milliseconds. It throws on anything else.
export function parseDuration(text: string): number {
  if (text === '0') {
    return 0;
  }
  const parts = [...text.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/g)];
  if (parts.length === 0 || parts.map((m) => m[0]).join('') !== text) {
    throw new Error(`invalid duration ${JSON.stringify(text)} (examples: 10s, 500ms, 1m30s)`);
  }
  return parts.reduce((ms, m) => ms + Number(m[1]) * UNIT_MS[m[2]], 0);
}

// formatDuration prints milliseconds rounded to the microsecond, like Go's
// Duration.String after Round(time.Microsecond): 577µs, 1.259ms, 10s, 1m30s.
export function formatDuration(ms: number): string {
  const us = Math.round(ms * 1000);
  if (us === 0) {
    return '0s';
  }
  if (us < 1000) {
    return `${us}µs`;
  }
  if (us < 1_000_000) {
    return `${trimZeros((us / 1000).toFixed(3))}ms`;
  }
  const minutes = Math.floor(us / 60_000_000);
  const seconds = `${trimZeros(((us % 60_000_000) / 1_000_000).toFixed(6))}s`;
  return minutes > 0 ? `${minutes}m${seconds}` : seconds;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
