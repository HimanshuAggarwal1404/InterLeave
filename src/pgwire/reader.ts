import { MAX_MESSAGE_LEN, ProtocolError, UnexpectedEOFError, quoteByte, type Message } from './message.ts';
import { MAX_STARTUP_LEN, parseParams, type Startup } from './startup.ts';

// WireReader cuts a stream of byte chunks into protocol messages.
//
// A socket delivers bytes in chunks of any size: half a message, or three and
// a half. WireReader keeps the chunks it has received but not yet handed out,
// and returns only whole messages. Use one WireReader per connection for its
// whole life: bytes that arrived after the startup packet are already in its
// buffer, and a second reader would never see them.
//
// It pulls chunks through the async iterator itself (it.next()) and never uses
// `for await ... break`, because breaking out of a for-await loop over a
// socket destroys the socket.
export class WireReader {
  #it: AsyncIterator<Buffer>;
  #chunks: Buffer[] = []; // received, not yet handed out, oldest first
  #buffered = 0; // total bytes in #chunks
  #ended = false; // the source has no more chunks

  constructor(chunks: AsyncIterable<Buffer>) {
    this.#it = chunks[Symbol.asyncIterator]();
  }

  // readMessage returns the next regular (typed) message, or null when the
  // stream ends cleanly between messages. It throws UnexpectedEOFError if the
  // stream ends mid-message, and ProtocolError for an impossible length.
  async readMessage(): Promise<Message | null> {
    if (!(await this.#fill(5))) {
      if (this.#buffered === 0) {
        return null;
      }
      throw new UnexpectedEOFError('reading message header: unexpected EOF');
    }
    const header = this.#peek(5);
    const type = String.fromCharCode(header[0]);
    // The length counts its own 4 bytes but not the type byte. It is checked
    // before waiting for the body, so a corrupt length is refused at once.
    const length = header.readUInt32BE(1);
    if (length < 4 || length > MAX_MESSAGE_LEN) {
      throw new ProtocolError(`message ${quoteByte(type)}: invalid length ${length}`);
    }
    if (!(await this.#fill(1 + length))) {
      throw new UnexpectedEOFError(`reading body of message ${quoteByte(type)}: unexpected EOF`);
    }
    const raw = this.#take(1 + length);
    return { type, body: raw.subarray(5), raw };
  }

  // readStartup returns the next startup packet, or null when the stream ends
  // before one starts. Unknown codes are not an error: the proxy forwards them
  // and lets Postgres decide.
  async readStartup(): Promise<Startup | null> {
    if (!(await this.#fill(4))) {
      if (this.#buffered === 0) {
        return null;
      }
      throw new UnexpectedEOFError('reading startup length: unexpected EOF');
    }
    // Here the length counts everything, including itself (there is no type byte).
    const length = this.#peek(4).readUInt32BE(0);
    if (length < 8 || length > MAX_STARTUP_LEN) {
      throw new ProtocolError(`startup packet: invalid length ${length}`);
    }
    if (!(await this.#fill(length))) {
      throw new UnexpectedEOFError('reading startup packet: unexpected EOF');
    }
    const raw = this.#take(length);
    const code = raw.readUInt32BE(4);
    let params: Map<string, string> | undefined;
    // Major version 3 (3.0 and 3.2 alike) is a StartupMessage with parameters.
    // >>> is an unsigned shift: the code is a uint32, and >> would make large codes negative.
    if (code >>> 16 === 3) {
      try {
        params = parseParams(raw.subarray(8));
      } catch (err) {
        throw new ProtocolError(`startup packet: ${(err as Error).message}`, { cause: err });
      }
    }
    return { code, params, raw };
  }

  // hasCompleteMessage reports whether a whole regular message is already
  // buffered, so reading it cannot wait for the network. It never reads.
  hasCompleteMessage(): boolean {
    if (this.#buffered < 5) {
      return false;
    }
    const length = this.#peek(5).readUInt32BE(1); // includes its own 4 bytes, not the type byte
    return this.#buffered >= 1 + length;
  }

  // #fill waits for chunks until at least n bytes are buffered. It returns
  // false if the source ended first.
  async #fill(n: number): Promise<boolean> {
    while (this.#buffered < n && !this.#ended) {
      const next = await this.#it.next();
      if (next.done) {
        this.#ended = true;
      } else if (next.value.length > 0) {
        this.#chunks.push(next.value);
        this.#buffered += next.value.length;
      }
    }
    return this.#buffered >= n;
  }

  // #peek returns the first n buffered bytes without consuming them. Only the
  // first chunks are joined, and only when the n bytes span more than one.
  #peek(n: number): Buffer {
    const first = this.#chunks[0];
    if (first.length >= n) {
      return first.subarray(0, n);
    }
    return Buffer.concat(this.#chunks, n);
  }

  // #take removes and returns the first n buffered bytes. When they lie inside
  // one chunk, the result is a view into it (no copy). Chunks are joined only
  // once a whole message has arrived, so a large message split into many
  // chunks is copied once, not once per chunk.
  #take(n: number): Buffer {
    this.#buffered -= n;
    const first = this.#chunks[0];
    if (first.length >= n) {
      if (first.length === n) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = first.subarray(n);
      }
      return first.subarray(0, n);
    }
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const c = this.#chunks[0];
      if (c.length <= need) {
        parts.push(c);
        need -= c.length;
        this.#chunks.shift();
      } else {
        parts.push(c.subarray(0, need));
        this.#chunks[0] = c.subarray(need);
        need = 0;
      }
    }
    return Buffer.concat(parts, n);
  }
}
