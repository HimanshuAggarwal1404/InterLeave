package pgwire

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestReadMessage(t *testing.T) {
	tests := []struct {
		name     string
		input    []byte
		wantType byte
		wantBody []byte
	}{
		{
			// Captured from Postgres 18.6 after psql's StartupMessage:
			// 'R' AuthenticationSASL, len 23, code 10, mechanism "SCRAM-SHA-256", list end.
			name: "AuthenticationSASL (captured)",
			input: []byte{
				'R', 0x00, 0x00, 0x00, 0x17,
				0x00, 0x00, 0x00, 0x0a,
				'S', 'C', 'R', 'A', 'M', '-', 'S', 'H', 'A', '-', '2', '5', '6', 0x00,
				0x00,
			},
			wantType: 'R',
			wantBody: []byte("\x00\x00\x00\x0aSCRAM-SHA-256\x00\x00"),
		},
		{
			// 'Z' ReadyForQuery, len 5, status 'I' (idle, not in a transaction).
			name:     "ReadyForQuery idle",
			input:    []byte{'Z', 0x00, 0x00, 0x00, 0x05, 'I'},
			wantType: 'Z',
			wantBody: []byte{'I'},
		},
		{
			// 'Q' Query "SELECT 1", len 4 + 9 = 13 (the SQL ends with a NUL byte).
			name:     "Query",
			input:    append([]byte{'Q', 0x00, 0x00, 0x00, 0x0d}, "SELECT 1\x00"...),
			wantType: 'Q',
			wantBody: []byte("SELECT 1\x00"),
		},
		{
			// 'X' Terminate, len 4: the length counts only itself, so the body is empty.
			name:     "Terminate (empty body)",
			input:    []byte{'X', 0x00, 0x00, 0x00, 0x04},
			wantType: 'X',
			wantBody: []byte{},
		},
		{
			// 'K' BackendKeyData, protocol 3.0: len 12, PID 4242, 4-byte secret key.
			name:     "BackendKeyData protocol 3.0",
			input:    []byte{'K', 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef},
			wantType: 'K',
			wantBody: []byte{0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef},
		},
		{
			// 'K' BackendKeyData, protocol 3.2: len 8 + 32, PID 4242, 32-byte secret key.
			// Same message type, different size: why we never assume fixed sizes.
			name:     "BackendKeyData protocol 3.2 (long key)",
			input:    append([]byte{'K', 0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x10, 0x92}, bytes.Repeat([]byte{0xab}, 32)...),
			wantType: 'K',
			wantBody: append([]byte{0x00, 0x00, 0x10, 0x92}, bytes.Repeat([]byte{0xab}, 32)...),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := ReadMessage(bytes.NewReader(tt.input))
			if err != nil {
				t.Fatalf("ReadMessage: %v", err)
			}
			if m.Type != tt.wantType {
				t.Errorf("Type = %q, want %q", m.Type, tt.wantType)
			}
			if !bytes.Equal(m.Body, tt.wantBody) {
				t.Errorf("Body = % x, want % x", m.Body, tt.wantBody)
			}
			// Raw must be exactly the bytes we read, so the proxy can forward them unchanged.
			if !bytes.Equal(m.Raw, tt.input) {
				t.Errorf("Raw = % x, want % x", m.Raw, tt.input)
			}
		})
	}
}

// TCP has no message boundaries: two messages arrive as one stream of bytes.
// Reading twice must split them exactly where the length field says.
func TestReadMessageBackToBack(t *testing.T) {
	stream := []byte{
		'C', 0x00, 0x00, 0x00, 0x0d, 'U', 'P', 'D', 'A', 'T', 'E', ' ', '1', 0x00, // CommandComplete "UPDATE 1"
		'Z', 0x00, 0x00, 0x00, 0x05, 'T', // ReadyForQuery, in a transaction
	}
	r := bytes.NewReader(stream)

	first, err := ReadMessage(r)
	if err != nil {
		t.Fatalf("first message: %v", err)
	}
	if first.Type != 'C' || string(first.Body) != "UPDATE 1\x00" {
		t.Errorf("first = %q %q, want 'C' \"UPDATE 1\\x00\"", first.Type, first.Body)
	}

	second, err := ReadMessage(r)
	if err != nil {
		t.Fatalf("second message: %v", err)
	}
	if second.Type != 'Z' || string(second.Body) != "T" {
		t.Errorf("second = %q %q, want 'Z' \"T\"", second.Type, second.Body)
	}

	if _, err := ReadMessage(r); !errors.Is(err, io.EOF) {
		t.Errorf("after last message: err = %v, want io.EOF", err)
	}
}

func TestReadMessageErrors(t *testing.T) {
	tests := []struct {
		name    string
		input   []byte
		wantErr error // nil means "any error"
	}{
		// Nothing at all: the other side closed the connection cleanly between messages.
		{"clean EOF", []byte{}, io.EOF},
		// Cut off inside the 5-byte header or inside the body: the connection died mid-message.
		{"truncated header", []byte{'Z', 0x00, 0x00}, io.ErrUnexpectedEOF},
		{"truncated body", []byte{'Q', 0x00, 0x00, 0x00, 0x0d, 'S', 'E', 'L'}, io.ErrUnexpectedEOF},
		// The length includes its own 4 bytes, so anything below 4 is corrupt.
		{"length below 4", []byte{'Z', 0x00, 0x00, 0x00, 0x03}, nil},
		// 0x7fffffff (about 2 GB): must be rejected before trying to allocate it.
		{"absurd length", []byte{'D', 0x7f, 0xff, 0xff, 0xff}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ReadMessage(bytes.NewReader(tt.input))
			if err == nil {
				t.Fatal("ReadMessage succeeded, want error")
			}
			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Errorf("err = %v, want %v", err, tt.wantErr)
			}
		})
	}
}
