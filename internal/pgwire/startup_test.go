package pgwire

import (
	"bytes"
	"errors"
	"io"
	"maps"
	"testing"
)

// Captured from psql 18.6 connecting with sslmode=prefer: first an SSLRequest,
// then (after the server answers 'N') this StartupMessage.
var (
	// len 8, code 80877103 = 1234<<16 | 5679.
	capturedSSLRequest = []byte{0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f}

	// len 65, code 196608 = 3<<16 | 0 (protocol 3.0), then name/value pairs,
	// each NUL-terminated, and one final NUL that ends the list.
	capturedStartup = []byte("\x00\x00\x00\x41\x00\x03\x00\x00" +
		"user\x00racehound\x00" +
		"database\x00racehound\x00" +
		"application_name\x00psql\x00" +
		"\x00")
)

func TestReadStartup(t *testing.T) {
	tests := []struct {
		name       string
		input      []byte
		wantCode   uint32
		wantParams map[string]string // nil for packets that carry no parameters
	}{
		{
			name:     "SSLRequest (captured)",
			input:    capturedSSLRequest,
			wantCode: SSLRequestCode,
		},
		{
			name:     "StartupMessage protocol 3.0 (captured)",
			input:    capturedStartup,
			wantCode: ProtocolVersion30,
			wantParams: map[string]string{
				"user": "racehound", "database": "racehound", "application_name": "psql",
			},
		},
		{
			// Same as the captured packet but asking for protocol 3.2 (code 196610).
			// Postgres 18 accepts it; we must too, and let the server negotiate.
			name: "StartupMessage protocol 3.2",
			input: []byte("\x00\x00\x00\x2b\x00\x03\x00\x02" +
				"user\x00racehound\x00database\x00racehound\x00\x00"),
			wantCode:   ProtocolVersion32,
			wantParams: map[string]string{"user": "racehound", "database": "racehound"},
		},
		{
			// len 8, code 80877104 = 1234<<16 | 5680.
			name:     "GSSENCRequest",
			input:    []byte{0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x30},
			wantCode: GSSENCRequestCode,
		},
		{
			// len 16, code 80877102 = 1234<<16 | 5678, PID 4242, 4-byte secret key.
			name:     "CancelRequest",
			input:    []byte{0x00, 0x00, 0x00, 0x10, 0x04, 0xd2, 0x16, 0x2e, 0x00, 0x00, 0x10, 0x92, 0xde, 0xad, 0xbe, 0xef},
			wantCode: CancelRequestCode,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, err := ReadStartup(bytes.NewReader(tt.input))
			if err != nil {
				t.Fatalf("ReadStartup: %v", err)
			}
			if s.Code != tt.wantCode {
				t.Errorf("Code = %d, want %d", s.Code, tt.wantCode)
			}
			if !maps.Equal(s.Params, tt.wantParams) {
				t.Errorf("Params = %v, want %v", s.Params, tt.wantParams)
			}
			if !bytes.Equal(s.Raw, tt.input) {
				t.Errorf("Raw = % x, want % x", s.Raw, tt.input)
			}
		})
	}
}

// psql sends SSLRequest and, after our 'N', the StartupMessage on the same
// connection. Two reads must return them in order.
func TestReadStartupSSLThenStartup(t *testing.T) {
	r := bytes.NewReader(append(append([]byte{}, capturedSSLRequest...), capturedStartup...))

	first, err := ReadStartup(r)
	if err != nil || first.Code != SSLRequestCode {
		t.Fatalf("first = code %d, err %v; want SSLRequest", first.Code, err)
	}
	second, err := ReadStartup(r)
	if err != nil || second.Code != ProtocolVersion30 {
		t.Fatalf("second = code %d, err %v; want protocol 3.0 StartupMessage", second.Code, err)
	}
	if second.Params["database"] != "racehound" {
		t.Errorf("database = %q, want racehound", second.Params["database"])
	}
}

func TestReadStartupErrors(t *testing.T) {
	tests := []struct {
		name    string
		input   []byte
		wantErr error // nil means "any error"
	}{
		{"clean EOF", []byte{}, io.EOF},
		{"truncated length", []byte{0x00, 0x00}, io.ErrUnexpectedEOF},
		{"truncated body", []byte{0x00, 0x00, 0x00, 0x41, 0x00, 0x03}, io.ErrUnexpectedEOF},
		// Every startup packet has at least length + code = 8 bytes.
		{"length below 8", []byte{0x00, 0x00, 0x00, 0x07, 0x00, 0x03, 0x00}, nil},
		// Postgres refuses startup packets over 10000 bytes; so do we, before allocating.
		{"absurd length", []byte{0x00, 0x01, 0x00, 0x00}, nil},
		// Parameter list missing its final NUL.
		{"params not terminated", []byte("\x00\x00\x00\x17\x00\x03\x00\x00user\x00racehound\x00"), nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ReadStartup(bytes.NewReader(tt.input))
			if err == nil {
				t.Fatal("ReadStartup succeeded, want error")
			}
			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Errorf("err = %v, want %v", err, tt.wantErr)
			}
		})
	}
}
