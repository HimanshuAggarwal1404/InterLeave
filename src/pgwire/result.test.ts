import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendKeyData, commandTag, errorFields, firstColumn, type Message } from './index.ts';
import { bytes } from '../testutil/bytes.ts';

function msg(type: string, body: Buffer): Message {
  return { type, body, raw: body };
}

test('CommandTag', () => {
  // 'C' CommandComplete body: the command tag as a NUL-terminated string.
  assert.equal(commandTag(msg('C', bytes('UPDATE 1\x00'))), 'UPDATE 1');
  assert.equal(commandTag(msg('C', bytes('SELECT 0\x00'))), 'SELECT 0');
  assert.throws(() => commandTag(msg('Z', bytes('I'))), /not CommandComplete/);
  assert.throws(() => commandTag(msg('C', bytes('UPDATE 1'))), /NUL/);
});

test('FirstColumn', () => {
  // 'D' DataRow body: int16 column count, then per column int32 length
  // (-1 = NULL) and that many bytes.
  const oneCol = bytes([0x00, 0x01, 0x00, 0x00, 0x00, 0x02], '42');
  assert.equal(firstColumn(msg('D', oneCol)), '42');
  const twoCols = bytes([0x00, 0x02, 0x00, 0x00, 0x00, 0x01], '0', [0x00, 0x00, 0x00, 0x01], '1');
  assert.equal(firstColumn(msg('D', twoCols)), '0', 'only the first column');
  const nullCol = bytes([0x00, 0x01, 0xff, 0xff, 0xff, 0xff]);
  assert.equal(firstColumn(msg('D', nullCol)), null, 'length -1 means NULL');
  assert.equal(firstColumn(msg('D', bytes([0x00, 0x00]))), undefined, 'a row with no columns');
  assert.throws(() => firstColumn(msg('D', bytes([0x00, 0x01, 0x00, 0x00, 0x00, 0x05], 'ab'))), /DataRow/);
});

test('ErrorFields', () => {
  // 'E' ErrorResponse body: (field type byte, NUL-terminated value)*, then a 0 byte.
  // S = severity, V = severity (not localized), C = SQLSTATE code, M = message.
  const deadlock = bytes(
    'SERROR\x00',
    'VERROR\x00',
    'C40P01\x00',
    'Mdeadlock detected\x00',
    [0x00],
  );
  assert.deepEqual(errorFields(msg('E', deadlock)), { code: '40P01', message: 'deadlock detected' });
  assert.throws(() => errorFields(msg('E', bytes('C40P01\x00'))), /not terminated/);
  assert.throws(() => errorFields(msg('Q', bytes([0x00]))), /not ErrorResponse/);
});

test('BackendKeyData', () => {
  // 'K' BackendKeyData body: int32 backend process ID, then the secret key for
  // cancel requests: 4 bytes in protocol 3.0, variable length (up to 256) in 3.2.
  const v30 = bytes([0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(backendKeyData(msg('K', v30)), { pid: 4242, secretKey: Buffer.from([0xde, 0xad, 0xbe, 0xef]) });
  const v32 = bytes([0x00, 0x00, 0x10, 0x92], Buffer.alloc(32, 0xab));
  assert.deepEqual(backendKeyData(msg('K', v32)), { pid: 4242, secretKey: Buffer.alloc(32, 0xab) });
  assert.throws(() => backendKeyData(msg('Z', bytes('I'))), /not BackendKeyData/);
  assert.throws(() => backendKeyData(msg('K', bytes([0x00, 0x00, 0x10, 0x92]))), /BackendKeyData/, 'no secret key');
  assert.throws(() => backendKeyData(msg('K', bytes([0x00, 0x00, 0x10, 0x92], Buffer.alloc(257)))), /BackendKeyData/, 'key over 256 bytes');
});
