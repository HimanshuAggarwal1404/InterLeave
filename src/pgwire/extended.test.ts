// Spec for the extended-protocol frontend messages the proxy reads (D-036):
// Parse, Bind, Execute and Close, as captured byte sequences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindPortal, closeTarget, executePortal, parseStatement, type Message } from './index.ts';
import { bytes } from '../testutil/bytes.ts';

function msg(type: string, body: Buffer): Message {
  return { type, body, raw: body };
}

test('ParseStatement', () => {
  // 'P' Parse body: statement name (NUL-terminated, '' = unnamed), query text
  // (NUL-terminated), int16 number of parameter types, then that many int32 OIDs.
  const unnamed = bytes('\x00', '/* il:req=A */ SELECT $1::int\x00', [0x00, 0x01, 0x00, 0x00, 0x00, 0x17]);
  assert.deepEqual(parseStatement(msg('P', unnamed)), { name: '', query: '/* il:req=A */ SELECT $1::int' });
  const named = bytes('s1\x00', 'SELECT 1\x00', [0x00, 0x00]);
  assert.deepEqual(parseStatement(msg('P', named)), { name: 's1', query: 'SELECT 1' });
  assert.throws(() => parseStatement(msg('P', bytes('s1\x00SELECT 1'))), /Parse/, 'no NUL after the query');
  assert.throws(() => parseStatement(msg('Q', named)), /not Parse/);
});

test('BindPortal', () => {
  // 'B' Bind body: portal name, then the statement name, then formats and values (ignored here).
  const b = bytes('\x00', 's1\x00', [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02], '41', [0x00, 0x00]);
  assert.deepEqual(bindPortal(msg('B', b)), { portal: '', statement: 's1' });
  assert.throws(() => bindPortal(msg('B', bytes('p'))), /Bind/);
});

test('ExecutePortal', () => {
  // 'E' Execute body (frontend, not the backend's ErrorResponse): portal name, then int32 max rows.
  assert.deepEqual(executePortal(msg('E', bytes('\x00', [0x00, 0x00, 0x00, 0x00]))), { portal: '', maxRows: 0 });
  assert.deepEqual(executePortal(msg('E', bytes('p1\x00', [0x00, 0x00, 0x00, 0x0a]))), { portal: 'p1', maxRows: 10 });
  assert.throws(() => executePortal(msg('E', bytes('p1\x00', [0x00]))), /Execute/);
});

test('CloseTarget', () => {
  // 'C' Close body (frontend, not the backend's CommandComplete): 'S' statement or 'P' portal, then its name.
  assert.deepEqual(closeTarget(msg('C', bytes('Ss1\x00'))), { kind: 'S', name: 's1' });
  assert.deepEqual(closeTarget(msg('C', bytes('P\x00'))), { kind: 'P', name: '' });
  assert.throws(() => closeTarget(msg('C', bytes('Xs1\x00'))), /Close/);
});
