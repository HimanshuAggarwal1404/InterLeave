import { ProtocolError, quoteByte, type Message } from './message.ts';

// ReadyStatus is the status byte of ReadyForQuery: 'I' idle, 'T' inside a
// transaction block, 'E' inside a failed transaction block.
export type ReadyStatus = 'I' | 'T' | 'E';

// readyStatus returns the status of a 'Z' (ReadyForQuery) message, which
// Postgres sends when it has finished a query and waits for the next one.
export function readyStatus(m: Message): ReadyStatus {
  if (m.type !== 'Z') {
    throw new ProtocolError(`message ${quoteByte(m.type)} is not ReadyForQuery`);
  }
  if (m.body.length !== 1) {
    throw new ProtocolError(`ReadyForQuery: body is ${m.body.length} bytes, want 1`);
  }
  const s = String.fromCharCode(m.body[0]);
  // Comparing against each literal lets TypeScript narrow s from string to ReadyStatus.
  if (s === 'I' || s === 'T' || s === 'E') {
    return s;
  }
  throw new ProtocolError(`ReadyForQuery: unknown status ${quoteByte(s)}`);
}
