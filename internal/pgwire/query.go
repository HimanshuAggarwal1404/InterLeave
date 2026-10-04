package pgwire

import (
	"bytes"
	"errors"
	"fmt"
)

// QueryString returns the SQL text of a 'Q' (simple Query) message. The body
// is the text followed by exactly one NUL byte, as in a C string.
func QueryString(m Message) (string, error) {
	if m.Type != 'Q' {
		return "", fmt.Errorf("message %q is not a Query", m.Type)
	}
	end := bytes.IndexByte(m.Body, 0)
	if len(m.Body) == 0 || end != len(m.Body)-1 {
		return "", errors.New("query: SQL text must end with the message's only NUL byte")
	}
	return string(m.Body[:end]), nil
}
