import { once } from 'node:events';
import type { Writable } from 'node:stream';
import type { Message, WireReader } from '../pgwire/index.ts';

export type ForwardHooks = {
  // inspect sees every message before it is forwarded. It may wait (a parked
  // query waits there); forward does not read on until it returns.
  inspect?: (m: Message) => Promise<void> | void;
  // sentReady sees every ReadyForQuery ('Z') once it has been written to dst.
  sentReady?: (m: Message) => void;
  // signal stops forward while it waits (for inspect or for 'drain').
  signal?: AbortSignal;
};

// forward copies messages from src to dst, byte for byte, until src ends
// (it resolves) or something fails (it rejects).
//
// Messages that arrived together leave together: they are collected in held
// and sent with one write, because Postgres sends a whole reply
// (RowDescription, DataRow..., CommandComplete, ReadyForQuery) in one go and
// one write per message costs a system call and a TCP packet each (D-014).
// held is written as soon as src has no further complete message buffered,
// so forward never waits for input while holding bytes it has not sent.
//
// By the same rule, anything held is written before inspect is called
// (inspect may wait for a long time), and a ReadyForQuery is written before
// sentReady is called. That costs no extra write in practice: ReadyForQuery
// is the last message of a reply.
export async function forward(src: WireReader, dst: Writable, hooks: ForwardHooks = {}): Promise<void> {
  const { inspect, sentReady, signal } = hooks;
  const held: Buffer[] = [];
  for (;;) {
    const m = await src.readMessage();
    if (m === null) {
      return; // clean end of stream; held is empty, see the flush rule below
    }
    if (inspect !== undefined) {
      await flush(dst, held, signal);
      await inspect(m);
      // While inspect waited, the connection may have been torn down: then
      // stop here rather than forward a query nobody released.
      signal?.throwIfAborted();
    }
    held.push(m.raw);
    const report = sentReady !== undefined && m.type === 'Z';
    if (report || !src.hasCompleteMessage()) {
      await flush(dst, held, signal);
    }
    if (report) {
      sentReady(m);
    }
  }
}

// flush writes everything held in one write and empties held. If the
// destination's buffer is full (write returns false), it waits for 'drain'
// before returning, so a slow reader slows us down instead of making us
// buffer without limit (backpressure).
async function flush(dst: Writable, held: Buffer[], signal: AbortSignal | undefined): Promise<void> {
  if (held.length === 0) {
    return;
  }
  const chunk = held.length === 1 ? held[0] : Buffer.concat(held);
  held.length = 0;
  if (!dst.write(chunk)) {
    await once(dst, 'drain', { signal });
  }
}
