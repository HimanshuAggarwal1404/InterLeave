// Shared pieces of the pgwire package: the Message type, the length limit and
// the two kinds of errors a reader can report.

// MAX_MESSAGE_LEN matches Postgres's own limit (just under 1 GiB). A larger
// length means a corrupt stream, so we refuse it instead of buffering it.
export const MAX_MESSAGE_LEN = 2 ** 30;

// Message is one regular protocol message: a type byte, a 4-byte length, a body.
export type Message = {
  type: string; // the type byte as a 1-character string, e.g. 'Q'
  body: Buffer; // the payload after the length field; a view into raw, not a copy
  raw: Buffer; // every byte of the message (type + length + body), forwarded unchanged
};

// ProtocolError means the bytes break the protocol's rules (an impossible
// length, a malformed body). The stream cannot be trusted after it.
export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

// UnexpectedEOFError means the stream ended in the middle of a message: the
// other side went away mid-sentence. (Go: io.ErrUnexpectedEOF.) A stream that
// ends cleanly between messages is not an error; readers return null for it.
export class UnexpectedEOFError extends Error {
  override name = 'UnexpectedEOFError';
}

// quoteByte formats a type byte for error messages the way Go's %q does:
// 'Q' for printable characters, '\x00' for anything else.
export function quoteByte(type: string): string {
  const c = type.charCodeAt(0);
  if (c >= 0x20 && c < 0x7f) {
    return type === "'" || type === '\\' ? `'\\${type}'` : `'${type}'`;
  }
  return `'\\x${c.toString(16).padStart(2, '0')}'`;
}
