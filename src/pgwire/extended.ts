// The extended query protocol's frontend messages, as far as the proxy needs
// them to schedule a statement (D-036). An app that passes values separately
// (node-postgres with a values array, every ORM) sends, per statement:
//   Parse   (name, SQL)          prepare the SQL as a named or unnamed statement
//   Bind    (portal, statement)  fill in the values: a ready-to-run portal
//   Describe / Execute (portal)  run it (Execute is where it really runs)
//   Sync                         end of the group; Postgres answers ReadyForQuery
// A prepared statement may be reused later without a new Parse, so the proxy
// remembers statement name -> SQL and portal -> statement. Only the parts it
// needs are parsed; the bytes are forwarded unchanged.
import { ProtocolError, quoteByte, type Message } from './message.ts';

// cstring reads a NUL-terminated string at pos and returns it with the
// position after its NUL.
function cstring(m: Message, pos: number, what: string): [string, number] {
  const end = m.body.indexOf(0, pos);
  if (end < 0) {
    throw new ProtocolError(`${what}: missing NUL after a string`);
  }
  return [m.body.toString('utf8', pos, end), end + 1];
}

function expect(m: Message, type: string, name: string): void {
  if (m.type !== type) {
    throw new ProtocolError(`message ${quoteByte(m.type)} is not ${name}`);
  }
}

// parseStatement reads a 'P' Parse: the statement name ('' = unnamed) and its SQL.
export function parseStatement(m: Message): { name: string; query: string } {
  expect(m, 'P', 'Parse');
  const [name, pos] = cstring(m, 0, 'Parse');
  const [query] = cstring(m, pos, 'Parse');
  return { name, query };
}

// bindPortal reads a 'B' Bind: the portal it creates and the statement it uses.
export function bindPortal(m: Message): { portal: string; statement: string } {
  expect(m, 'B', 'Bind');
  const [portal, pos] = cstring(m, 0, 'Bind');
  const [statement] = cstring(m, pos, 'Bind');
  return { portal, statement };
}

// executePortal reads a frontend 'E' Execute: the portal to run and the row
// limit (0 = all rows).
export function executePortal(m: Message): { portal: string; maxRows: number } {
  expect(m, 'E', 'Execute');
  const [portal, pos] = cstring(m, 0, 'Execute');
  if (m.body.length !== pos + 4) {
    throw new ProtocolError('Execute: want an int32 row limit after the portal name');
  }
  return { portal, maxRows: m.body.readInt32BE(pos) };
}

// closeTarget reads a frontend 'C' Close: 'S' closes a statement, 'P' a portal.
export function closeTarget(m: Message): { kind: 'S' | 'P'; name: string } {
  expect(m, 'C', 'Close');
  const kind = String.fromCharCode(m.body[0] ?? 0);
  if (kind !== 'S' && kind !== 'P') {
    throw new ProtocolError(`Close: want 'S' or 'P', got ${quoteByte(kind)}`);
  }
  const [name] = cstring(m, 1, 'Close');
  return { kind, name };
}
