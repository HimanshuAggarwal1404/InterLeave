package pgwire

import "fmt"

// ReadyStatus returns the status byte of a 'Z' (ReadyForQuery) message, which
// Postgres sends when it has finished a query and waits for the next one:
// 'I' idle, 'T' inside a transaction block, 'E' inside a failed transaction block.
func ReadyStatus(m Message) (byte, error) {
	if m.Type != 'Z' {
		return 0, fmt.Errorf("message %q is not ReadyForQuery", m.Type)
	}
	if len(m.Body) != 1 {
		return 0, fmt.Errorf("ReadyForQuery: body is %d bytes, want 1", len(m.Body))
	}
	switch s := m.Body[0]; s {
	case 'I', 'T', 'E':
		return s, nil
	default:
		return 0, fmt.Errorf("ReadyForQuery: unknown status %q", s)
	}
}
