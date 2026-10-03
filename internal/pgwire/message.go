// Package pgwire splits a Postgres wire-protocol byte stream into messages.
// It only frames and parses; deciding what to do with a message is the proxy's job.
package pgwire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// maxMessageLen matches Postgres's own limit (just under 1 GiB). A larger
// length means a corrupt stream, so we refuse it instead of allocating.
const maxMessageLen = 1 << 30

// Message is one regular protocol message: a type byte, a 4-byte length, a body.
type Message struct {
	Type byte
	Body []byte // the payload after the length field; a sub-slice of Raw, not a copy
	Raw  []byte // every byte read (type + length + body), forwarded unchanged
}

// ReadMessage reads exactly one regular (typed) message from r. It returns
// io.EOF, unwrapped, only when the stream ends cleanly between messages.
func ReadMessage(r io.Reader) (Message, error) {
	var header [5]byte
	// A socket read can return part of a message; ReadFull keeps reading until
	// the header is complete (io.EOF if nothing came, io.ErrUnexpectedEOF if part did).
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if err == io.EOF {
			return Message{}, io.EOF
		}
		return Message{}, fmt.Errorf("reading message header: %w", err)
	}

	// The length counts its own 4 bytes but not the type byte.
	length := binary.BigEndian.Uint32(header[1:])
	if length < 4 || length > maxMessageLen {
		return Message{}, fmt.Errorf("message %q: invalid length %d", header[0], length)
	}

	raw := make([]byte, 1+length)
	copy(raw, header[:])
	if _, err := io.ReadFull(r, raw[5:]); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF // we already had the header, so this is mid-message
		}
		return Message{}, fmt.Errorf("reading body of message %q: %w", header[0], err)
	}
	return Message{Type: raw[0], Body: raw[5:], Raw: raw}, nil
}
