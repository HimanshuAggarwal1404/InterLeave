package pgwire

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Startup packet codes (the 4 bytes after the length).
const (
	ProtocolVersion30 uint32 = 3<<16 | 0
	ProtocolVersion32 uint32 = 3<<16 | 2
	CancelRequestCode uint32 = 1234<<16 | 5678
	SSLRequestCode    uint32 = 1234<<16 | 5679
	GSSENCRequestCode uint32 = 1234<<16 | 5680
)

// maxStartupLen matches Postgres, which refuses startup packets over 10000 bytes.
const maxStartupLen = 10000

// Startup is the first packet a client sends. It has no type byte.
type Startup struct {
	Code   uint32
	Params map[string]string // name/value pairs; only for protocol 3.x StartupMessages
	Raw    []byte            // every byte read, forwarded unchanged
}

// ReadStartup reads one startup packet from r. Unknown codes are not an error:
// the proxy forwards them and lets Postgres decide. It returns io.EOF,
// unwrapped, only when the stream ends before the packet starts.
func ReadStartup(r io.Reader) (Startup, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		if err == io.EOF {
			return Startup{}, io.EOF
		}
		return Startup{}, fmt.Errorf("reading startup length: %w", err)
	}

	// Here the length counts everything, including itself (there is no type byte).
	length := binary.BigEndian.Uint32(lenBuf[:])
	if length < 8 || length > maxStartupLen {
		return Startup{}, fmt.Errorf("startup packet: invalid length %d", length)
	}

	raw := make([]byte, length)
	copy(raw, lenBuf[:])
	if _, err := io.ReadFull(r, raw[4:]); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return Startup{}, fmt.Errorf("reading startup packet: %w", err)
	}

	s := Startup{Code: binary.BigEndian.Uint32(raw[4:8]), Raw: raw}
	// Major version 3 (3.0 and 3.2 alike) is a StartupMessage with parameters.
	if s.Code>>16 == 3 {
		params, err := parseParams(raw[8:])
		if err != nil {
			return Startup{}, fmt.Errorf("startup packet: %w", err)
		}
		s.Params = params
	}
	return s, nil
}

// parseParams decodes "name\0value\0name\0value\0\0": NUL-terminated pairs,
// ended by an empty name (the final NUL).
func parseParams(b []byte) (map[string]string, error) {
	params := map[string]string{}
	for {
		name, rest, found := bytes.Cut(b, []byte{0})
		if !found {
			return nil, errors.New("parameter list not terminated")
		}
		if len(name) == 0 {
			if len(rest) != 0 {
				return nil, errors.New("bytes after parameter list")
			}
			return params, nil
		}
		value, rest, found := bytes.Cut(rest, []byte{0})
		if !found {
			return nil, fmt.Errorf("parameter %q has no value", name)
		}
		params[string(name)] = string(value)
		b = rest
	}
}
