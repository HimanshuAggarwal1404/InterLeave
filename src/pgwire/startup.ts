import { ProtocolError } from './message.ts';

// Startup packet codes (the 4 bytes after the length).
export const PROTOCOL_VERSION_30 = (3 << 16) | 0; // 196608
export const PROTOCOL_VERSION_32 = (3 << 16) | 2; // 196610, new in Postgres 18
export const CANCEL_REQUEST_CODE = (1234 << 16) | 5678; // 80877102
export const SSL_REQUEST_CODE = (1234 << 16) | 5679; // 80877103
export const GSSENC_REQUEST_CODE = (1234 << 16) | 5680; // 80877104

// MAX_STARTUP_LEN matches Postgres, which refuses startup packets over 10000 bytes.
export const MAX_STARTUP_LEN = 10000;

// Startup is the first packet a client sends. It has no type byte.
export type Startup = {
  code: number;
  // Name/value pairs; only for protocol 3.x StartupMessages. A Map, not a plain
  // object: names come from the network, and a name like "__proto__" must not
  // be able to touch an object's prototype.
  params: Map<string, string> | undefined;
  raw: Buffer; // every byte of the packet, forwarded unchanged
};

// parseParams decodes "name\0value\0name\0value\0\0": NUL-terminated pairs,
// ended by an empty name (the final NUL).
export function parseParams(b: Buffer): Map<string, string> {
  const params = new Map<string, string>();
  let rest = b;
  for (;;) {
    const nameEnd = rest.indexOf(0);
    if (nameEnd < 0) {
      throw new ProtocolError('parameter list not terminated');
    }
    if (nameEnd === 0) {
      if (rest.length !== 1) {
        throw new ProtocolError('bytes after parameter list');
      }
      return params;
    }
    const name = rest.toString('utf8', 0, nameEnd);
    rest = rest.subarray(nameEnd + 1);
    const valueEnd = rest.indexOf(0);
    if (valueEnd < 0) {
      throw new ProtocolError(`parameter ${JSON.stringify(name)} has no value`);
    }
    params.set(name, rest.toString('utf8', 0, valueEnd));
    rest = rest.subarray(valueEnd + 1);
  }
}
