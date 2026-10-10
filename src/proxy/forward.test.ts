import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { WireReader, type Message } from '../pgwire/index.ts';
import { forward } from './forward.ts';
import { commandComplete, query, readyIdle, readyInTx, withTimeout } from './testutil.ts';
import { bytes, chunksOf, hex } from '../testutil/bytes.ts';

// WriteRecorder is a real Writable that remembers every write separately, so a
// test can see how forward grouped the bytes. next() returns the oldest write
// not yet taken, waiting up to 5 s for one.
class WriteRecorder extends Writable {
  #unread: Buffer[] = [];
  #wake: (() => void) | undefined;

  constructor(options: { highWaterMark?: number } = {}) {
    super({
      highWaterMark: options.highWaterMark,
      write: (chunk: Buffer, _encoding, callback) => {
        this.#unread.push(Buffer.from(chunk)); // a copy: the caller may reuse its buffer
        this.#wake?.();
        callback();
      },
    });
  }

  // taken returns, and forgets, every write not yet taken.
  taken(): Buffer[] {
    return this.#unread.splice(0);
  }

  async next(): Promise<Buffer> {
    if (this.#unread.length === 0) {
      await withTimeout(new Promise<void>((r) => (this.#wake = r)), 'nothing written within 5s');
      this.#wake = undefined;
    }
    return this.#unread.shift() as Buffer;
  }
}

// When several complete messages arrive together (Postgres sends a whole
// reply in one go), forward must pass them on in one write, not one per
// message: each write is a system call and usually its own TCP packet.
test('ForwardBatchesMessagesThatArriveTogether', async () => {
  const burst = bytes(commandComplete, readyIdle, commandComplete, readyIdle);
  const rec = new WriteRecorder();
  await forward(new WireReader(chunksOf(burst)), rec);
  const writes = rec.taken();
  assert.equal(writes.length, 1, `got ${writes.length} writes, want 1 write of the whole burst`);
  assert.equal(hex(writes[0]), hex(burst));
});

// forward must never wait for more input while holding bytes it has not sent.
// Here a complete message arrives with only half of the next one: the
// complete one must go out now, before the rest of the second arrives.
test('ForwardSendsCompleteMessageWithoutWaitingForNext', async () => {
  const src = new PassThrough();
  const rec = new WriteRecorder();
  const done = forward(new WireReader(src), rec);

  const half = Math.floor(commandComplete.length / 2);
  src.write(bytes(readyIdle, commandComplete.subarray(0, half)));
  assert.equal(hex(await rec.next()), hex(readyIdle));

  src.write(commandComplete.subarray(half));
  assert.equal(hex(await rec.next()), hex(commandComplete));

  src.end();
  await withTimeout(done, 'forward did not return after its input closed');
});

// inspect may wait (the scheduler parks a query there), so forward must first
// send any bytes it is holding back from earlier messages. Here two messages
// arrive together: when inspect sees the second, the first must already be written.
test('ForwardSendsHeldBytesBeforeInspect', async () => {
  const rec = new WriteRecorder();
  let inspected: Buffer | undefined;
  const inspect = (m: Message) => {
    if (m.type !== 'Q') {
      return;
    }
    inspected = m.raw;
    const before = rec.taken();
    assert.equal(before.length, 1, 'inspect was called while the earlier message was still held back');
    assert.equal(hex(before[0]), hex(readyIdle));
  };

  await forward(new WireReader(chunksOf(bytes(readyIdle, query))), rec, { inspect });
  assert.ok(inspected, 'inspect never saw the query');
  assert.equal(hex(inspected), hex(query));
  assert.equal(hex(await rec.next()), hex(query));
});

// sentReady tells the scheduler a step finished, and the scheduler may then
// take a while, so it must only run once the ReadyForQuery has reached the app:
// nothing may be held back while it runs. A reply is still sent in one write,
// because ReadyForQuery is the last message of a reply anyway.
test('ForwardReportsReadyAfterSendingIt', async () => {
  const rec = new WriteRecorder();
  const statuses: string[] = [];
  const sentReady = (m: Message) => {
    statuses.push(m.body.toString('latin1'));
    const before = rec.taken();
    assert.equal(before.length, 1, `sentReady(${hex(m.raw)}) was called while the message was still held back`);
    assert.equal(hex(before[0]), hex(bytes(commandComplete, m.raw)), 'want the whole reply in one write');
  };

  // Two replies that arrived together.
  const burst = bytes(commandComplete, readyInTx, commandComplete, readyIdle);
  await forward(new WireReader(chunksOf(burst)), rec, { sentReady });
  assert.deepEqual(statuses, ['T', 'I']);
});

// When the destination is slow (write returns false), forward must wait for
// 'drain' before writing more, so the proxy never buffers without limit, and
// no byte may be lost on the way.
test('ForwardWaitsForDrain', async () => {
  // release holds the callback of the write in progress; finishWrite calls it.
  let release: (() => void) | undefined;
  const finishWrite = () => {
    const r = release;
    release = undefined;
    r?.();
  };
  const written: Buffer[] = [];
  // A destination that accepts one write and then holds its callback until
  // the test calls release(): like a socket whose kernel buffer is full.
  const slow = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      written.push(Buffer.from(chunk));
      release = callback;
    },
  });
  const src = new PassThrough();
  const done = forward(new WireReader(src), slow);

  src.write(readyIdle);
  await withTimeout(waitUntil(() => release !== undefined), 'first message was never written');
  src.write(commandComplete);
  // Give forward plenty of chances to (wrongly) write the second message.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(slow.writableLength, readyIdle.length, 'forward wrote more while the destination was full');

  finishWrite(); // the first write completes: 'drain' fires, forward goes on
  await withTimeout(waitUntil(() => release !== undefined), 'second message was never written after drain');
  finishWrite(); // complete the second write too
  src.end();
  await withTimeout(done, 'forward did not finish');
  assert.equal(hex(Buffer.concat(written)), hex(bytes(readyIdle, commandComplete)), 'bytes lost or reordered');
});

async function waitUntil(cond: () => boolean): Promise<void> {
  while (!cond()) {
    await new Promise((r) => setImmediate(r));
  }
}
