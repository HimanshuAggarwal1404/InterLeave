// BackendKeyData ('K'): sent once during startup. It carries the backend
// process ID, which identifies the connection's server process in Postgres's
// own views (pg_stat_activity, pg_locks, pg_blocking_pids): lock-wait
// detection asks about that PID. The secret key is for cancel requests.
import { ProtocolError, quoteByte, type Message } from './message.ts';

export type BackendKey = { pid: number; secretKey: Buffer };

// The secret key is 4 bytes in protocol 3.0 and 4-256 bytes in 3.2.
const MAX_SECRET_KEY = 256;

export function backendKeyData(m: Message): BackendKey {
  if (m.type !== 'K') {
    throw new ProtocolError(`message ${quoteByte(m.type)} is not BackendKeyData`);
  }
  const keyLength = m.body.length - 4;
  if (keyLength < 4 || keyLength > MAX_SECRET_KEY) {
    throw new ProtocolError(`BackendKeyData: secret key of ${keyLength} bytes, want 4-${MAX_SECRET_KEY}`);
  }
  return { pid: m.body.readInt32BE(0), secretKey: Buffer.from(m.body.subarray(4)) };
}
