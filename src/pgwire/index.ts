// Package pgwire splits a Postgres wire-protocol byte stream into messages.
// It only frames and parses; deciding what to do with a message is the proxy's job.
// It has no sockets of its own: WireReader reads from any async source of chunks.
export { MAX_MESSAGE_LEN, ProtocolError, UnexpectedEOFError, quoteByte, type Message } from './message.ts';
export {
  CANCEL_REQUEST_CODE,
  GSSENC_REQUEST_CODE,
  MAX_STARTUP_LEN,
  PROTOCOL_VERSION_30,
  PROTOCOL_VERSION_32,
  SSL_REQUEST_CODE,
  type Startup,
} from './startup.ts';
export { WireReader } from './reader.ts';
export { queryString } from './query.ts';
export { readyStatus, type ReadyStatus } from './ready.ts';
