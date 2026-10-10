// log writes one line to stderr with a timestamp, in the format of Go's log
// package ("2026/10/10 18:30:05 message"), so logs read the same as before.
export function log(message: string): void {
  process.stderr.write(`${timestamp(new Date())} ${message}\n`);
}

function timestamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// errorMessage returns err's message, for errors of unknown type (anything can be thrown in JavaScript).
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
