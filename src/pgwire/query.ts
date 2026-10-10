import { ProtocolError, quoteByte, type Message } from './message.ts';

// queryString returns the SQL text of a 'Q' (simple Query) message. The body
// is the text followed by exactly one NUL byte, as in a C string.
export function queryString(m: Message): string {
  if (m.type !== 'Q') {
    throw new ProtocolError(`message ${quoteByte(m.type)} is not a Query`);
  }
  const end = m.body.indexOf(0);
  if (m.body.length === 0 || end !== m.body.length - 1) {
    throw new ProtocolError("query: SQL text must end with the message's only NUL byte");
  }
  return m.body.toString('utf8', 0, end);
}
