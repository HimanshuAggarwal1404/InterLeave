// Parsers for the backend messages that describe what a statement did. The
// scheduler shows them in the report ("UPDATE 1", "SELECT -> 0") and uses the
// error code to spot deadlocks (40P01).
import { ProtocolError, quoteByte, type Message } from './message.ts';

// commandTag returns the tag of a 'C' (CommandComplete) message, e.g.
// "UPDATE 1" or "SELECT 3": the command and the number of rows it touched.
export function commandTag(m: Message): string {
  if (m.type !== 'C') {
    throw new ProtocolError(`message ${quoteByte(m.type)} is not CommandComplete`);
  }
  const end = m.body.indexOf(0);
  if (end !== m.body.length - 1) {
    throw new ProtocolError('CommandComplete: tag must end with the message\'s only NUL byte');
  }
  return m.body.toString('utf8', 0, end);
}

// firstColumn returns the first column of a 'D' (DataRow) message as text
// (the simple query protocol sends every value as text), null for a NULL, or
// undefined for a row without columns.
export function firstColumn(m: Message): string | null | undefined {
  if (m.type !== 'D') {
    throw new ProtocolError(`message ${quoteByte(m.type)} is not DataRow`);
  }
  if (m.body.length < 2) {
    throw new ProtocolError('DataRow: too short for its column count');
  }
  const columns = m.body.readInt16BE(0);
  if (columns === 0) {
    return undefined;
  }
  if (m.body.length < 6) {
    throw new ProtocolError('DataRow: too short for its first column length');
  }
  const length = m.body.readInt32BE(2); // signed: -1 means NULL
  if (length === -1) {
    return null;
  }
  if (length < 0 || 6 + length > m.body.length) {
    throw new ProtocolError(`DataRow: first column length ${length} does not fit the message`);
  }
  return m.body.toString('utf8', 6, 6 + length);
}

// ErrorInfo is the part of an ErrorResponse the scheduler uses.
export type ErrorInfo = { code: string; message: string };

// errorFields returns the SQLSTATE code ('C' field) and message ('M' field)
// of an 'E' (ErrorResponse) message. The body is a list of fields, each a type
// byte and a NUL-terminated string, ended by a single 0 byte.
export function errorFields(m: Message): ErrorInfo {
  if (m.type !== 'E') {
    throw new ProtocolError(`message ${quoteByte(m.type)} is not ErrorResponse`);
  }
  let code = '';
  let message = '';
  let pos = 0;
  for (;;) {
    if (pos >= m.body.length) {
      throw new ProtocolError('ErrorResponse: field list not terminated');
    }
    const field = m.body[pos];
    if (field === 0) {
      return { code, message };
    }
    const end = m.body.indexOf(0, pos + 1);
    if (end < 0) {
      throw new ProtocolError('ErrorResponse: field value not terminated');
    }
    const value = m.body.toString('utf8', pos + 1, end);
    if (field === 0x43) {
      code = value; // 'C'
    } else if (field === 0x4d) {
      message = value; // 'M'
    }
    pos = end + 1;
  }
}
