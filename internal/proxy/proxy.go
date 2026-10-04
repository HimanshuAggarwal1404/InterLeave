// Package proxy sits between an app and Postgres and forwards the wire protocol.
// For now it is a pure pass-through: every message is forwarded unchanged.
package proxy

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"

	"racehound/internal/pgwire"
)

// Proxy forwards client connections to one local Postgres server.
type Proxy struct {
	upstream string
}

// New returns a proxy that forwards to upstream ("host:port"). The host must
// be this machine: RaceHound only ever talks to the local Postgres.
func New(upstream string) (*Proxy, error) {
	host, _, err := net.SplitHostPort(upstream)
	if err != nil {
		return nil, fmt.Errorf("upstream %q: %w", upstream, err)
	}
	if !isLoopback(host) {
		return nil, fmt.Errorf("upstream %q: host must be localhost, 127.0.0.1 or ::1", upstream)
	}
	return &Proxy{upstream: upstream}, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Serve accepts connections on ln until ctx is cancelled. Before returning it
// closes ln and every open connection, and waits for all their goroutines to
// exit, so a returned Serve leaves nothing running.
func (p *Proxy) Serve(ctx context.Context, ln net.Listener) error {
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	defer wg.Wait() // runs last: wait for every connection goroutine
	defer cancel()  // runs first: tell every connection to close

	// Closing the listener is the only way to unblock Accept.
	context.AfterFunc(ctx, func() { ln.Close() })

	for {
		client, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil // shut down on purpose
			}
			return fmt.Errorf("accepting connection: %w", err)
		}
		wg.Go(func() { p.handle(ctx, client) })
	}
}

// handle runs one client connection: the startup phase, then two pumps.
func (p *Proxy) handle(ctx context.Context, client net.Conn) {
	defer client.Close()
	// On shutdown, closing the client unblocks whatever read this connection
	// is stuck in; the pumps below then close the server side too.
	stop := context.AfterFunc(ctx, func() { client.Close() })
	defer stop()

	// One buffered reader per connection, used for its whole life: a second
	// reader would lose any bytes the first had already read ahead.
	clientR := bufio.NewReader(client)
	first, err := readStartup(client, clientR)
	if err != nil {
		logUnlessClosed(client, "startup", err)
		return
	}

	var d net.Dialer
	server, err := d.DialContext(ctx, "tcp", p.upstream)
	if err != nil {
		log.Printf("proxy: %s: connecting to Postgres: %v", client.RemoteAddr(), err)
		return
	}
	defer server.Close()
	if _, err := server.Write(first.Raw); err != nil {
		log.Printf("proxy: %s: forwarding startup: %v", client.RemoteAddr(), err)
		return
	}
	if first.Code == pgwire.CancelRequestCode {
		return // a cancel is the only thing sent on its connection; Postgres hangs up after it
	}

	// Two pumps, one per direction. Whichever stops first closes both
	// connections, which makes the other one's blocked read fail and stop too.
	serverR := bufio.NewReader(server)
	closeBoth := func() {
		client.Close()
		server.Close()
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		defer closeBoth()
		logUnlessClosed(client, "app→postgres", forward(server, clientR))
	})
	wg.Go(func() {
		defer closeBoth()
		logUnlessClosed(client, "postgres→app", forward(client, serverR))
	})
	wg.Wait()
}

// readStartup reads startup packets until one is not an encryption request.
// The proxy answers 'N' (no) to SSL and GSS encryption itself, so the client
// carries on in plain text and the proxy can read every message.
func readStartup(client net.Conn, r *bufio.Reader) (pgwire.Startup, error) {
	for {
		s, err := pgwire.ReadStartup(r)
		if err != nil {
			return pgwire.Startup{}, err
		}
		if s.Code != pgwire.SSLRequestCode && s.Code != pgwire.GSSENCRequestCode {
			return s, nil
		}
		if _, err := client.Write([]byte{'N'}); err != nil {
			return pgwire.Startup{}, fmt.Errorf("refusing encryption: %w", err)
		}
	}
}

// forward copies messages from src to dst, byte for byte, until either side
// fails or closes.
//
// Messages that arrived together leave together: they are collected in a
// buffer and sent in one Write, because Postgres sends a whole reply
// (RowDescription, DataRow..., CommandComplete, ReadyForQuery) in one go and
// one Write per message costs a system call and a TCP packet each. The buffer
// is flushed as soon as src holds no further complete message, so forward never
// waits for input while holding bytes it has not sent.
func forward(dst io.Writer, src *bufio.Reader) error {
	w := bufio.NewWriterSize(dst, 64*1024)
	for {
		m, err := pgwire.ReadMessage(src)
		if err != nil {
			return err
		}
		if _, err := w.Write(m.Raw); err != nil {
			return err
		}
		if !hasCompleteMessage(src) {
			if err := w.Flush(); err != nil {
				return err
			}
		}
	}
}

// hasCompleteMessage reports whether r's buffer already holds a whole message,
// so reading it cannot block. Peek within Buffered() never reads from the
// network.
func hasCompleteMessage(r *bufio.Reader) bool {
	n := r.Buffered()
	if n < 5 {
		return false
	}
	header, _ := r.Peek(5)
	length := int64(binary.BigEndian.Uint32(header[1:5])) // includes its own 4 bytes, not the type byte
	return int64(n) >= 1+length
}

// logUnlessClosed logs err unless it is the normal end of a connection: the
// other side hung up (io.EOF) or we closed it ourselves (net.ErrClosed).
func logUnlessClosed(client net.Conn, where string, err error) {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return
	}
	log.Printf("proxy: %s: %s: %v", client.RemoteAddr(), where, err)
}
