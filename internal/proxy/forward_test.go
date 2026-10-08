package proxy

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"testing"
	"time"

	"interleave/internal/pgwire"
)

var (
	// 'C' CommandComplete "SELECT 1".
	commandComplete = append([]byte{'C', 0x00, 0x00, 0x00, 0x0d}, "SELECT 1\x00"...)
	// 'Z' ReadyForQuery, idle.
	readyIdle = []byte{'Z', 0x00, 0x00, 0x00, 0x05, 'I'}
	// 'Z' ReadyForQuery, inside a transaction block.
	readyInTx = []byte{'Z', 0x00, 0x00, 0x00, 0x05, 'T'}
)

// writeRecorder remembers every Write call separately, so a test can see how
// forward grouped the bytes. It sends each one on a channel because forward
// may run in another goroutine.
type writeRecorder chan []byte

func (w writeRecorder) Write(p []byte) (int, error) {
	w <- bytes.Clone(p) // the caller may reuse p after Write returns
	return len(p), nil
}

// When several complete messages arrive together (Postgres sends a whole
// reply in one go), forward must pass them on in one Write, not one per
// message: each Write is a system call and usually its own TCP packet.
func TestForwardBatchesMessagesThatArriveTogether(t *testing.T) {
	burst := concat(commandComplete, readyIdle, commandComplete, readyIdle)
	rec := make(writeRecorder, 10)

	err := forward(rec, bufio.NewReader(bytes.NewReader(burst)), nil, nil)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("forward returned %v, want io.EOF", err)
	}
	close(rec)
	var writes [][]byte
	for w := range rec {
		writes = append(writes, w)
	}
	if len(writes) != 1 || !bytes.Equal(writes[0], burst) {
		t.Errorf("got %d writes %q, want 1 write of the whole burst", len(writes), writes)
	}
}

// forward must never wait for more input while holding bytes it has not sent.
// Here a complete message arrives with only half of the next one: the
// complete one must go out now, before the rest of the second arrives.
func TestForwardSendsCompleteMessageWithoutWaitingForNext(t *testing.T) {
	pr, pw := io.Pipe()
	rec := make(writeRecorder, 10)
	done := make(chan error, 1)
	go func() { done <- forward(rec, bufio.NewReader(pr), nil, nil) }()

	half := len(commandComplete) / 2
	if _, err := pw.Write(concat(readyIdle, commandComplete[:half])); err != nil {
		t.Fatal(err)
	}
	expectWrite(t, rec, readyIdle)

	if _, err := pw.Write(commandComplete[half:]); err != nil {
		t.Fatal(err)
	}
	expectWrite(t, rec, commandComplete)

	pw.Close()
	select {
	case err := <-done:
		if !errors.Is(err, io.EOF) {
			t.Errorf("forward returned %v, want io.EOF", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("forward did not return after its input closed")
	}
}

// inspect may block (the scheduler will park a query there), so forward must
// first send any bytes it is holding back from earlier messages. Here two
// messages arrive together: when inspect sees the second, the first must
// already be written.
func TestForwardSendsHeldBytesBeforeInspect(t *testing.T) {
	rec := make(writeRecorder, 10)
	var inspected []byte
	inspect := func(m pgwire.Message) {
		if m.Type != 'Q' {
			return
		}
		inspected = m.Raw
		select {
		case got := <-rec:
			if !bytes.Equal(got, readyIdle) {
				t.Errorf("before inspecting the query, wrote %q, want %q", got, readyIdle)
			}
		default:
			t.Error("inspect was called while the earlier message was still held back")
		}
	}

	err := forward(rec, bufio.NewReader(bytes.NewReader(concat(readyIdle, query))), inspect, nil)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("forward returned %v, want io.EOF", err)
	}
	if !bytes.Equal(inspected, query) {
		t.Errorf("inspect saw %q, want the query %q", inspected, query)
	}
	expectWrite(t, rec, query)
}

// sentReady tells the scheduler a step finished, and the scheduler may then
// take a while, so it must only run once the ReadyForQuery has reached the app:
// nothing may be held back while it runs. A reply is still sent in one Write,
// because ReadyForQuery is the last message of a reply anyway.
func TestForwardReportsReadyAfterSendingIt(t *testing.T) {
	rec := make(writeRecorder, 10)
	var statuses []byte
	sentReady := func(m pgwire.Message) {
		statuses = append(statuses, m.Body[0])
		select {
		case got := <-rec:
			want := concat(commandComplete, m.Raw)
			if !bytes.Equal(got, want) {
				t.Errorf("before reporting %q, wrote %q, want the whole reply %q", m.Raw, got, want)
			}
		default:
			t.Errorf("sentReady(%q) was called while the message was still held back", m.Raw)
		}
	}

	// Two replies that arrived together.
	burst := concat(commandComplete, readyInTx, commandComplete, readyIdle)
	err := forward(rec, bufio.NewReader(bytes.NewReader(burst)), nil, sentReady)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("forward returned %v, want io.EOF", err)
	}
	if string(statuses) != "TI" {
		t.Errorf("sentReady saw statuses %q, want %q", statuses, "TI")
	}
}

func expectWrite(t *testing.T, rec writeRecorder, want []byte) {
	t.Helper()
	select {
	case got := <-rec:
		if !bytes.Equal(got, want) {
			t.Errorf("wrote %q, want %q", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("nothing written; want %q", want)
	}
}

func concat(parts ...[]byte) []byte {
	return bytes.Join(parts, nil)
}
